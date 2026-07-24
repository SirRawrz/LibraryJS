#include <WiFi.h>
#include <FS.h>
#include <SD_MMC.h>
#include <lwip/sockets.h>      // For TCP window manipulation
#include <esp_heap_caps.h>     // For PSRAM allocation

// ---------------------------------------------------------------------------
//  Configuration – PSRAM‑aware defaults
// ---------------------------------------------------------------------------
#define MAX_CLIENTS       8

// Detect PSRAM at compile time (BOARD_HAS_PSRAM is defined by ESP32 core if PSRAM is enabled)
#ifdef BOARD_HAS_PSRAM
  // If PSRAM is present, use large buffers
  #define BUFFER_SIZE        (256 * 1024)   // 256 KB
  #define TCP_WINDOW_SIZE    (128 * 1024)   // 128 KB
  #define MAX_OPEN_FILES     12
#else
  #define BUFFER_SIZE        (32 * 1024)    // 32 KB for internal SRAM
  #define TCP_WINDOW_SIZE    (64 * 1024)
  #define MAX_OPEN_FILES     6
#endif

#define IDLE_TIMEOUT_MS   60000     // 60 seconds for large files

WiFiServer httpServer(80);
WiFiServer uploadServer(81);

String wifiSSID;
String wifiPassword;

// For SoftAP fallback
String apSSID;
String apPassword;

// ---------------------------------------------------------------------------
//  Socket buffer booster (runtime TCP window enlargement)
// ---------------------------------------------------------------------------
void setSocketBufferSize(WiFiClient &client, int size) {
  if (!client) return;
  int sock = client.fd();
  if (sock < 0) return;

  int rcvbuf = size;
  setsockopt(sock, SOL_SOCKET, SO_RCVBUF, &rcvbuf, sizeof(rcvbuf));
  int sndbuf = size;
  setsockopt(sock, SOL_SOCKET, SO_SNDBUF, &sndbuf, sizeof(sndbuf));
}

// ---------------------------------------------------------------------------
//  File descriptor limiter with wait queue
// ---------------------------------------------------------------------------
int openFiles = 0;
int waitingClients[MAX_CLIENTS];
int waitQueueHead = 0;
int waitQueueTail = 0;

bool enqueueWaiting(int idx) {
  int nextTail = (waitQueueTail + 1) % MAX_CLIENTS;
  if (nextTail == waitQueueHead) return false;
  waitingClients[waitQueueTail] = idx;
  waitQueueTail = nextTail;
  return true;
}

int dequeueWaiting() {
  if (waitQueueHead == waitQueueTail) return -1;
  int idx = waitingClients[waitQueueHead];
  waitQueueHead = (waitQueueHead + 1) % MAX_CLIENTS;
  return idx;
}

// ---------------------------------------------------------------------------
//  Connection state machine
// ---------------------------------------------------------------------------
enum ConnState : uint8_t {
  IDLE,
  READING_HEADERS,
  PROCESSING,
  WAITING_FOR_FILE,
  SENDING_HEADERS,
  SENDING_BODY,
  RECEIVING_BODY,
  CLOSING
};

struct ClientContext {
  WiFiClient client;
  ConnState  state = IDLE;
  bool       isUpload = false;

  String     requestLine;
  String     headers;
  bool       headersComplete = false;
  String     method;
  String     path;
  String     query;
  size_t     contentLength = 0;
  size_t     bodyReceived  = 0;
  size_t     bufferPos     = 0;

  File       file;
  bool       fileOpen = false;
  uint64_t   fileSize = 0;
  uint64_t   filePos  = 0;
  uint64_t   bytesRemaining = 0;
  bool       isRange = false;
  uint64_t   rangeStart = 0;
  uint64_t   rangeEnd   = 0;
  int        responseCode = 200;
  String     responseHeaders;

  uint8_t*   buffer = nullptr;
  unsigned long lastActivity = 0;
  unsigned long waitStart = 0;

  size_t     bytesToSend = 0;
  size_t     sendOffset = 0;
};

ClientContext clients[MAX_CLIENTS];

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------
int findFreeSlot() {
  for (int i = 0; i < MAX_CLIENTS; i++)
    if (clients[i].state == IDLE && !clients[i].client) return i;
  return -1;
}

void closeClient(int idx) {
  ClientContext &c = clients[idx];
  if (c.fileOpen) {
    c.file.close();
    c.file = File();
    c.fileOpen = false;
    openFiles--;
    int w = dequeueWaiting();
    if (w >= 0) {
      clients[w].state = PROCESSING;
    }
  }
  if (c.buffer) {
    free(c.buffer);
    c.buffer = nullptr;
  }
  c.client.stop();
  c = ClientContext();
  c.state = IDLE;
}

// ---------------------------------------------------------------------------
//  SD / WiFi helpers (unchanged)
// ---------------------------------------------------------------------------
bool loadWifiConfig() {
  File f = SD_MMC.open("/wifi.txt");
  if (!f) { Serial.println("wifi.txt missing"); return false; }
  while (f.available()) {
    String line = f.readStringUntil('\n'); line.trim();
    if (line.startsWith("ssid="))     wifiSSID = line.substring(5);
    if (line.startsWith("password=")) wifiPassword = line.substring(9);
  }
  f.close();
  Serial.println("WiFi config loaded");
  return true;
}

bool loadSoftWifiConfig() {
  File f = SD_MMC.open("/softwifi.txt");
  if (!f) {
    Serial.println("softwifi.txt missing");
    return false;
  }
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.startsWith("ssid="))
      apSSID = line.substring(5);
    if (line.startsWith("password="))
      apPassword = line.substring(9);
  }
  f.close();
  Serial.println("SoftWiFi config loaded");
  Serial.println("SSID: " + apSSID);
  return true;
}

String getContentType(String filename) {
  if (filename.endsWith(".html") || filename.endsWith(".htm")) return "text/html";
  if (filename.endsWith(".js")   || filename.endsWith(".mjs")) return "application/javascript";
  if (filename.endsWith(".css"))  return "text/css";
  if (filename.endsWith(".json")) return "application/json";
  if (filename.endsWith(".png"))  return "image/png";
  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
  if (filename.endsWith(".mp4"))  return "video/mp4";
  if (filename.endsWith(".webm")) return "video/webm";
  if (filename.endsWith(".vtt"))  return "text/vtt";
  if (filename.endsWith(".wasm")) return "application/wasm";
  if (filename.endsWith(".mp3"))  return "audio/mpeg";
  if (filename.endsWith(".m4a"))  return "audio/mp4";
  if (filename.endsWith(".wav"))  return "audio/wav";
  if (filename.endsWith(".ogg"))  return "audio/ogg";
  if (filename.endsWith(".flac")) return "audio/flac";
  if (filename.endsWith(".aac"))  return "audio/aac";
  return "text/plain";
}

String getContentTypeWithCharset(String filename) {
  String ctype = getContentType(filename);
  if (ctype == "text/plain" || ctype == "text/html" || ctype == "text/css" ||
      ctype == "text/vtt" || ctype == "application/javascript" ||
      ctype == "application/json") {
    ctype += "; charset=utf-8";
  }
  return ctype;
}

String urlDecode(String input) {
  String out = "";
  for (int i = 0; i < input.length(); i++) {
    char c = input[i];
    if (c == '%') {
      char high = input[++i], low = input[++i];
      char hex[3] = {high, low, '\0'};
      out += (char)strtol(hex, NULL, 16);
    } else if (c == '+') {
      out += ' ';
    } else {
      out += c;
    }
  }
  return out;
}

String urlEncodeFilename(String str) {
  String out = "";
  for (int i = 0; i < str.length(); i++) {
    char c = str[i];
    if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~' || c == '/') {
      out += c;
    } else {
      out += '%';
      char hex[3];
      sprintf(hex, "%02X", (unsigned char)c);
      out += hex;
    }
  }
  return out;
}

String generateDirectoryListing(const String& dirPath, File& dir) {
  String html = "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Index of ";
  html += dirPath;
  html += "</title></head><body>";
  html += "<h1>Index of " + dirPath + "</h1><ul>";

  String parent = dirPath;
  if (parent.endsWith("/")) parent = parent.substring(0, parent.length() - 1);
  int lastSlash = parent.lastIndexOf('/');
  if (lastSlash >= 0) {
    String parentPath = parent.substring(0, lastSlash + 1);
    html += "<li><a href=\"" + parentPath + "\">../</a></li>";
  }

  File entry;
  while (entry = dir.openNextFile()) {
    String name = entry.name();
    if (name == "." || name == "..") continue;
    bool isDir = entry.isDirectory();
    String encodedName = urlEncodeFilename(name);
    String href = dirPath + encodedName;
    if (isDir) href += "/";
    html += "<li><a href=\"" + href + "\">" + name + (isDir ? "/" : "") + "</a></li>";
    entry.close();
  }
  html += "</ul></body></html>";
  return html;
}

void createPath(String path) {
  int idx = 0;
  while ((idx = path.indexOf('/', idx + 1)) != -1) {
    String sub = path.substring(0, idx);
    if (!SD_MMC.exists(sub)) {
      SD_MMC.mkdir(sub);
      Serial.println("Created dir: " + sub);
    }
  }
}

String buildResponse(int code, const String &ctype, const String &body,
                     const String &extra = "") {
  String status = (code == 200) ? "OK" :
                  (code == 206) ? "Partial Content" :
                  (code == 301) ? "Moved Permanently" :
                  (code == 404) ? "Not Found" :
                  (code == 405) ? "Method Not Allowed" :
                  (code == 416) ? "Range Not Satisfiable" :
                  (code == 503) ? "Service Unavailable" :
                  "Internal Server Error";
  String resp = "HTTP/1.1 " + String(code) + " " + status + "\r\n";
  resp += "Access-Control-Allow-Origin: *\r\n";
  if (ctype.length()) resp += "Content-Type: " + ctype + "\r\n";
  if (body.length())  resp += "Content-Length: " + String(body.length()) + "\r\n";
  if (extra.length()) resp += extra + "\r\n";
  resp += "Connection: close\r\n\r\n";
  resp += body;
  return resp;
}

// ---------------------------------------------------------------------------
//  Download handler (port 80) – updated with CORS and HEAD support
// ---------------------------------------------------------------------------
void handleDownload(int idx) {
  ClientContext &c = clients[idx];
  if (!c.client.connected()) { closeClient(idx); return; }
  unsigned long now = millis();
  if (c.lastActivity && (now - c.lastActivity > IDLE_TIMEOUT_MS)) {
    closeClient(idx); return;
  }

  // ---------- READING_HEADERS ----------
  if (c.state == READING_HEADERS) {
    while (c.client.available()) {
      char ch = c.client.read();
      c.lastActivity = now;
      if (ch == '\n') {
        if (c.requestLine.length() == 0) { c.headersComplete = true; break; }
        c.headers += c.requestLine + "\n";
        c.requestLine.trim();
        if (c.method.length() == 0) {
          int sp1 = c.requestLine.indexOf(' ');
          if (sp1 > 0) {
            c.method = c.requestLine.substring(0, sp1);
            int sp2 = c.requestLine.indexOf(' ', sp1 + 1);
            if (sp2 > 0) {
              String uri = c.requestLine.substring(sp1 + 1, sp2);
              int q = uri.indexOf('?');
              if (q > 0) { c.path = uri.substring(0, q); c.query = uri.substring(q + 1); }
              else c.path = uri;
            }
          }
        } else {
          c.headers += c.requestLine + "\n";
        }
        c.requestLine = "";
      } else if (ch != '\r') {
        c.requestLine += ch;
      }
    }
    if (c.headersComplete) c.state = PROCESSING;
    return;
  }

  // ---------- PROCESSING ----------
  if (c.state == PROCESSING) {
    c.path = urlDecode(c.path);
    c.path = urlDecode(c.path);

    // Special rewrites (keep your custom ones)
    if (c.path == "/emulator/reader.html") {
      c.path = "/reader.html";
    }
    if (c.path == "/repair-ffmpeg-wasm.html") {
      c.path = "../ffmpeg/repair-ffmpeg-wasm.html";
    }

    // ---- Handle OPTIONS on port 80 for CORS preflight ----
    if (c.method == "OPTIONS") {
      c.responseHeaders = buildResponse(204, "", "",
        "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type, Range, If-None-Match, If-Modified-Since\r\n");
      c.state = SENDING_HEADERS; return;
    }

    if (c.path == "/platform.txt") {
      c.responseHeaders = buildResponse(200, "text/plain; charset=utf-8", "arduino");
      c.state = SENDING_HEADERS; return;
    }
    if (c.path == "/serverip.txt") {
      String ip = WiFi.localIP().toString();
      c.responseHeaders = buildResponse(200, "text/plain; charset=utf-8", "http://" + ip + ":80");
      c.state = SENDING_HEADERS; return;
    }
    if (c.path == "/expandedstorage.txt" || c.path == "/localexpanded.txt") {
      c.responseHeaders = buildResponse(200, "text/plain; charset=utf-8", "");
      c.state = SENDING_HEADERS; return;
    }

    // ---------- DIRECTORY LISTING (modified for root) ----------
    if (c.path.endsWith("/")) {
      // Special case: root path -> serve /index.html if it exists
      if (c.path == "/") {
        if (SD_MMC.exists("/index.html")) {
          c.path = "/index.html";
        } else {
          c.responseHeaders = buildResponse(404, "text/plain; charset=utf-8", "index.html not found");
          c.state = SENDING_HEADERS;
          return;
        }
      } else {
        // For any other folder, generate a directory listing
        if (openFiles >= MAX_OPEN_FILES) {
          if (enqueueWaiting(idx)) {
            c.state = WAITING_FOR_FILE;
            c.waitStart = now;
          } else {
            c.responseHeaders = buildResponse(503, "text/plain; charset=utf-8", "Server busy");
            c.state = SENDING_HEADERS;
          }
          return;
        }
        openFiles++;

        String dirPathNoSlash = c.path;
        if (dirPathNoSlash.endsWith("/")) dirPathNoSlash = dirPathNoSlash.substring(0, dirPathNoSlash.length() - 1);
        File dir = SD_MMC.open(dirPathNoSlash);
        if (!dir || !dir.isDirectory()) {
          if (dir) dir.close();
          openFiles--;
          int w = dequeueWaiting(); if (w >= 0) clients[w].state = PROCESSING;
          c.responseHeaders = buildResponse(404, "text/plain; charset=utf-8", "Directory not found");
          c.state = SENDING_HEADERS;
          return;
        }

        String html = generateDirectoryListing(c.path, dir);
        dir.close();
        openFiles--;
        int w = dequeueWaiting(); if (w >= 0) clients[w].state = PROCESSING;

        c.responseHeaders = buildResponse(200, "text/html; charset=utf-8", html);
        c.state = SENDING_HEADERS;
        return;
      }
    }

    // Speed test (unchanged)
    if (c.path == "/speedtest") {
      if (openFiles >= MAX_OPEN_FILES) {
        if (enqueueWaiting(idx)) {
          c.state = WAITING_FOR_FILE;
          c.waitStart = now;
        } else {
          c.responseHeaders = buildResponse(503, "text/plain; charset=utf-8", "Server busy");
          c.state = SENDING_HEADERS;
        }
        return;
      }
      c.file = SD_MMC.open("/speedtest.bin", FILE_WRITE);
      if (!c.file) {
        c.responseHeaders = buildResponse(500, "text/plain; charset=utf-8", "Failed to open file");
        c.state = SENDING_HEADERS; return;
      }
      openFiles++;
      c.fileOpen = true;

      uint8_t *chunk = (uint8_t*)malloc(65536);
      if (!chunk) {
        c.file.close(); c.file = File(); c.fileOpen = false; openFiles--;
        int w = dequeueWaiting(); if (w>=0) clients[w].state = PROCESSING;
        c.responseHeaders = buildResponse(500, "text/plain; charset=utf-8", "Memory error");
        c.state=SENDING_HEADERS; return;
      }
      memset(chunk, 0xFF, 65536);
      unsigned long start = micros();
      size_t written = 0;
      const size_t total = 5*1024*1024;
      while (written < total) {
        size_t sz = total - written > 65536 ? 65536 : total - written;
        size_t w = c.file.write(chunk, sz);
        if (w != sz) break;
        written += w;
      }
      unsigned long elapsed = micros() - start;
      free(chunk);
      c.file.close(); c.file = File();
      c.fileOpen = false;
      openFiles--;
      int w = dequeueWaiting(); if (w>=0) clients[w].state = PROCESSING;

      double speed = (double)written / (elapsed/1000000.0) / (1024*1024);
      String resp = "SD write speed: " + String(speed,2) + " MB/s\n";
      resp += "Card type: " + String(SD_MMC.cardType()) + "\n";
      resp += "Card size: " + String(SD_MMC.cardSize()/(1024*1024)) + " MB\n";
      c.responseHeaders = buildResponse(200, "text/plain; charset=utf-8", resp);
      c.state = SENDING_HEADERS;
      return;
    }

    // Redirect if path is a directory without trailing slash (no extension)
    if (c.path.endsWith("/")) {
      c.path += "index.html";
    } else {
      int dot = c.path.lastIndexOf('.');
      int slash = c.path.lastIndexOf('/');
      if (dot <= slash || dot == -1) {
        c.responseHeaders = buildResponse(301, "text/plain; charset=utf-8", "Redirecting...",
                           "Location: " + c.path + "/");
        c.state = SENDING_HEADERS; return;
      }
    }

    // Serve file
    if (openFiles >= MAX_OPEN_FILES) {
      if (enqueueWaiting(idx)) {
        c.state = WAITING_FOR_FILE;
        c.waitStart = now;
      } else {
        c.responseHeaders = buildResponse(503, "text/plain; charset=utf-8", "Server busy");
        c.state = SENDING_HEADERS;
      }
      return;
    }

    c.file = SD_MMC.open(c.path);
    if (!c.file) {
      if (c.path.endsWith(".vtt")) {
        c.responseHeaders = buildResponse(200, "text/vtt; charset=utf-8", "");
      } else {
        c.responseHeaders = buildResponse(404, "text/plain; charset=utf-8", "File not found");
      }
      c.state = SENDING_HEADERS; return;
    }

    openFiles++;
    c.fileOpen = true;
    c.fileSize = c.file.size();
    c.filePos = 0;
    c.bytesRemaining = c.fileSize;
    c.isRange = false;
    c.responseCode = 200;

    // Check for Range header
    int rIdx = c.headers.indexOf("Range:");
    if (rIdx >= 0) {
      int endLine = c.headers.indexOf('\n', rIdx);
      String rh = c.headers.substring(rIdx + 6, endLine);
      rh.trim(); rh.replace("bytes=", "");
      int dash = rh.indexOf('-');
      if (dash >= 0) {
        if (dash == 0) {
          long suffix = rh.substring(1).toInt();
          if (suffix > (long)c.fileSize) suffix = c.fileSize;
          c.rangeStart = c.fileSize - suffix;
          c.rangeEnd = c.fileSize - 1;
          c.isRange = true;
        } else {
          c.rangeStart = rh.substring(0, dash).toInt();
          if (dash+1 < rh.length()) c.rangeEnd = rh.substring(dash+1).toInt();
          else c.rangeEnd = c.fileSize - 1;
          if (c.rangeEnd >= c.fileSize) c.rangeEnd = c.fileSize - 1;
          if (c.rangeStart < c.fileSize) c.isRange = true;
          else {
            c.responseHeaders = buildResponse(416, "text/plain; charset=utf-8", "Range Not Satisfiable");
            c.file.close(); c.file = File(); c.fileOpen = false; openFiles--;
            int w = dequeueWaiting(); if (w>=0) clients[w].state = PROCESSING;
            c.state = SENDING_HEADERS; return;
          }
        }
        if (c.isRange) {
          if (c.rangeStart > c.rangeEnd) c.rangeEnd = c.rangeStart;
          c.filePos = c.rangeStart;
          c.bytesRemaining = c.rangeEnd - c.rangeStart + 1;
        }
      }
    }

    String ctype = getContentTypeWithCharset(c.path);
    bool media = ctype.startsWith("video/") || ctype.startsWith("audio/");
    String extra;
    if (media) extra += "Accept-Ranges: bytes\r\n";
    if (c.isRange) {
      extra += "Content-Range: bytes " + String(c.rangeStart) + "-" +
               String(c.rangeEnd) + "/" + String(c.fileSize) + "\r\n";
      c.responseCode = 206;
    } else c.responseCode = 200;

    String hdr = "HTTP/1.1 " + String(c.responseCode) + " " +
                 (c.responseCode == 206 ? "Partial Content" : "OK") + "\r\n";
    hdr += "Access-Control-Allow-Origin: *\r\n";
    hdr += "Content-Type: " + ctype + "\r\n";
    hdr += "Content-Length: " + String(c.bytesRemaining) + "\r\n";
    hdr += extra;
    hdr += "Connection: close\r\n\r\n";

    c.responseHeaders = hdr;
    if (c.isRange) c.file.seek(c.rangeStart);

    // Allocate buffer from PSRAM if available
    if (!c.buffer) {
      c.buffer = (uint8_t*)heap_caps_malloc(BUFFER_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
      if (!c.buffer) {
        c.buffer = (uint8_t*)malloc(BUFFER_SIZE);
      }
    }

    c.state = SENDING_HEADERS;
    return;
  }

  // ---------- WAITING_FOR_FILE ----------
  if (c.state == WAITING_FOR_FILE) {
    if (now - c.waitStart > 30000) {
      c.responseHeaders = buildResponse(503, "text/plain; charset=utf-8", "Server busy – timeout");
      c.state = SENDING_HEADERS;
    }
    return;
  }

  // ---------- SENDING_HEADERS ----------
  if (c.state == SENDING_HEADERS) {
    const String &data = c.responseHeaders;
    size_t sent = c.client.write(data.c_str(), data.length());
    if (sent == data.length()) {
      // If method is HEAD, we should not send body
      if (c.method == "HEAD") {
        c.state = CLOSING;
      } else {
        c.state = (c.fileOpen) ? SENDING_BODY : CLOSING;
      }
    } else {
      c.responseHeaders = data.substring(sent);
    }
    return;
  }

  // ---------- SENDING_BODY ----------
  if (c.state == SENDING_BODY) {
    if (!c.fileOpen || c.bytesRemaining == 0) { closeClient(idx); return; }
    if (!c.buffer) { closeClient(idx); return; }

    if (c.bufferPos == 0) {
      size_t chunk = (c.bytesRemaining > BUFFER_SIZE) ? BUFFER_SIZE : c.bytesRemaining;
      size_t rd = c.file.read(c.buffer, chunk);
      if (rd == 0) { closeClient(idx); return; }
      c.bufferPos = rd;
      c.bytesToSend = rd;
      c.sendOffset = 0;
    }

    size_t toWrite = c.bytesToSend - c.sendOffset;
    size_t wr = c.client.write(c.buffer + c.sendOffset, toWrite);
    if (wr > 0) {
      c.sendOffset += wr;
      c.bytesRemaining -= wr;
      c.lastActivity = millis();
    } else {
      c.lastActivity = millis();
      delay(1);
      return;
    }

    if (c.sendOffset >= c.bytesToSend) {
      c.bufferPos = 0;
      c.bytesToSend = 0;
      c.sendOffset = 0;
    }
    return;
  }

  // ---------- CLOSING ----------
  if (c.state == CLOSING) closeClient(idx);
}

// ---------------------------------------------------------------------------
//  Upload handler (port 81) – updated to support Content-Range and CORS
// ---------------------------------------------------------------------------
void handleUpload(int idx) {
  ClientContext &c = clients[idx];
  if (!c.client.connected()) { closeClient(idx); return; }
  unsigned long now = millis();
  if (c.lastActivity && (now - c.lastActivity > IDLE_TIMEOUT_MS)) {
    closeClient(idx); return;
  }

  // ---------- READING_HEADERS ----------
  if (c.state == READING_HEADERS) {
    while (c.client.available()) {
      char ch = c.client.read();
      c.lastActivity = now;
      if (ch == '\n') {
        if (c.requestLine.length() == 0) { c.headersComplete = true; break; }
        c.headers += c.requestLine + "\n";
        c.requestLine.trim();
        if (c.method.length() == 0) {
          int sp1 = c.requestLine.indexOf(' ');
          if (sp1 > 0) {
            c.method = c.requestLine.substring(0, sp1);
            int sp2 = c.requestLine.indexOf(' ', sp1 + 1);
            if (sp2 > 0) {
              String uri = c.requestLine.substring(sp1 + 1, sp2);
              int q = uri.indexOf('?');
              if (q > 0) { c.path = uri.substring(0, q); c.query = uri.substring(q + 1); }
              else c.path = uri;
            }
          }
        } else {
          int colon = c.requestLine.indexOf(':');
          if (colon > 0) {
            String key = c.requestLine.substring(0, colon); key.toLowerCase();
            String val = c.requestLine.substring(colon + 1); val.trim();
            if (key == "content-length") {
              c.contentLength = val.toInt();
            }
            // Also capture Content-Range if present
            if (key == "content-range") {
              // Parse later in PROCESSING
              c.headers += c.requestLine + "\n"; // we'll store it in headers for later parsing
            }
          }
        }
        c.requestLine = "";
      } else if (ch != '\r') {
        c.requestLine += ch;
      }
    }
    if (c.headersComplete) c.state = PROCESSING;
    return;
  }

  // ---------- PROCESSING ----------
  if (c.state == PROCESSING) {
    // Handle OPTIONS with full CORS headers
    if (c.method == "OPTIONS") {
      c.responseHeaders = buildResponse(204, "", "",
        "Access-Control-Allow-Methods: PUT, POST, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type, Content-Range, Content-Length, "
        "X-LibraryJS-Upload-Id, X-LibraryJS-Upload-Name, X-LibraryJS-Upload-Size, "
        "X-LibraryJS-Upload-Offset, X-LibraryJS-Chunk-Index, X-LibraryJS-Chunk-Count, "
        "X-Upload-Id, X-Upload-Name, X-Upload-Size, X-Upload-Offset, X-Upload-Part, X-Upload-Count\r\n");
      c.state = SENDING_HEADERS; return;
    }

    if ((c.method != "PUT" && c.method != "POST") || c.path != "/upload") {
      c.responseHeaders = buildResponse(405, "text/plain; charset=utf-8", "Method Not Allowed",
        "Allow: PUT, POST, OPTIONS");
      c.state = SENDING_HEADERS; return;
    }

    String target;
    int idx2 = c.query.indexOf("path=");
    if (idx2 >= 0) {
      int end = c.query.indexOf('&', idx2);
      if (end < 0) end = c.query.length();
      target = c.query.substring(idx2 + 5, end);
      target = urlDecode(target);
      target = urlDecode(target);
    }
    if (target.length() == 0 || target.endsWith("/")) {
      c.responseHeaders = buildResponse(400, "text/plain; charset=utf-8", "Missing or invalid 'path'");
      c.state = SENDING_HEADERS; return;
    }

    createPath(target);

    // Parse Content-Range header (if present) to determine offset and total size
    long rangeStart = -1;
    long rangeEnd = -1;
    long totalSize = -1;
    int rangeIdx = c.headers.indexOf("Content-Range:");
    if (rangeIdx >= 0) {
      int endLine = c.headers.indexOf('\n', rangeIdx);
      String rangeLine = c.headers.substring(rangeIdx + 14, endLine);
      rangeLine.trim();
      // Format: "bytes start-end/total"
      if (rangeLine.startsWith("bytes ")) {
        rangeLine = rangeLine.substring(6);
        int dash = rangeLine.indexOf('-');
        int slash = rangeLine.indexOf('/');
        if (dash > 0 && slash > dash) {
          rangeStart = rangeLine.substring(0, dash).toInt();
          rangeEnd   = rangeLine.substring(dash + 1, slash).toInt();
          totalSize  = rangeLine.substring(slash + 1).toInt();
        }
      }
    }

    // If this is a ranged upload, we need to handle it differently
    bool isRangedUpload = (rangeStart >= 0 && totalSize > 0);

    if (openFiles >= MAX_OPEN_FILES) {
      if (enqueueWaiting(idx)) {
        c.path = target;
        c.state = WAITING_FOR_FILE;
        c.waitStart = now;
      } else {
        c.responseHeaders = buildResponse(503, "text/plain; charset=utf-8", "Server busy");
        c.state = SENDING_HEADERS;
      }
      return;
    }

    // Open file for writing (will truncate if exists, but we want to preserve existing chunks)
    // For ranged upload, we must not truncate; we open in read/write mode (FILE_WRITE actually opens for read/write on SD)
    // However, FILE_WRITE will create and truncate? According to Arduino SD library, FILE_WRITE opens for reading and writing, and if file exists, it will overwrite from beginning unless you seek.
    // So we need to open with FILE_WRITE, but if the file exists, we should not truncate. Actually, the SD library's open with FILE_WRITE will not truncate; it will keep existing content and allow seeking.
    // So we can just open with FILE_WRITE.
    c.file = SD_MMC.open(target, FILE_WRITE);
    if (!c.file) {
      c.responseHeaders = buildResponse(500, "text/plain; charset=utf-8", "Failed to open file");
      c.state = SENDING_HEADERS; return;
    }

    openFiles++;
    c.fileOpen = true;
    c.bodyReceived = 0;
    c.bufferPos = 0;
    c.path = target;

    // Allocate upload buffer from PSRAM
    if (!c.buffer) {
      c.buffer = (uint8_t*)heap_caps_malloc(BUFFER_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
      if (!c.buffer) {
        c.buffer = (uint8_t*)malloc(BUFFER_SIZE);
      }
    }

    if (isRangedUpload) {
      // Seek to the start offset
      if (!c.file.seek(rangeStart)) {
        c.file.close();
        c.fileOpen = false;
        openFiles--;
        c.responseHeaders = buildResponse(500, "text/plain; charset=utf-8", "Seek failed");
        c.state = SENDING_HEADERS;
        return;
      }
      // We'll use bytesRemaining to track how many bytes to expect from this chunk
      // The total bytes to receive for this chunk is (rangeEnd - rangeStart + 1)
      // We'll store the total expected for this chunk in contentLength (if not already set)
      c.contentLength = rangeEnd - rangeStart + 1;
      // Also store the total file size (totalSize) to know when complete
      c.fileSize = totalSize;
      // We'll maintain a running total of received bytes across all chunks.
      // Since each request is separate, we can track it per request, but we need to know overall progress.
      // We'll store totalReceived in a separate variable; but since each request is independent, we can't keep state across requests easily.
      // Instead, we'll just accept the chunk and respond OK. The client will know when done.
      // To prevent partial overwrites, we rely on the client to send chunks in order.
      // If out-of-order, seek will place at correct offset.
      c.isRange = true;
      // We'll set bytesRemaining to the chunk size
      c.bytesRemaining = c.contentLength;
    } else {
      // Whole-file upload: use Content-Length
      c.contentLength = c.contentLength; // already parsed
      c.bytesRemaining = c.contentLength;
      c.fileSize = c.contentLength;
      c.isRange = false;
    }

    c.state = RECEIVING_BODY;
    return;
  }

  // ---------- WAITING_FOR_FILE ----------
  if (c.state == WAITING_FOR_FILE) {
    if (now - c.waitStart > 30000) {
      c.responseHeaders = buildResponse(503, "text/plain; charset=utf-8", "Server busy – timeout");
      c.state = SENDING_HEADERS;
    }
    return;
  }

  // ---------- RECEIVING_BODY ----------
  if (c.state == RECEIVING_BODY) {
    if (!c.fileOpen) { closeClient(idx); return; }

    // Read data from client into buffer and write to file
    while (c.client.available() && c.bufferPos < BUFFER_SIZE && c.bodyReceived < c.bytesRemaining) {
      size_t spaceLeft = BUFFER_SIZE - c.bufferPos;
      size_t toRead = c.client.available();
      if (toRead > spaceLeft) toRead = spaceLeft;
      if (c.bodyReceived + toRead > c.bytesRemaining) {
        toRead = c.bytesRemaining - c.bodyReceived;
      }
      int got = c.client.read(c.buffer + c.bufferPos, toRead);
      if (got <= 0) break;
      c.bufferPos += got;
      c.bodyReceived += got;
      c.lastActivity = millis();
    }

    // If buffer is full or we have received all expected data, flush buffer to file
    if (c.bufferPos > 0 && (c.bufferPos == BUFFER_SIZE || c.bodyReceived >= c.bytesRemaining)) {
      size_t written = 0;
      size_t total = c.bufferPos;
      while (written < total) {
        size_t w = c.file.write(c.buffer + written, total - written);
        if (w == 0) {
          closeClient(idx);
          return;
        }
        written += w;
      }
      c.bufferPos = 0;
    }

    // Check if we have received the entire chunk
    if (c.bodyReceived >= c.bytesRemaining) {
      // Close the file after writing all data for this chunk
      c.file.close();
      c.fileOpen = false;
      openFiles--;
      int w = dequeueWaiting(); if (w >= 0) clients[w].state = PROCESSING;

      // Prepare success response
      String jsonResponse = "{\"ok\":true,\"path\":\"" + c.path + "\",\"size\":" + String(c.bodyReceived);
      if (c.isRange) {
        jsonResponse += ",\"range\":{\"start\":" + String(c.rangeStart) + ",\"end\":" + String(c.rangeEnd) + ",\"total\":" + String(c.fileSize) + "}";
      }
      jsonResponse += "}";
      c.responseHeaders = buildResponse(200, "application/json; charset=utf-8", jsonResponse);
      c.state = SENDING_HEADERS;
    }
    return;
  }

  // ---------- SENDING_HEADERS ----------
  if (c.state == SENDING_HEADERS) {
    const String &data = c.responseHeaders;
    size_t sent = c.client.write(data.c_str(), data.length());
    if (sent == data.length()) c.state = CLOSING;
    else c.responseHeaders = data.substring(sent);
    return;
  }

  // ---------- CLOSING ----------
  if (c.state == CLOSING) closeClient(idx);
}

// ---------------------------------------------------------------------------
//  Setup & Loop
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println("\n===== Interleaved Server (PSRAM Optimised) =====");

  // Boost CPU to max frequency
  setCpuFrequencyMhz(240);

  // Detect PSRAM
  if (psramFound()) {
    Serial.printf("PSRAM found: %d bytes\n", ESP.getPsramSize());
  } else {
    Serial.println("PSRAM not found, using internal SRAM");
  }

  // SD card – keep 1‑bit mode as you requested
  SD_MMC.setPins(39, 38, 40);
  if (!SD_MMC.begin("/sdcard", true)) {
    Serial.println("SD mount failed");
    return;
  }
  Serial.println("SD OK (1‑bit mode)");

  // --------------------------------------------------------------
  // 1) Try to load Wi‑Fi config and connect with a 3‑second timeout
  // --------------------------------------------------------------
  bool wifiConnected = false;
  if (loadWifiConfig()) {
    Serial.print("Connecting to Wi‑Fi");
    WiFi.begin(wifiSSID.c_str(), wifiPassword.c_str());

    unsigned long startAttempt = millis();
    const unsigned long timeout = 3000;  // 3 seconds

    while (millis() - startAttempt < timeout) {
      if (WiFi.status() == WL_CONNECTED) {
        wifiConnected = true;
        break;
      }
      delay(100);
      Serial.print(".");
    }
    Serial.println();

    if (wifiConnected) {
      Serial.println("Connected to Wi‑Fi");
      Serial.println("IP: " + WiFi.localIP().toString());
      WiFi.setSleep(false);
    } else {
      Serial.println("Wi‑Fi connection timed out.");
      WiFi.disconnect();
      delay(100);
    }
  }

  // --------------------------------------------------------------
  // 2) If Wi‑Fi not connected, fallback to SoftAP mode
  // --------------------------------------------------------------
  if (!wifiConnected) {
    Serial.println("Falling back to SoftAP mode...");
    if (loadSoftWifiConfig() && apSSID.length() > 0) {
      WiFi.mode(WIFI_AP);
      if (WiFi.softAP(apSSID.c_str(), apPassword.c_str())) {
        Serial.println("Access Point Started!");
        Serial.print("SSID: "); Serial.println(apSSID);
        Serial.print("Password: "); Serial.println(apPassword);
        Serial.print("AP IP Address: "); Serial.println(WiFi.softAPIP());
      } else {
        Serial.println("Failed to start Access Point");
      }
    } else {
      Serial.println("softwifi.txt missing or invalid – cannot start AP");
    }
  }

  // --------------------------------------------------------------
  // 3) Start the HTTP servers
  // --------------------------------------------------------------
  httpServer.begin();
  uploadServer.begin();
  Serial.println("Port 80 (download) & Port 81 (upload) started");
  Serial.printf("Max simultaneous open files: %d\n", MAX_OPEN_FILES);
  Serial.printf("Buffer size: %d bytes\n", BUFFER_SIZE);
  Serial.printf("TCP window: %d bytes\n", TCP_WINDOW_SIZE);
}

void loop() {
  bool active = false;

  WiFiClient dl = httpServer.available();
  if (dl) {
    int idx = findFreeSlot();
    if (idx >= 0) {
      setSocketBufferSize(dl, TCP_WINDOW_SIZE);
      dl.setNoDelay(true);
      clients[idx].client = dl;
      clients[idx].state = READING_HEADERS;
      clients[idx].isUpload = false;
      clients[idx].lastActivity = millis();
      active = true;
    } else {
      dl.stop();
    }
  }

  WiFiClient ul = uploadServer.available();
  if (ul) {
    int idx = findFreeSlot();
    if (idx >= 0) {
      setSocketBufferSize(ul, TCP_WINDOW_SIZE);
      ul.setNoDelay(true);
      clients[idx].client = ul;
      clients[idx].state = READING_HEADERS;
      clients[idx].isUpload = true;
      clients[idx].lastActivity = millis();
      active = true;
    } else {
      ul.stop();
    }
  }

  for (int i = 0; i < MAX_CLIENTS; i++) {
    if (clients[i].state != IDLE) {
      active = true;
      if (clients[i].isUpload) handleUpload(i);
      else                     handleDownload(i);
    }
  }

  if (!active) {
    delay(1);
  }
}
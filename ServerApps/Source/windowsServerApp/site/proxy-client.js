(() => {
  const PAGE_SOURCE = "UD_PAGE";
  const EXT_SOURCE = "UD_EXT";
  const REQUEST_TYPE = "UD_PROXY_REQUEST";
  const DOWNLOAD_TYPE = "UD_PROXY_DOWNLOAD";
  const FLOW_TRANSFER_TYPE = "UD_FLOW_TRANSFER";
  const ACTIVITY_STATE_TYPE = "UD_ACTIVITY_STATE";
  const SETTINGS_UPDATE_TYPE = "UD_SETTINGS_UPDATE";

  const pending = new Map();

  function uuid() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function baseRequest(url, { method = "GET", headers = {}, bodyText, bodyBase64, responseType = "text" } = {}) {
    return {
      method,
      url,
      headers,
      bodyText,
      bodyBase64,
      responseType,
      credentials: "omit"
    };
  }

  function send(type, payload) {
    return new Promise((resolve, reject) => {
      const requestId = uuid();
      pending.set(requestId, { resolve, reject });

      window.postMessage(
        {
          source: PAGE_SOURCE,
          type,
          requestId,
          payload
        },
        "*"
      );

      setTimeout(() => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        reject(new Error(`${type} timed out`));
      }, 120_000);
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== EXT_SOURCE) return;
    if (data.type !== "UD_PROXY_RESPONSE" && data.type !== "UD_PROXY_DOWNLOAD_RESPONSE" && data.type !== "UD_ACTIVITY_STATE_RESPONSE") return;

    const pendingEntry = pending.get(data.requestId);
    if (!pendingEntry) return;
    pending.delete(data.requestId);

    if (data.response && data.response.ok) {
      pendingEntry.resolve(data.response);
    } else {
      const status = data.response?.status != null ? `${data.response.status}${data.response.statusText ? ` ${data.response.statusText}` : ""}` : "no status";
      const body = typeof data.response?.body === "string" && data.response.body.trim()
        ? ` — ${data.response.body.slice(0, 240).replace(/\s+/g, " ")}`
        : "";
      pendingEntry.reject(new Error(data.response?.error || `Proxy request failed (${status})${body}`));
    }
  });

  function encodeJsonBody(body) {
    return JSON.stringify(body);
  }

  function youtubeNextRequest(videoId, origin = location.origin) {
    return {
      method: "POST",
      url: "https://www.youtube.com/youtubei/v1/next?prettyPrint=false",
      headers: {
        "Content-Type": "application/json",
        "X-Override-User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)",
        "X-Override-Origin": "https://www.youtube.com",
        "X-Youtube-Client-Name": "1",
        "X-Youtube-Client-Version": "2.20260114.08.00",
        "Referer": `${origin}/`
      },
      bodyText: encodeJsonBody({
        context: {
          client: {
            clientName: "WEB",
            clientVersion: "2.20260114.08.00",
            userAgent:
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)",
            hl: "en",
            timeZone: "UTC",
            utcOffsetMinutes: 0
          }
        },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true
      }),
      responseType: "json"
    };
  }

  function youtubePlayerRequest(videoId, origin = location.origin) {
    return {
      method: "POST",
      url: "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
      headers: {
        "Content-Type": "application/json",
        "X-Override-User-Agent":
          "com.google.android.youtube/21.02.35 (Linux; U; Android 11) gzip",
        "X-Override-Origin": "https://www.youtube.com",
        "X-Youtube-Client-Name": "3",
        "X-Youtube-Client-Version": "21.02.35",
        "Referer": `${origin}/`
      },
      bodyText: encodeJsonBody({
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "21.02.35",
            androidSdkVersion: 30,
            userAgent: "com.google.android.youtube/21.02.35 (Linux; U; Android 11) gzip",
            osName: "Android",
            osVersion: "11",
            hl: "en",
            timeZone: "UTC",
            utcOffsetMinutes: 0
          }
        },
        videoId,
        playbackContext: {
          contentPlaybackContext: {
            html5Preference: "HTML5_PREF_WANTS"
          }
        },
        contentCheckOk: true,
        racyCheckOk: true
      }),
      responseType: "json"
    };
  }

  function mediaGetRequest(url, origin = location.origin) {
    return {
      method: "GET",
      url,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "X-Override-User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        Referer: `${origin}/`
      },
      responseType: "arrayBuffer"
    };
  }

  async function request(options) {
    return send(REQUEST_TYPE, baseRequest(options.url, options));
  }

  async function download(options) {
    return send(DOWNLOAD_TYPE, {
      ...baseRequest(options.url, options),
      filename: options.filename,
      saveAs: Boolean(options.saveAs)
    });
  }

  async function sendFlowTransfer(options) {
    return send(FLOW_TRANSFER_TYPE, options);
  }

  async function setActivity(options = {}) {
    return send(ACTIVITY_STATE_TYPE, options);
  }

  async function updateSettings(options = {}) {
    return send(SETTINGS_UPDATE_TYPE, options);
  }

  async function youtubeNext(videoId) {
    return request(youtubeNextRequest(videoId));
  }

  async function youtubePlayer(videoId) {
    return request(youtubePlayerRequest(videoId));
  }

  async function downloadMedia(url, filename) {
    return download({
      url,
      filename,
      responseType: "arrayBuffer"
    });
  }

  window.LibraryJSServerProxy = {
    request,
    download,
    youtubeNext,
    youtubePlayer,
    downloadMedia,
    sendFlowTransfer,
    setActivity,
    updateSettings,
    youtubeNextRequest,
    youtubePlayerRequest,
    mediaGetRequest
  };
})();

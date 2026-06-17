# LibraryJS Server

Run `node server.mjs --root "C:\Path\To\LibraryJS" --port 8084` to test the server, then load the `extension/` folder as an unpacked extension if you are using the browser relay pieces.

The local launcher supports multiple folder roots, each with its own port. One enabled location is enough to start, and you can add more locations for other drives.

## What this build does

- Serves the selected folder root directly from the local Node server
- Returns that folder’s `index.html` at `/`
- Supports single-range byte requests with `206 Partial Content`
- Sends `Accept-Ranges`, `ETag`, and `Last-Modified` for static files
- Shows directory listings when a folder has no index page
- Supports optional hidden-dot-file blocking and precompressed `.gz` / `.br` files
- Exposes a local `/api/health` endpoint for startup checks
- Creates and reuses a persistent local HTTPS certificate in the user profile when HTTPS is enabled
- Keeps the Windows tray launcher self-contained as a single EXE

## Simple Web Server-style options

The static server now mirrors the useful file-serving behavior from Simple Web Server, including:

- `index.html` / `index.htm` serving
- directory listing
- SPA fallback
- hidden-dot-file control
- precompressed file serving
- CORS on demand
- byte-range support

Simple Web Server also documents uploads, file replacement/deletion, HTTPS, basic auth, custom error pages, IPv6, cache control, `.swshtaccess`, and on-the-fly compression. Those behaviors are documented there, but this LibraryJS build only includes the file-serving pieces that fit the current launcher and server model.


## Optional request logging

Debug logging is off by default. Enable it with `--log` or `LIBRARYJS_ENABLE_LOGGING=1` when you need request traces. When enabled, the log is written to `%TEMP%\LibraryJSServer-<port>.log`.

## Notes

- Each enabled location should use a unique port.
- The launcher starts one Node server per enabled location.
- The browser opens the first running location by default.

## Self-contained Windows tray build

This folder builds into a single Windows EXE that starts the local server and manages a tray icon.

### Build it

1. Open PowerShell in this folder on Windows.
2. Run `powershell -ExecutionPolicy Bypass -File .\build-sea.ps1`.
3. Launch `dist\LibraryJSServer.exe`.

The EXE opens the local app in your browser. Minimizing the window hides it to the system tray instead of keeping a taskbar button. The tray launcher can remember the last locations, start with Windows, and auto-start the configured servers on launch.

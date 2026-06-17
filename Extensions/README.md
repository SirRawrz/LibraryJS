# SelfHosted Stream Archiver — Server FFmpeg remux build

This build keeps the existing archive pipeline, but sends the final remux step to your server's FFmpeg repair endpoint instead of using a browser-side remux library.

## Notes

- The extension stages playlist and segment uploads into a server temp job folder first, then asks the server-side FFmpeg repair flow to publish the finished MP4 into the destination folder.
- The temp job folder uses a non-hidden path by default because the server app blocks hidden dot-path uploads unless that setting is explicitly enabled.
- Any old browser-side remux helper settings have been removed from the options page.

## Cleanup behavior

- The extension passes the staged HLS folder to the Android FFmpeg repair endpoint.
- The Android server deletes that staged folder after the remux succeeds.
- This keeps the browser from needing to clean up the server-side temp job folder itself.

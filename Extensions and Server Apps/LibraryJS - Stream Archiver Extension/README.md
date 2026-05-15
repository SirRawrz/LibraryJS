# SelfHosted Stream Archiver — Mediabunny remux build

This build keeps the existing archive pipeline, but replaces the browser remux worker with **Mediabunny**.

## What to put in the extension

Download these official Mediabunny release files:

- `mediabunny.mjs`
- `mediabunny.d.ts`

Put them here in the extension:

- `v19.1_workerfs_only/v19.1_updated/mediabunny/mediabunny.mjs`
- `v19.1_workerfs_only/v19.1_updated/mediabunny/mediabunny.d.ts`

The worker loads `mediabunny/mediabunny.mjs` locally, so the old Mediabunny core files are no longer used for remuxing.

## Notes

- The remux path is now `Mediabunny -> Input(BlobSource) -> Conversion -> StreamTarget` and MP4 output uses true fast-start mode so the moov metadata is written up front for immediate playback.
- Large jobs still write out in chunks while the final MP4 is assembled in fast-start order.
- The placeholder path still exists for missing segments and uses Mediabunny as well.

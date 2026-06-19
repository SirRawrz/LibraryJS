# Android FFmpeg fallback assets

This folder keeps the packaged FFmpeg binaries that can be used as a fallback source on Android arm64-v8a.

The app prefers the native library copies under:

- `app/src/main/jniLibs/arm64-v8a/libffmpeg.so`
- `app/src/main/jniLibs/arm64-v8a/libffprobe.so`

These assets are kept here for situations where the packaged libraries are not the source being used at runtime.

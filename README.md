## Its a part of my soul at this point.


   <img width="146" height="125" alt="Untitled" src="https://github.com/user-attachments/assets/8797fc59-edb0-41cc-b3e0-110dc050a38a" />

 # LibraryJS Hosted Bundle
    This folder is the core of the actual LibraryJS that you experience in your browser.

    The Android and Windows apps act like the console, while whatever folder (Flash Drive/HDD) are the cartridges holding your files and the files unpacked from the HostedByServerApp.zip. The library itself is compatible between devices. I am to support IOS/Linux/Docker as well. 
   
    ## Why not Jellyfin? Plex? Emby?

    LibraryJS is about perserving all your media, in a safe offline state, that is accessible, easy to backup and share locally and over tailscale. Build bundles of content to give out locally between family and friends over wifi locally when you visit (or remotely over tailscale.)


    ## Setup

    1. Download the android apk or the windows exe.
    2. Install the android apk and click "More info" "Run anyways". (I hope to sign my things eventually! Sorry!)
    3. Choose a Main Server folder. Hit start and Install LibraryJS. This will download and unpack the hostedbyserverapp.zip from github. Be patient. I plan on speeding up the unpacking so that the emulator is unpacked last so the rest of the site is available to work with. Users just wont be able to play EmulatorJS games until its finished.
    4. Use Manage to add Videos, Games, Music, and Reading Content.
    5. Once you've amassed enough to start sharing locally you can use the Backup/Restore routes to give that content to another device. One way I've used it is to send things from my main server to my android device, so that when I visit the library, which has 100x the upload as my home internet's upload, so that I can send anime to a friend in the U.K. from the US over tailscale! 

    
## LICENSE
Other file

                        GNU GENERAL PUBLIC LICENSE
                           Version 3, 29 June 2007

     Copyright (C) 2007 Free Software Foundation, Inc. <https://fsf.org/>
     Everyone is permitted to copy and distribute verbatim copies
     of this license document, but changing it is not allowed.

                                Preamble

      The GNU General Public License is a free, copyleft license for
    software and other kinds of works.

      The licenses for most software and other practical works are designed
    to take away your freedom to share and change the works.  By contrast,
    the GNU General Public License is intended to guarantee your freedom to
    share and change all versions of a program--to make sure it remains free
    software for all its users.  We, the Free Software Foundation, use the
    GNU General Public License for most of our software; it applies also to
    any other work released this way by its authors.  You can apply it to
    your programs, too.

      When we speak of free software, we are referring to freedom, not
    price.  Our General Public Licenses are designed to make sure that you
    have the freedom to distribute copies of free software (and charge for
    them if you wish), that you receive source code or can get it if you
    want it, that you can change the software or use pieces of it in new
    free programs, and that you know you can do these things.

      To protect your rights, we need to prevent others from denying you
    these rights or asking you to surrender the rights.  Therefore, you have
    certain responsibilities if you distribute copies of the software, or if
    you modify it: responsibilities to respect the freedom of others.

      For example, if you distribute copies of such a program, whether
    gratis or for a fee, you must pass on to the recipients the same
    freedoms that you received.  You must make sure that they, too, receive
    or can get the source code.  And you must show them these terms so they
    know their rights.

      Developers that use the GNU GPL protect your rights with two steps:
    (1) assert copyright on the software, and (2) offer you this License
    giving you legal permission to copy, distribute and/or modify it.

      For the developers' and authors' protection, the GPL clearly

## THIRD_PARTY_NOTICES.md
Project documentation / readme

    # Third-Party Notices

    This project includes or depends on third-party software, assets, or services.

    ## Project license choice

    The LibraryJS project code and distribution are intended to be released under GPL-3.0-or-later, because the hosted bundle includes GPL-licensed EmulatorJS content and related GPL-compatible components.

    ## Included or depended-on components

    ### FFmpeg
    Used for repair/remux workflows and packaged binaries in host app assets.

    Upstream license: LGPL 2.1-or-later, with some optional parts covered by GPL 2-or-later depending on build configuration.

    ### EmulatorJS
    Used for the web-based emulator experience.

    Upstream license: GPL-3.0-or-later.

    ### mGBA Dual Libretro
    Used for Game Boy Advance emulation in the hosted bundle.

    Upstream license: MPL-2.0.

    ### OpenSubtitles API
    Used as a remote subtitle service integration.

    This is a hosted service/API dependency, so its use is also subject to the service’s own terms, policies, and rate limits.

    ### six-two/qr.html
    Used for the QR helper page.

    Upstream license: The Unlicense.

    ### Whisper Subtitles
    Used for local subtitle/transcription-related flows.

    Upstream license: MIT License for the code and released model weights.

    ## Notes

    This file is a project-level notice, not a substitute for the upstream license texts or service terms. Keep the upstream notices with redistributed copies of the corresponding components.

    If any packaged third-party binary or asset has its own redistribution requirements, those requirements still apply.


## Hosted by a server app (android or windows)/
- `Backup-flow.html` — Backup Profile and Server Content
- `Books.html` — Redirects to reader.html?lib=books
- `Calendar.html` — Shared Calendar
- `Manga.html` — Redirects to reader.html?lib=manga
- `Music.html` — Music Player
- `Musicproxy/README.txt` — Readme / component note
- `Musicproxy/app.js` — Desktop dashboard logic for stream/source selection and handoff
- `Musicproxy/index.html` — Music Archiver for LibraryJS; uses ./proxy-client.js, ./app.js
- `Musicproxy/proxy-client.js` — Message bridge used by the music proxy/server UIs
- `Musicproxy/setup.html` — Music Archiver Setup; uses ./setup.js
- `Musicproxy/setup.js` — JavaScript file with 6 detected function(s)
- `Musicproxy/styles.css` — Other file
- `Notes.html` — Notes — Profiles
- `Restore-flow.html` — Restore Flow
- `albums.html` — Albums — Platform-aware Uploads
- `audiobooklib.html` — Audiobook Library Mapper
- `booklib.html` — Book Library Manager
- `booklibs.html` — Book Library Manager
- `books.js` — Book library catalog with grouped entries
- `cookbook.html` — Cookbook
- `default-profile.js` — Fallback single-profile identity file
- `emulator/dualmgba/assets/index-B4_LH3C2.js` — JavaScript file with 0 detected function(s)
- `emulator/dualmgba/coi-serviceworker.js` — JavaScript file with 0 detected function(s)
- `emulator/dualmgba/mgba_dual.html` — mGBA Dual - Fixed Save Handler (Fullscreen Patch)
- `emulator/dualmgba/mgba_dual.html.b4auto` — Other file
- `emulator/dualmgba/mgba_dual.html.b4fullscreen` — Other file
- `emulator/dualmgba/mgba_dual_libretro-C8kJ_TJo.wasm` — Binary asset / build artifact / icon / native library
- `emulator/dualmgba/mgba_dual_libretro-C_ewntC1.js` — JavaScript file with 0 detected function(s)
- `emulator/dualmgba/mgba_dual_libretro-DCIPVHkY.js` — JavaScript file with 1 detected function(s)
- `emulator/dualmgba/mgba_dual_libretro.js` — JavaScript file with 0 detected function(s)
- `emulator/dualmgba/mgba_dual_libretro.worker.js` — JavaScript file with 0 detected function(s)
- `emulator/dualmgba/service-worker.js` — JavaScript file with 0 detected function(s)
- `emulator/iframehelper.html` — Iframe Helper for adding Guidebooks
- `emulator/indexarcade.html` — EmulatorJS
- `emulator/indexdos.html` — EmulatorJS
- `emulator/indexgb.html` — EmulatorJS
- `emulator/indexgba.html` — EmulatorJS
- `emulator/indexn64.html` — EmulatorJS
- `emulator/indexnds.html` — EmulatorJS
- `emulator/indexpsp.html` — EmulatorJS
- `emulator/indexpsx.html` — EmulatorJS
- `emulator/indexsega.html` — EmulatorJS
- `emulator/indexsnes.html` — EmulatorJS
- `expandedstorage.txt` — Plaintext note or configuration seed
- `favicon.ico` — Binary asset / build artifact / icon / native library
- `ffmpeg/repair.html` — FFmpeg Repair (Server Assembled)
- `games.html` — Games
- `games.js` — Curated games launcher catalog
- `gameslib.html` — Games Library Manager
- `guidebooks.html` — Redirects to reader.html?lib=guidebooks
- `guidebooks.js` — Game guidebook catalog matched to games
- `https setup.txt` — Plaintext note or configuration seed
- `httpserverip.txt` — Plaintext note or configuration seed
- `httpsserverip.txt` — Plaintext note or configuration seed
- `index.html` — Media Server
- `lib.html` — Library Manager
- `library.js` — Core shared runtime / library logic (~2 KB)
- `loadgames.js` — Game library renderer, favorites, tiles, and launch handling
- `loadmainfolders.js` — Renders the root folder grid and favorite/star helpers
- `loadseasonfunctions.js` — Generated season/series loader functions for many TV collections
- `mainfolders.js` — Top-level folder/catalog list for home navigation
- `manage.html` — 📚 Library Manager
- `manga.js` — Manga catalog
- `musicgenres.html` — Music Genres
- `musiclib.html` — Music Library Manager
- `musiclibrary.js` — Flat music catalog and genre-code map
- `opensubtitles-rest-api-favored.txt` — Plaintext note or configuration seed
- `opensubtitles-rest-api.txt` — Plaintext note or configuration seed
- `opensubtitles-rest-api2.txt` — Plaintext note or configuration seed
- `opensubtitles-rest-api3.txt` — Plaintext note or configuration seed
- `opensubtitles-rest-api4.txt` — Plaintext note or configuration seed
- `opensubtitles-subtitles.html` — Fetching Subtitles...
- `paste.html` — Paste — Profile-aware
- `platform.txt` — Plaintext note or configuration seed
- `profile.html` — Choose Profile
- `profiles.js` — Generated profile list and custom server title
- `radio.html` — Radio Player
- `reader.html` — Book Library
- `screensaver.js` — Album-art screensaver / idle slideshow
- `server-content-backup.html` — LibraryJS — Server Content Backup
- `server-profile-backup.html` — LibraryJS — Server Profiles Backup
- `serverip.txt` — Plaintext note or configuration seed
- `setup.html` — Setup Wizard
- `six-two-qr.html` — Offline QR helper
- `tailscaleip.txt` — Plaintext note or configuration seed
- `tailscaleserverip.txt` — Plaintext note or configuration seed
- `torrent.html` — Torrent Browser
- `transfer-backup.html` — LibraryJS — Transfer Backup
- `transfer-profile-backup.html` — LibraryJS — Transfer Profile Backup
- `tvd.html` — TV Auto Resume
- `utilities.html` — LibraryJS Utilities
- `webtorrent.min.js` — JavaScript file with 0 detected function(s)
- `whisper-subtitles.html` — Whisper Flow (Offline, Local Only)

## androidserverapp/
- `.gitignore` — Other file
- `ANDROID_FFMPEG_SETUP.txt` — Plaintext note or configuration seed
- `ANDROID_FFMPEG_SPEED_NOTES.txt` — Plaintext note or configuration seed
- `app/.gitignore` — Other file
- `app/build.gradle.kts` — Kotlin file with 0 detected function(s)
- `app/proguard-rules.pro` — Other file
- `app/src/androidTest/java/com/example/libraryjs/ExampleInstrumentedTest.kt` — Kotlin file with 2 detected function(s)
- `app/src/main/AndroidManifest.xml` — Binary asset / build artifact / icon / native library
- `app/src/main/assets/ffmpeg/README.txt` — Readme / component note
- `app/src/main/assets/ffmpeg/arm64-v8a/ffmpeg` — Other file
- `app/src/main/assets/ffmpeg/arm64-v8a/ffprobe` — Other file
- `app/src/main/java/com/example/libraryjs/BootReceiver.kt` — Boot-complete auto-start receiver
- `app/src/main/java/com/example/libraryjs/FfmpegRepairManager.kt` — Android repair/remux job manager
- `app/src/main/java/com/example/libraryjs/LocalLibraryServer.kt` — Per-root HTTP/HTTPS server and request handler
- `app/src/main/java/com/example/libraryjs/MainActivity.kt` — Android control panel UI for roots, ports, HTTPS, USB mode, and startup
- `app/src/main/java/com/example/libraryjs/NetworkUtils.kt` — LAN/local IP discovery and URL builder
- `app/src/main/java/com/example/libraryjs/ServerConfig.kt` — Kotlin file with 2 detected function(s)
- `app/src/main/java/com/example/libraryjs/ServerService.kt` — Foreground Android service that runs the configured servers
- `app/src/main/java/com/example/libraryjs/ServerStore.kt` — Persistent Android preferences/store for roots and settings
- `app/src/main/java/com/example/libraryjs/ServerTlsManager.kt` — Android certificate/material generation and HTTPS socket setup
- `app/src/main/java/com/example/libraryjs/StoragePreview.kt` — Human-readable storage-tree preview generator
- `app/src/main/java/com/example/libraryjs/StorageRoot.kt` — Storage-root data model
- `app/src/main/java/com/example/libraryjs/TemporaryUsbRegistry.kt` — Temporary USB root registry
- `app/src/main/jniLibs/arm64-v8a/libffmpeg.so` — Binary asset / build artifact / icon / native library
- `app/src/main/jniLibs/arm64-v8a/libffprobe.so` — Binary asset / build artifact / icon / native library
- `app/src/main/res/drawable/ic_launcher_background.xml` — Binary asset / build artifact / icon / native library
- `app/src/main/res/drawable/ic_launcher_foreground.png` — Binary asset / build artifact / icon / native library
- `app/src/main/res/layout/activity_main.xml` — Binary asset / build artifact / icon / native library
- `app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml` — Binary asset / build artifact / icon / native library
- `app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml` — Binary asset / build artifact / icon / native library
- `app/src/main/res/mipmap-anydpi/ic_launcher.xml` — Binary asset / build artifact / icon / native library
- `app/src/main/res/mipmap-anydpi/ic_launcher_round.xml` — Binary asset / build artifact / icon / native library
- `app/src/main/res/mipmap-hdpi/ic_launcher.webp` — Binary asset / build artifact / icon / native library
- `app/src/main/res/mipmap-hdpi/ic_launcher_round.webp` — Binary asset / build artifact / icon / native library
- `app/src/main/res/mipmap-mdpi/ic_launcher.webp` — Binary asset / build artifact / icon / native library
- `app/src/main/res/mipmap-mdpi/ic_launcher_round.webp` — Binary asset / build artifact / icon / native library
- `app/src/main/res/mipmap-xhdpi/ic_launcher.webp` — Binary asset / build artifact / icon / native library
- `app/src/main/res/mipmap-xhdpi/ic_launcher_round.webp` — Binary asset / build artifact / icon / native library
- `app/src/main/res/mipmap-xxhdpi/ic_launcher.webp` — Binary asset / build artifact / icon / native library
- `app/src/main/res/mipmap-xxhdpi/ic_launcher_round.webp` — Binary asset / build artifact / icon / native library
- `app/src/main/res/mipmap-xxxhdpi/ic_launcher.webp` — Binary asset / build artifact / icon / native library
- `app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.webp` — Binary asset / build artifact / icon / native library
- `app/src/main/res/values-night/themes.xml` — Binary asset / build artifact / icon / native library
- `app/src/main/res/values/colors.xml` — Binary asset / build artifact / icon / native library
- `app/src/main/res/values/strings.xml` — Binary asset / build artifact / icon / native library
- `app/src/main/res/values/themes.xml` — Binary asset / build artifact / icon / native library
- `app/src/main/res/xml/backup_rules.xml` — Binary asset / build artifact / icon / native library
- `app/src/main/res/xml/data_extraction_rules.xml` — Binary asset / build artifact / icon / native library
- `app/src/test/java/com/example/libraryjs/ExampleUnitTest.kt` — Kotlin file with 1 detected function(s)
- `build.gradle.kts` — Kotlin file with 0 detected function(s)
- `gradle.properties` — Other file
- `gradle/libs.versions.toml` — Other file
- `gradle/wrapper/gradle-wrapper.jar` — Binary asset / build artifact / icon / native library
- `gradle/wrapper/gradle-wrapper.properties` — Other file
- `gradlew` — Other file
- `gradlew.bat` — Binary asset / build artifact / icon / native library
- `local.properties` — Other file
- `settings.gradle.kts` — Kotlin file with 0 detected function(s)
- `test.txt` — Plaintext note or configuration seed

## Windows Server app/
- `BUILD-STEPS.txt` — Plaintext note or configuration seed
- `LibraryJSServer.ico` — Binary asset / build artifact / icon / native library
- `build-sea.ps1` — Other file
- `launcher.cjs` — JavaScript file with 1 detected function(s)
- `server.mjs` — Node server for serving the bundle, uploads, proxying, and repair routes
- `serverlog.txt` — Plaintext note or configuration seed
- `site/app.js` — Desktop dashboard logic for stream/source selection and handoff
- `site/index.html` — LibraryJS Server; uses ./proxy-client.js, ./app.js
- `site/proxy-client.js` — Message bridge used by the music proxy/server UIs
- `site/setup.html` — LibraryJS Setup
- `site/setup.js` — JavaScript file with 6 detected function(s)
- `site/styles.css` — Other file
- `trayhost/LibraryJSServer.ico` — Binary asset / build artifact / icon / native library
- `trayhost/LibraryJSServerTray.csproj` — Other file
- `trayhost/Program.cs` — Other file
- `trayhost/build-sea.ps1` — Other file

## Extension/
- `README.md` — Project documentation / readme
- `bridge.js` — Content-script bridge between page hook and extension runtime
- `icons/icon128.png` — Binary asset / build artifact / icon / native library
- `icons/icon16.png` — Binary asset / build artifact / icon / native library
- `icons/icon48.png` — Binary asset / build artifact / icon / native library
- `library-browser.js` — Popup tree browser for the live library/archive matches
- `manifest.json` — Text file
- `offscreen.html` — Stream Archiver Remux; uses offscreen.js
- `offscreen.js` — Offscreen remux placeholder page
- `options.html` — Stream Archiver Options
- `options.js` — Extension settings page logic
- `page-hook.js` — Injected page monitor for media/subtitle detection and page session reporting
- `popup.html` — Stream Archiver
- `popup.js` — Main popup UI logic for archive jobs, subtitles, and selections
- `remux-worker.js` — JavaScript file with 0 detected function(s)
- `server.mjs` — Node server for serving the bundle, uploads, proxying, and repair routes
- `service_worker.js` — Background worker for archive detection, staging, remuxing, and server coordination

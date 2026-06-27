# LibraryJS

LibraryJS has two apps currently, but most of what you experience of LibraryJS is in your browser.

The Android and Windows apps act like the console, while whatever folder (Flash Drive/HDD) are the cartridges holding your files and the files unpacked from the HostedByServerApp.zip here on Github. The library structure saved on your storage is compatible between devices. I eventually aim to support Linux/Docker/IOS as well.

---

## Why not Jellyfin? Plex? Emby?

LibraryJS is about perserving all your media, in a family safe offline state, that is accessible, easy to backup and share locally and over tailscale. Build bundles of content to give out  between family and friends over their local wifi when you visit (or remotely over tailscale.) All with the same browser experience. Once your video files have been fast start "repaired" we don't transcode them, allowing the server to be fairly weak and still perform well. The point is a living archive, with easy couch streaming and personal features like having your album images as screen savers! Not just videos, but reading content, music, and even EmulatorJS games with built in guidebooks! A console that lives on your storage. You can even play multiplayer against others locally or tailscale like you could on the original consoles! Gameboy Advance Pokemon games can trade! So why not start/give someone a start at selfhosting their own media server through this!

<img width="1923" height="892" alt="image" src="https://github.com/user-attachments/assets/dfec448c-4e8c-4e0d-8fd5-b5243436e649" />

---

## Setup

1. Download the android apk or the windows exe.

2. Android Server - Install the android apk | Windows Server - click **"More info"** **"Run anyways"**. (I hope to sign my things eventually! Sorry!)

3. Choose a Main Server folder. Hit start and Install LibraryJS. This will download and unpack the hostedbyserverapp.zip from github. Be patient. I plan on speeding up the unpacking so that the emulator is unpacked last so the rest of the site is available to work with. Users just wont be able to play EmulatorJS games until its finished.

4. Click on the 192.x.x.x in the LibraryJS app to open your library in browser (It will always be in browser)

5. Setup the server, writing in its name, the IP address that you clicked on. Write it like this:

```
http://X.X.X.X:8080/
```

where 8080 is the port you chose in the app.

If you don't have tailscale, you can sign up and enter your IP from it in here, so that the page can make original and kid safe QRs for you.

(Going to `http://X.X.X.X:8080/?I` will mark you as an adult. You will default as a kid if you don't enter this. The app will take you to this page automatically, but manual entry will require this knowledge! Why ?I because it looks like ?l!)

6. Use Manage to add Videos, Games, Music, and Reading Content.

7. For videos and Music you can use an extension like FetchV, Videodownloadhelper or Stream Archiver (being built with the project. It really streamlines gathering the content but its not 100% reliable everywhere. It is perfect for streamline grabbing music from youtube. Sorry if you're purist! You can still add/upload your music in Manage!) 

For Videos you want to upload manually, without the Stream Archiver extension, scan the content and then select the red button declaring it missing. This will prompt you for a file that it will upload to fill that spot! 
<img width="1901" height="893" alt="image" src="https://github.com/user-attachments/assets/93782b4e-867d-4f86-9d15-117a0aa839cd" />

8. Once you've amassed enough to start sharing locally you can use the Backup/Restore routes to give that content to another device. One way I've used it is to send things from my main server to my android device, so that when I visit the library, which has 100x the upload as my home internet's upload, so that I can send anime to a friend in the U.K. from the US over tailscale! If you would like to share just the "shells" without the actual copyright content, while distributing online, you can use the Backup Shell Content in backup. 


---
## Its a part of my soul at this point.

<p align="center">
  <img width="1870" height="21248" alt="library" src="https://github.com/user-attachments/assets/7687ce46-4376-4260-be18-f8af863c0990" />
</p>

<img width="1884" height="900" alt="image" src="https://github.com/user-attachments/assets/0c03e06f-2401-4253-b684-a974d8edfe87" />

<img width="1906" height="1079" alt="image" src="https://github.com/user-attachments/assets/be9ba8dc-784f-4d76-a1f0-9872ff00a65b" />

---
## LICENSE

Other file

```
GNU GENERAL PUBLIC LICENSE
Version 3, 29 June 2007

Copyright (C) 2007 Free Software Foundation, Inc. <https://fsf.org/>
Everyone is permitted to copy and distribute verbatim copies
of this license document, but changing it is not allowed.
```

The remainder of the GPL license text continues in the LICENSE file.

---

## THIRD_PARTY_NOTICES.md

Project documentation / readme

### Third-Party Notices

This project includes or depends on third-party software, assets, or services.

#### Project license choice

The LibraryJS project code and distribution are intended to be released under GPL-3.0-or-later, because the hosted bundle includes GPL-licensed EmulatorJS content and related GPL-compatible components.

#### Included or depended-on components

##### FFmpeg

Used for repair/remux workflows and packaged binaries in host app assets.

Upstream license: LGPL 2.1-or-later, with some optional parts covered by GPL 2-or-later depending on build configuration.

##### EmulatorJS

Used for the web-based emulator experience.

Upstream license: GPL-3.0-or-later.

##### mGBA Dual Libretro

Used for Game Boy Advance emulation in the hosted bundle.

Upstream license: MPL-2.0.

##### OpenSubtitles API

Used as a remote subtitle service integration.

This is a hosted service/API dependency, so its use is also subject to the service's own terms, policies, and rate limits.

##### six-two/qr.html

Used for the QR helper page.

Upstream license: The Unlicense.

##### Whisper Subtitles

Used for local subtitle/transcription-related flows.

Upstream license: MIT License for the code and released model weights.

#### Notes

This file is a project-level notice, not a substitute for the upstream license texts or service terms. Keep the upstream notices with redistributed copies of the corresponding components.

If any packaged third-party binary or asset has its own redistribution requirements, those requirements still apply.

---

## Hosted by a server app (android or windows)

<details>
<summary><strong>Click to expand file list</strong></summary>

```

PASTE YOUR ENTIRE FILE LIST HERE EXACTLY AS IT ALREADY EXISTS

```

</details>

---

## androidserverapp/

<details>
<summary><strong>Click to expand file list</strong></summary>

```

PASTE YOUR ENTIRE ANDROID FILE LIST HERE EXACTLY AS IT ALREADY EXISTS

```

</details>

---

## Windows Server app/

<details>
<summary><strong>Click to expand file list</strong></summary>

```

PASTE YOUR ENTIRE WINDOWS FILE LIST HERE EXACTLY AS IT ALREADY EXISTS

```

</details>

---

## Extension/

<details>
<summary><strong>Click to expand file list</strong></summary>

```

PASTE YOUR ENTIRE EXTENSION FILE LIST HERE EXACTLY AS IT ALREADY EXISTS

```

</details>

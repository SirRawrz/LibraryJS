## LibraryJS

LibraryJS is a local-first digital library designed to be your personal or family archive, accessible from any modern browser.
The Android and Windows apps act like the console, while your storage device acts like the cartridge. Your media, library data, and LibraryJS files live together on your storage and can move between compatible hosts while preserving the same experience.

<img width="1914" height="486" alt="image" src="https://github.com/user-attachments/assets/319d84c9-caea-4448-89c7-9f5333f6cb75" />


Most of what you experience of LibraryJS happens in your browser. The server applications simply provide access to your library, allowing even low-powered devices to act as servers without needing expensive hardware. In many cases, the only thing you need to buy is storage.


<img width="1536" height="1024" alt="1955b10f-3128-4b3d-85ef-f0e8c9a683ef" src="https://github.com/user-attachments/assets/9d6ca849-3db7-44e1-bbc9-e2d84a0cff98" />

The goal is to support Linux, Docker, and iOS in the future as well.

---

## Why not Jellyfin? Plex? Emby?

LibraryJS is about preserving your media in a family-safe, offline state that is easy to access, back up, and share locally or over Tailscale. Some households are perfect for Jellyfin, Plex and Emby, but mine isn't. My family's internet is slow, our hardware is modest, and I wanted something built around those realities instead of despite them.

This project is about building collections and hoarding a living library: a personal legacy that can be freely shared with friends and family while preserving the same experience everywhere.

Build bundles of content to share over local Wi-Fi when visiting family and friends, or remotely over Tailscale. Once video files have been "fast start" repaired, LibraryJS avoids transcoding whenever possible, allowing even relatively weak servers to perform well.

The goal is a living family/personal archive with easy couch streaming and personal touches, like displaying album uploads as profile based screen savers. LibraryJS focuses on collections of Movies and Series, but its also Books, Manga, Music and EmulatorJS games with built-in guidebooks.

You can even play multiplayer games locally or over Tailscale much like the original consoles. Link Trade Cable supported for Game Boy Advance Pokemon trading and battles.

<img width="1919" height="900" alt="image" src="https://github.com/user-attachments/assets/58da91dc-c9f3-4361-a834-d234200def91" />


---

## Setup
<img width="800" height="450" alt="0627-ezgif com-video-to-gif-converter" src="https://github.com/user-attachments/assets/d6005aba-28c2-47ce-a3d4-aaa62ca5da1f" />

1. Download the android apk or the windows exe. (WINDOWS GIF Above, Creating a server for http and https)

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

6. Use Manage to add Videos, Games, Music, and Reading Content, 
<img width="1874" height="895" alt="image" src="https://github.com/user-attachments/assets/b6c6ac7b-d115-4120-9928-bb464ea43bb8" />


or Browse Shells that I made already to get started. 
<img width="1915" height="887" alt="image" src="https://github.com/user-attachments/assets/e321ddb4-8c26-4faa-aa65-47346cafdc04" />
https://sirrawrz.github.io/LibraryJS-Content-Shells/ is a preview accessible without running the server and clicking "Browse Shells." 
<img width="1699" height="881" alt="image" src="https://github.com/user-attachments/assets/6c04990b-e32a-4da7-a71a-5e4b9f9a308b" />


7. For videos and Music you can use an extension like FetchV, Videodownloadhelper or Stream Archiver (being built with the project. It really streamlines gathering the content but its not 100% reliable everywhere. It is perfect for streamline grabbing music from youtube. Sorry if you're purist! You can still add/upload your music in Manage!) 

For Videos you want to upload manually, without the Stream Archiver extension, scan the content and then select the red button declaring it missing. This will prompt you for a file that it will upload to fill that spot! 
<img width="1901" height="893" alt="image" src="https://github.com/user-attachments/assets/93782b4e-867d-4f86-9d15-117a0aa839cd" />

8. Once you've amassed enough to start sharing locally you can use the Backup/Restore routes to give that content to another device. One way I've used it is to send things from my main server to my android device, so that when I visit the library, which has 100x the upload as my home internet's upload, so that I can send anime to a friend in the U.K. from the US over tailscale! 

<img width="800" height="450" alt="06271-ezgif com-optimize" src="https://github.com/user-attachments/assets/76f358bc-4163-4aff-9f94-3453386a3c62" />

If you would like to share just your "shells" as well without the actual copyright content, while distributing online, you can use the Backup Shell Content in backup. 


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

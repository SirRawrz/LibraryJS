---------------------------------------------------------------------------------------------------
EXTENSIONS
---------------
Video Archiver doesn't work for protected streams. You can go to ./manage.html and scan a video and click on the red icon showing its missing to manually upload video files if you get them from other sources.

These extensions were made to accompany LibraryJS' library.js and musiclibrary.js files.
---------------------------------------------------------------------------------------------------
SERVERS
---------------
Music Archiver requires a proxy to work. Its a standalone node.js that uses ffmpeg-wasm located on the server to convert mp4 videos to mp3s. 


ADDED- A LibraryJS Server. Before the files had just used https://simplewebserver.org/ as the server program. The server app can now replace that! I hope to make the android and ios apps from it as a base so they can be used as the server. 

The zip files that are in the Source folder can be unpacked and built into the exe apps that are the server. Ive also built them!
---------------------------------------------------------------------------------------------------
# Media Server Setup — Detailed Project README

The readme was made having an LLM dig through the project and isn't completely current. This thing is stuffed with behaviors and features ;-;

This project is a **browser-first media server interface**. The server is used primarily as **storage and file hosting**, while the actual app logic runs in the browser with HTML, CSS, and JavaScript.

There is no traditional backend application here doing catalog work, playback logic, or database work. Instead, the pages read and write files directly, use `localStorage` for fast local state, and synchronize select data back to the server when needed.

---

## What this setup is trying to do

The goal is to make a self-hosted media library feel like a real media center:

- browse TV, movies, music, albums, calendars, notes, and paste utilities from one family-friendly entry point
- keep per-profile data separated
- support a TV or couch-friendly viewing mode
- make phone browsing practical, especially for sending content to the TV view
- let the library manager generate and maintain loader files without manual editing everywhere
- keep repair and maintenance tools inside the same ecosystem

This archive is the core client-side site. It does **not** include every companion tool you mentioned, such as the stream archiving extension, the YouTube/music filling extension, or the separate `repair.html` ffmpeg-wasm flow if those live elsewhere.

---

## High-level architecture

### 1) Static entry pages
These are the visible pages the user opens directly in the browser:

- `index.html` — main media hub
- `tvd.html` — TV / couch playback view
- `profile.html` — profile editor
- `manage.html` — library manager and scan/repair hub
- `lib.html` — content-generation wizard for building loader entries
- `Music.html` — music player
- `radio.html` — radio player
- `albums.html` — photo/albums view
- `Calendar.html` — shared calendar
- `Notes.html` — profile notes
- `paste.html` — profile-aware paste area

### 2) Shared generated data files
These files are not just “support code”; they are the actual catalog structures the site reads from:

- `mainfolders.js` — top-level folder list
- `library.js` — large video/library dataset
- `musiclibrary.js` — music catalog data
- `loadseasonfunctions.js` — auto-generated series/season loader functions
- `profiles.js` — current profile list and title configuration
- `games.js` — game tile catalog and emulator links
- `loadmainfolders.js` — routing logic for the main page
- `screensaver.js` — inactivity slideshow / screensaver overlay

### 3) Client-side persistence
The app stores state in a few different ways:

- `localStorage` for local resume data, selected profile, UI state, and temporary edits
- server-hosted `.txt`, `.js`, `.json`, and media files for shared persistence
- profile-specific paths for notes, paste, calendar, favorites, and media metadata
- direct browser fetch/PUT style uploads for supported platforms

---

## The core navigation model

The whole setup is centered around `index.html`.

When the site loads, it:

- reads the active profile
- loads the main folder tiles
- applies the profile theme
- sets up the custom video controls
- preloads favorites
- checks platform behavior from `platform.txt`
- activates the screen-saver logic if the user goes idle

The main page is not just a menu. It is the main media hub that opens the rest of the system.

---

## The phone-first / TV-first flow

One of the strongest parts of the project is the **Send to TV** flow.

### Why it exists
It makes the TV page easy to control from a phone. A user can browse on a phone or smaller screen, then hand off playback to the couch-friendly TV interface without needing to dig through menus.

### How it works in practice
On `index.html`, if a title has saved resume data, the resume popup offers:

- **Yes, Continue**
- **Not yet**
- **Send to TV**

The **Send to TV** action is a shortcut for moving the selected show into the TV playback path. It is designed so you can browse from the phone and then just hit **TV** on `tvd.html` or jump into the TV view with the correct playback state already prepared.

That makes `tvd.html` the “lean back” companion to `index.html`:

- bigger controls
- remote/gamepad-friendly navigation
- episode controls
- fullscreen support
- QR shortcuts
- favorite toggles
- resume-aware playback

This is a very clear UX strength of the project.

---

## File-by-file breakdown

## `index.html`
Main landing page and the most important file in the app.

### What it does
- shows the main media library tiles
- handles resume prompts for videos and shows
- provides the **Send to TV** flow
- manages profile selection and profile display
- renders favorites
- supports QR shortcuts
- coordinates playback, episode navigation, and custom controls
- ties in the screensaver behavior

### Important relationships
- loads `profiles.js` for profile names and server title
- loads `mainfolders.js` and `loadmainfolders.js` for the main folder list and routing
- loads `library.js` and `loadseasonfunctions.js` for the actual video catalog and series loaders
- loads `screensaver.js` for idle slideshow behavior
- loads `games.js` for the game tiles / emulator links

### Notable UX features
- resume overlay with “Yes, Continue”, “Not yet”, and “Send to TV”
- favorite star system for tiles and current playback
- QR buttons
- kid-safe / adult filtering support
- mobile-friendly controls
- automatically stored progress per profile

---

## `tvd.html`
The dedicated **TV / couch playback** page.

### What it does
- presents a simplified playback view for the TV
- supports big, obvious controls for remote or touch use
- manages episodes and playback navigation
- includes fullscreen controls
- shows favorites
- keeps the same profile context as the rest of the app
- can work as the “destination” for phone-to-TV handoff

### Why it matters
This page is the practical endpoint for the phone-first flow. The idea is that you browse or queue up content on a phone, then use `tvd.html` for easy playback control on the bigger screen.

### Important relationships
- uses `library.js` for episode/show data
- uses `profiles.js` for profile identity and display
- uses `screensaver.js` for idle overlay behavior
- links back to `index.html`, `radio.html`, and profile-related pages

### Notable UX features
- back button
- favorite button
- send-to-TV button
- previous / rewind / play / forward / next
- episodes drawer
- fullscreen
- QR shortcuts
- auto-resume messaging

---

## `manage.html`
The maintenance and scan dashboard.

### What it does
- acts as the control center for library scanning and maintenance
- scans video files and subtitles
- supports pausable scans
- shows totals and missing items
- opens nested management tools in modals
- launches the repair flow for selected episodes

### Important relationships
- opens `lib.html` inside an iframe for add-content flows
- opens the ffmpeg repair page inside an iframe for repair work
- works across video, music, and games libraries
- depends on the library data files to know what exists and what is missing

### Notable features
- “Scan all videos”
- “Scan all subs”
- pause / stop scanning
- library wheel buttons for jumping between major library areas
- missing video / subtitle reporting
- “Repair File” modal that sends the selected item to the ffmpeg repair flow and uploads the fixed output back to the same path

### Why it matters
This is the operational side of the project. The site is not just a player; it also helps you maintain the catalog.

---

## `lib.html`
The content creation and loader-generation wizard.

### What it does
- guides you through building new library entries in steps
- lets you scoop existing titles as templates
- handles movie vs series structure
- supports collection and single-movie routing
- builds loader output for library files
- includes an LLM-assisted parsing stage
- handles artwork selection and upload

### Important relationships
- writes output that feeds `library.js`, `mainfolders.js`, and the series loader system
- interacts with artwork and upload paths
- is used by `manage.html` as the add-content flow

### Notable features
- step-based wizard
- title/root naming
- adult marking for kid-safe filtering
- movie collection vs single movie logic
- explicit support for conformance to existing layout
- automatic loader template generation
- artwork preview and upload handling

### Why it matters
This is the “authoring” layer of the project. It reduces manual code editing by generating the repetitive loader structures for you.

---

## `profile.html`
The profile editor.

### What it does
- lets you create, reorder, edit, and delete profiles
- supports server title editing
- manages profile images
- manages theme/background colors
- can lock a selected profile until it is intentionally unlocked

### Important relationships
- writes `profiles.js`
- updates profile images and title state
- works with `index.html`, `tvd.html`, `radio.html`, `albums.html`, `Music.html`, `Books.html`, `Manga.html`, and `manage.html` as a profile hub

### Notable features
- profile lock/unlock flow
- per-profile image path editing
- color chip editing
- profile reordering
- upload support
- active profile synchronization

---

## `Music.html`
The music player.

### What it does
- browses artists, genres, playlists, and liked songs
- supports playback controls and seeking
- supports loop and A/B markers
- shows “Now Playing”
- manages playlist images
- supports fullscreen playback
- supports search results and playlist editing

### Important relationships
- uses `musiclibrary.js`
- uses profile state so music data can stay per-profile
- integrates with server-side storage behavior through browser requests

### Notable features
- liked songs
- playlist manager
- drag/drop or button-based playback controls
- search filtering
- track metadata display
- flexible music browsing structure

---

## `radio.html`
The radio / stream-style music player.

### What it does
- plays playlist-based radio-style audio
- supports shuffle, next, previous, like, fullscreen, and volume control
- manages playlist images and playlists
- provides a simpler listening mode than the main music page

### Important relationships
- uses the same general music catalog concepts as `Music.html`
- shares profile-aware behavior
- complements the larger media interface with a more focused audio page

---

## `albums.html`
The photo and album page.

### What it does
- shows albums and shared images
- supports staged uploads and commit workflows
- handles profile-aware photo organization
- distinguishes shared images from profile-specific ones

### Important relationships
- uses `platform.txt`-based behavior to decide upload methods
- stores shared image files under `/Albums/shared/`
- uses the active profile to keep uploads organized

### Notable features
- all photos view
- create album
- staged uploads
- commit uploads
- profile badge / active profile display
- platform-aware upload handling

---

## `Calendar.html`
The shared calendar page.

### What it does
- shows a shared calendar
- supports new events, editing, deleting, and date navigation
- stores public and private events
- supports profile-specific sharing rules

### Important relationships
- stores public event data in a shared calendar file
- supports profile selection for event visibility
- uses local and server-backed event data together

### Notable features
- month grid
- public, private, and specific-profile event visibility
- quick event creation
- server-backed event persistence

---

## `Notes.html`
The profile-aware notes page.

### What it does
- keeps notes per profile
- supports public and private visibility
- supports categories
- syncs between local edits and server storage

### Important relationships
- stores notes in profile-specific server text files
- can merge public notes from multiple profiles
- supports syncing local edits to the server

### Notable features
- profile-aware note lists
- category filters
- public/private visibility
- sync button
- note editing and deletion

---

## `paste.html`
The profile-aware paste utility.

### What it does
- provides a simple text paste area
- stores the pasted content per profile
- supports copy/paste and save actions
- is meant for quick server-backed text holding

### Important relationships
- uses profile-specific file paths
- keeps text isolated per active profile
- behaves like a lightweight scratchpad for the user

---

## `mainfolders.js`
The generated top-level folder list.

### What it does
- defines the main navigation tiles
- includes the core folders and the many series/movie entries
- marks certain adult titles with `*`

### Important relationships
- is used by `loadmainfolders.js`
- is generated by the library manager
- feeds the home screen tile list

### Important note
This file appears to be **generated**, not manually maintained in the normal flow.

---

## `loadmainfolders.js`
The main home-screen router.

### What it does
- renders the main folders
- defines special handlers for non-standard tiles
- links “Continue Watching” to `tvd.html`
- routes “Games” to the game tile renderer
- routes “Music” to `Music.html`
- routes “Books”, “Manga”, and “Calendar” to their respective pages
- routes “Favorites” to the favorites loader

### Why it matters
This file is the glue between the tile list and the actual app pages.

### Important relationship
It makes the home page feel like a hub instead of a static menu.

---

## `loadseasonfunctions.js`
The generated season/series loader file.

### What it does
- defines a large set of `loadXSeasons()` functions
- converts library titles into episode tiles and season structures
- strips adult titles in kid mode
- normalizes season arrays

### Important relationships
- used by `index.html`
- backed by the catalog data in `library.js`
- coordinated with `mainfolders.js` and `loadmainfolders.js`

### Important detail
The `*` marker is used to flag adult content, and the kid-mode loader logic removes those items when kid mode is active.

---

## `library.js`
The large video catalog file.

### What it does
- stores the bulk of the media library data
- contains the content used to build shows, movies, and collections
- feeds the main browsing system

### Important relationships
- consumed by `index.html`, `tvd.html`, `manage.html`, and `lib.html`
- works with `loadseasonfunctions.js` and `loadmainfolders.js`

### Important note
This is one of the most important data files in the project, and it is large by design.

---

## `musiclibrary.js`
The music catalog file.

### What it does
- stores the music library data used by `Music.html`
- supports artists, genres, tracks, and playlist-based browsing

### Important relationships
- consumed by the music player
- supports the music management and playback workflow

---

## `profiles.js`
The profile data file.

### What it does
- exports the current profile list
- stores profile image paths and background data
- sets the site title

### Important relationships
- used by `index.html`, `tvd.html`, `Calendar.html`, `Notes.html`, `paste.html`, and `profile.html`
- acts like the shared identity source for the whole site

### Notable behavior
It updates the page title/header text so the whole app feels branded and profile-aware.

---

## `games.js`
The games catalog file.

### What it does
- adds the Games tile
- defines a list of game tiles
- links to emulator pages

### Important relationships
- plugged into the main tile system
- opened from the home page through the Games handler

### Important note
Some game links point to emulator paths, while others use direct server URLs. This makes the page act like a launcher rather than a single emulator.

---

## `screensaver.js`
The idle slideshow / screensaver overlay.

### What it does
- watches for inactivity
- starts a slideshow after a timeout
- pulls images from the active profile’s albums
- fades between two image slots
- stops when the user becomes active again

### Important relationships
- used by the main media pages and the TV page
- makes the library feel more like a living media appliance than a plain browser page

### Notable behavior
It is tied to album images and profile context, so the screensaver reflects the user’s own media.

---

## How the major pieces relate to each other

### Main browsing flow
`index.html`  
→ loads `profiles.js`  
→ loads `mainfolders.js`  
→ uses `loadmainfolders.js`  
→ uses `library.js` and `loadseasonfunctions.js`  
→ renders the library tiles and plays/resumes content

### TV flow
`index.html` resume prompt  
→ **Send to TV**  
→ `tvd.html`  
→ remote-friendly playback controls and episode navigation

### Library maintenance flow
`manage.html`  
→ scans data sources  
→ shows missing items  
→ opens `lib.html` for add-content generation  
→ opens repair modal for ffmpeg-based fixes

### Profile flow
`profile.html`  
→ edits `profiles.js`  
→ updates profile identity across the whole site

### Media-specific flows
- `Music.html` + `musiclibrary.js`
- `radio.html` + music/playlist data
- `albums.html` + profile-aware image storage
- `Calendar.html` + shared event data
- `Notes.html` + profile notes
- `paste.html` + profile scratchpad text

---

## Storage conventions and data style

This project uses a very file-centric storage model.

Common patterns include:

- `/Profiles/...` for profile-related content
- `/Albums/...` for albums and photos
- profile-specific `.txt` files for notes, paste, favorites, and similar data
- generated `.js` files for the main library structure
- `platform.txt` to adjust upload behavior by environment

This makes the server act more like a storage volume and less like an application runtime.

---

## Kid mode and adult filtering

The app supports a kid-safe route.

A title marked with `*` is treated as adult content in the loader files.

When kid mode is active:

- adult-marked items are stripped from the generated season lists
- the UI can hide or avoid those titles
- the same library can serve different audiences from the same file set

This is one of the stronger architectural choices in the project because it keeps one library while still supporting audience filtering.

---

## Why this project is interesting

This is not just a media page collection. It is a **self-hosted, browser-native media appliance** with:

- profile separation
- resume tracking
- TV handoff
- custom library generation
- music and radio support
- photo albums
- calendar
- notes
- paste storage
- screensaver behavior
- repair and maintenance tooling

It is very close to a full home media operating surface, even though the “server” itself is mostly just storage.

---

## Files referenced by the code but not present in this archive

The archive references some pages or tools that are not included here, such as:

- `Books.html`
- `Manga.html`
- `otherprofiles.html`
- the separate ffmpeg repair page if it exists outside this zip
- any stream-archiving or music-extension companion tools

That does not break the overall architecture explanation, but it is useful to know when looking at the links.

---

## Summary

This setup is a client-side media ecosystem built around a static server.

The strongest parts are:

- the clean split between phone browsing and TV viewing
- the generated library/loaders approach
- the profile-aware state system
- the maintenance tools
- the fact that everything stays usable even without a traditional backend app

The project has a real identity, not just a collection of pages.


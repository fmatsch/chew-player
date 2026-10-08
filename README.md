<p align="center">
  <img src="assets/logo.svg" width="112" alt="Chew Player logo">
</p>

<h1 align="center">Chew Player</h1>

<p align="center">
  A simple, folder-based music player for macOS and Windows — the way music players used to be.<br>
  <a href="https://fmatsch.github.io/chew-player/">Website</a> ·
  <a href="https://github.com/fmatsch/chew-player/releases/latest">Download</a>
</p>

<p align="center">
  <img src="docs/screenshots/albums-dark.png" width="820" alt="Chew Player album view">
</p>

## Why

Your music lives in folders. Chew Player reads those folders and plays what's in them. No store, no
cloud, no subscription. It never moves, renames or rewrites your files.

## Features

Chew Player has two sides, **Music** and **Video**. You switch between them at the top of the sidebar.
Both work the same way: you point the app at folders, and it fills in the details from open databases.

### Music

- **Folder-based library**: add one or more music folders. Chew Player scans them and picks up
  changes on every rescan. You can browse by **Songs**, **Albums**, **Artists** or the actual
  **Folders** on disk.
- **Plays almost anything**: MP3, AAC/M4A, FLAC, Ogg Vorbis, Opus and WAV play natively. ALAC, AIFF,
  WMA, APE, WavPack, Musepack, DSD (DSF/DFF), TTA, AC3, MKA and more are decoded on the fly by the
  bundled FFmpeg.
- **Fills in missing info**: tags are read from the files first. If they're missing, Chew Player
  guesses them from the classic `Artist/Album (Year)/01 - Title` layout and then looks them up in the
  open [MusicBrainz](https://musicbrainz.org) database. Album art comes from embedded pictures, from
  `cover.jpg`/`folder.jpg` in the folder, or from the [Cover Art Archive](https://coverartarchive.org).
- **Playlists**: create, rename and reorder them by drag and drop. Import and export them as `.m3u`/`.m3u8`.
- **Smart playlists**: rule-based lists that update themselves, such as "rated 4+ stars and not played in 3 months".
  You can match all or any rules on title, artist, genre, year, rating, plays, last played, date added, length,
  format and more, and limit a list to e.g. 50 songs picked at random or by most played. Chew Player starts you
  off with *Top Rated*, *Recently Added*, *Most Played* and *Never Played*.
- **Ratings and play counts**: click the stars in the song list. A song counts as played once you have heard half
  of it (at most 4 minutes).
- **Queue, shuffle and repeat**: "Play Next", "Add to Queue", repeat all or repeat one.
- **Gapless playback**: tracks flow into each other without a pause, which matters for live and concept albums.
- **Volume leveling**: uses the ReplayGain (and Opus R128) values stored in your files. You can choose track, album or
  "smart" mode, which uses album gain when playing in order and track gain when shuffling. Peaks are protected from clipping.
- **Output device selection**: play through a USB DAC, headphones or any other device without changing the system default.
- **Watches your folders**: new, changed or deleted files are picked up automatically.
- **Picks up where you left off**: the queue and playback position are restored after a restart.
- **Updates**: on Windows, new versions download in the background and install on restart. On macOS you get a
  notification with a download link, because auto-installing needs a paid Apple signing certificate.
- **Edit info**: correct tags for one song or many at once. Your edits are stored in Chew Player's
  library, so the files themselves stay untouched.
- **Flat, quiet design**: light and dark themes that follow the system, and media keys.

### Video

- **Movies and TV shows from your folders**: Chew Player recognises movies (`Heat (1995)/…`, `The.Matrix.1999.1080p…`)
  and episodes (`Show S01E02`, `Show 1x02`, `Show/Season 1/02 Title`) from file and folder names. Extras and
  sample files are skipped.
- **Posters and descriptions**: TV shows come from [TVMaze](https://www.tvmaze.com), including episode titles,
  summaries and stills. Movies come from [Wikidata](https://www.wikidata.org) and Wikipedia, with poster,
  year, genre, director and a plot summary in your system language. Local `poster.jpg`/`folder.jpg` files are used
  first. None of this needs an account or API key.
- **Plays almost anything**: MP4/MOV/WebM play natively. MKV and other containers are re-wrapped on the fly.
  AVI, WMV, MPEG-2, DivX and other old formats are converted to H.264 live with FFmpeg, and seeking still works.
- **Subtitles and audio tracks**: embedded text subtitles and `.srt`/`.vtt`/`.ass` files next to the video,
  plus switching between audio languages.
- **Remembers where you stopped**: the Home screen shows *Continue Watching*, *Up Next* (the next episode of
  shows you are watching) and *Recently Added*. Videos count as watched at 92 %.
- **Standard player controls**: ±10 s skip, playback speed, Picture in Picture, full screen, next episode,
  and keyboard shortcuts (Space, ←/→, ↑/↓, F, M, C, Shift+N, Esc).
- **Video playlists and smart playlists**, e.g. "unwatched movies in 4K added this month".

### Convert and copy to devices

Right-click songs, albums, artists, folders, playlists or videos:

- **Convert…** saves copies as **MP3** (320/256/192/128 kbps) or **MP4** (original quality, 1080p,
  720p or 480p, H.264/AAC). MP3s get the library's tags (including your corrections) and the cover art.
- **Copy to Device…** puts them on a connected **MP3 player, SD card or USB stick**, as they are or
  converted on the way (many players can't play FLAC or M4A). You can choose Artist/Album or Show/Season
  folders, or keep everything in one folder. Chew Player shows the size and free space first, warns about
  the 4 GB limit of FAT32 cards, removes the hidden `._` files macOS leaves on such cards, and offers to
  eject the device when it's done.

### Play on your TV

The cast button (in the video player and in the music player bar) sends the current video or song to a TV
on your network. Chew Player streams it from your computer and converts it on the fly if the TV can't play the
format. Subtitles are burned into the picture.

| TV / device | How |
| --- | --- |
| **Apple TV** | AirPlay. The first time, the Apple TV shows a 4-digit code you enter once. |
| **Android TV / Google TV / Chromecast** | Google Cast, on any TV with "Chromecast built-in" (Sony, Philips, TCL, Nvidia Shield, …). |
| **Amazon Fire TV Stick** | Fire TV has no built-in receiver for computers. Install a free receiver app such as **AirScreen** (AirPlay/Cast/DLNA) or **Kodi** (enable *Settings → Services → UPnP/DLNA → Allow remote control*), and the Fire TV shows up as a DLNA or AirPlay target. |
| **Smart TVs** (Samsung, LG, Panasonic, …) | DLNA/UPnP. |

## Download

Get the latest build from the [Releases page](https://github.com/fmatsch/chew-player/releases/latest):

| Platform | File |
| --- | --- |
| macOS (Apple Silicon) | `Chew-Player-mac-arm64.dmg` |
| macOS (Intel) | `Chew-Player-mac-x64.dmg` |
| Windows 10/11 (64-bit) | `Chew-Player-win-x64.exe` |

> **Note:** the builds are not notarised or code-signed with a paid certificate yet.
> - **macOS:** the first time, right-click the app and choose **Open**. If macOS says the app is
>   damaged, run `xattr -cr "/Applications/Chew Player.app"`.
> - **Windows:** SmartScreen may warn you. Click **More info → Run anyway**.

## Usage

1. Start Chew Player and click **Add Music Folder** (or drag a folder onto the window).
2. Wait for the scan to finish. Missing tags and album art are looked up in the background, and
   you can turn that off in **Settings**.
3. Double-click a song to play it. Right-click songs, albums or folders to queue them or add them
   to a playlist. You can also drag songs onto a playlist in the sidebar.

| Shortcut | Action |
| --- | --- |
| <kbd>Space</kbd> | Play / pause |
| <kbd>⌘/Ctrl</kbd> + <kbd>→</kbd> / <kbd>←</kbd> | Next / previous |
| <kbd>⌘/Ctrl</kbd> + <kbd>↑</kbd> / <kbd>↓</kbd> | Volume |
| <kbd>⌘/Ctrl</kbd> + <kbd>F</kbd> | Search |
| <kbd>⌘/Ctrl</kbd> + <kbd>O</kbd> | Add music folder |
| <kbd>⌘/Ctrl</kbd> + <kbd>N</kbd> | New playlist |
| <kbd>⌘/Ctrl</kbd> + <kbd>R</kbd> | Rescan library |
| <kbd>Enter</kbd> / <kbd>Delete</kbd> | Play selection / remove from playlist or queue |

## Development

Chew Player is an [Electron](https://www.electronjs.org) app written in plain JavaScript, with no
framework and no build step for the UI.

```bash
npm install
npm start            # run the app
npm run dist:mac     # build a .dmg into dist/
npm run dist:win     # build a Windows installer into dist/
npm run icons        # re-render the PNG icons from assets/*.svg
```

Project layout:

```
src/main/main.js      window, menus, IPC and the chew:// media protocol (byte ranges + FFmpeg streaming)
src/main/library.js   folder scanning, tag reading (music-metadata), playlists, JSON persistence
src/main/online.js    MusicBrainz + Cover Art Archive lookups (rate-limited to 1 req/s)
src/main/ffmpeg.js    FFmpeg discovery and on-the-fly decoding/remuxing for audio, video and subtitles
src/main/video-*.js   video library: scanning, file-name parsing, TVMaze/Wikidata lookups
src/main/cast/        casting: LAN media server (HLS/MPEG-TS), discovery, AirPlay (HAP pairing), Google Cast, DLNA
src/main/updater.js   update checks (electron-updater on Windows, GitHub release check on macOS)
src/renderer/         the UI: views, virtualised track table, Web Audio player engine (gapless, ReplayGain)
docs/                 the GitHub Pages website
```

The library is stored as JSON in the app's user-data folder
(`~/Library/Application Support/Chew Player` on macOS, `%APPDATA%\Chew Player` on Windows).

For testing, `CHEW_USER_DATA=/some/dir` runs the app with a separate profile, and
`CHEW_CAPTURE=shot.png` saves a screenshot after start-up and quits.

Releases are built by GitHub Actions when you push a `v*` tag.

## License

[MIT](LICENSE). Binary releases include FFmpeg, which is licensed under the GPL.
Metadata comes from MusicBrainz (CC0) and cover art from the Cover Art Archive.

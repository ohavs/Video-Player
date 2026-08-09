# Video Player

A desktop video player for local files, built around one idea: **marking a moment should cost
nothing**. Press one key and a bookmark lands at exactly the second you were on, with a text
field right there to label it. The marks then split the timeline into chapters you can jump
between.

Electron + vanilla JS. No framework, no build step for the app itself.

## Installing it as a real application

Build the installer once, then it behaves like any other installed program —
Start Menu and desktop shortcuts, no terminal, and it updates itself from then on.

```powershell
npm install
npm run dist
```

That writes `dist\VideoPlayer-Setup-<version>.exe`. Run it. It installs per-user, so it
needs no administrator rights.

Windows will show a SmartScreen warning ("unknown publisher") because the build is not code
signed — click **More info → Run anyway**. Removing that warning requires a paid code-signing
certificate; nothing in the app depends on it.

### Updates

The welcome screen always shows the running version and the state of the last update check:
*Checking…*, *Up to date*, *Downloading — 42%*, *Version X is ready* with a **Restart & update**
button, or the reason a check failed with **Try again**. It is the one place that answers
"which version am I actually on, and is something waiting?" without opening a menu.

The check runs a few seconds after launch — or thirty seconds in, if the app was launched
straight into a video, so the ~120MB download does not compete with playback — and then every
six hours. The periodic re-check matters: a player left open for days would otherwise never
notice a version published while it was running.

New versions download in the background and install when you next quit. Settings (⚙) →
**Check for updates** forces a check too.

Publishing a new version:

```bash
npm version patch
git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`, which builds the installer on Windows and
attaches it to a GitHub Release — the same feed the installed app reads.

Two requirements for updates to reach users: the repository must be **public** (an unsigned
update check sends no credentials), and each release needs a version number higher than the
installed one.

### Running from source

```bash
npm install
npm start
```

Updates are disabled in this mode — there is no release feed to check against, and the settings
row says so rather than failing quietly.

## What it does

**Playback** — play/pause, seek, volume, ten playback speeds (0.25×–3×), loop, fullscreen,
picture-in-picture, frame-by-frame stepping. Frame stepping measures the file's real frame rate
via `requestVideoFrameCallback` instead of assuming 30fps, so it is accurate on 24 and 60fps
footage.

**Bookmarks** — the reason this exists.

- Press the bookmark key (default <kbd>B</kbd>) at any point. The timestamp is captured at the
  *keypress*, not when you finish typing, so the mark lands where you were.
- A field opens inline, already focused. Type a label, <kbd>Enter</kbd> saves, <kbd>Esc</kbd>
  cancels. Clicking away saves rather than discards.
- **Capture offset** (Settings → Bookmarks) marks N seconds *before* the keypress, because you
  always react a moment late.
- Marks render on the timeline in one of two styles: **Chapters** splits the bar into segments
  with a gap at each mark, and hovering shows that chapter's title — or **Markers**, a
  continuous bar with a tick per mark.
- The current chapter's name shows in the control bar. `[` and `]` jump between marks.
- Bookmarks persist per file and survive reopening. Export to JSON from the list panel.

**Keyboard** — every shortcut is rebindable in Settings → Keyboard shortcuts. Click a row, press
the key you want; if it is already taken, it is moved and you are told which action lost it.

Bindings are stored against the **physical key** (`event.code`), not the character it produces,
so they keep working when you switch keyboard layout — a binding on `B` still fires when typing
in Hebrew.

Defaults follow the conventions most players share:

| | |
|---|---|
| <kbd>Space</kbd> / <kbd>K</kbd> | play / pause |
| <kbd>←</kbd> <kbd>→</kbd> | skip 5s (configurable) |
| <kbd>J</kbd> <kbd>L</kbd> | skip 10s (configurable) |
| <kbd>,</kbd> <kbd>.</kbd> | previous / next frame |
| <kbd>Shift</kbd>+<kbd>,</kbd> / <kbd>.</kbd> | slower / faster |
| <kbd>↑</kbd> <kbd>↓</kbd> | volume |
| <kbd>M</kbd> / <kbd>F</kbd> / <kbd>I</kbd> | mute / fullscreen / picture-in-picture |
| <kbd>0</kbd>–<kbd>9</kbd> | jump to 0%–90% |
| <kbd>B</kbd> | add bookmark |
| <kbd>[</kbd> <kbd>]</kbd> | previous / next bookmark |
| <kbd>C</kbd> | trim & export |
| <kbd>Shift</kbd>+<kbd>I</kbd> / <kbd>O</kbd> | set clip start / end |
| <kbd>Page Up</kbd> / <kbd>Page Down</kbd> | previous / next video in the folder |

Editors conventionally put in and out on bare <kbd>I</kbd> and <kbd>O</kbd>, but <kbd>I</kbd>
already toggles picture-in-picture here and quietly reassigning it would break keymaps people
had already saved. Both are rebindable if you want them bare.

**Trim & export** — cut a clip out of the open file and save it.

- <kbd>C</kbd> or the ✂ button enters trim mode. Two handles appear on the timeline and
  everything outside them dims: what stays lit is what you get.
- If you open trim while inside a bookmark chapter, that chapter is already selected. Mark the
  moment while watching, then cut it without hunting for it twice.
- Drag the handles, or press **Set** to move a mark to the playhead
  (<kbd>Shift</kbd>+<kbd>I</kbd> / <kbd>Shift</kbd>+<kbd>O</kbd>). Arrow keys nudge a focused
  handle; hold <kbd>Shift</kbd> for a coarser step.
- Two modes:
  - **Fast** copies the streams without re-encoding — seconds to finish, output identical to the
    source. The cut lands on the nearest keyframe, so a clip can begin *early*. Never late: the
    moment you marked is always inside the result.
  - **Exact** re-encodes to cut on the precise frame. Slower, slightly lossy.
- **The two usually look the same, and the app says so with a number.** How early a fast cut
  starts depends entirely on how far apart that file's keyframes are — often a fraction of a
  second, sometimes several. So the result is measured off the finished file and reported:
  *Clip saved · 539 KB · starts 2.0s early (nearest keyframe)*. An exact cut has nothing to
  report and says nothing. Pick Fast unless that number matters to you.
- A clip taken from a titled chapter is offered that title as its filename.

**Stepping through a folder** — open one video and the others beside it are one click away.

- Arrows appear at the left and right edges, and fade with the rest of the chrome when the
  pointer rests. <kbd>Page Up</kbd> / <kbd>Page Down</kbd> do the same.
- Only rendered when there is actually a file in that direction: the last video has no next
  arrow, and a video alone in its folder grows no arrows at all.
- The top bar shows the position in the set (*3 / 12*).
- Ordering is numeric — `clip9` comes before `clip10`, the order the file manager shows, not the
  order plain string sorting would give.
- The folder is re-read on every open, so files added or removed while the app is running are
  picked up rather than navigated from a stale list.

**Opening files** — file dialog, drag and drop anywhere in the window, "Open with" from the OS,
or the recent list on the welcome screen (which shows how many bookmarks each file has).
Playback position is remembered per file.

## Codec support

Playback uses Chromium's decoders. **MP4/H.264/AAC and WebM/VP8/VP9 play directly.** MKV
containers, H.265/HEVC and AC3 audio generally do not.

When a file cannot be decoded, the player says so and offers **Make a playable copy**, which
re-encodes it to H.264/AAC MP4 with the bundled engine and opens the result. The original is
never touched.

### The bundled engine

Trimming and conversion use a static [ffmpeg](https://ffmpeg.org) binary shipped inside the app,
rather than one the user is expected to install. It is unpacked out of the asar archive at build
time (`asarUnpack`) because nothing can be executed from inside an archive, and it is located at
runtime by `src/main/ffmpeg.js`.

This is what makes the installer large — roughly 180 MB against 100 MB without it. That is the
whole cost of the feature, and it is paid once at install.

`ffmpeg-static` ships a **GPL-3.0** build of ffmpeg. The app invokes it as a separate process
rather than linking against it, so the app's own MIT licence stands, but any installer you
distribute contains GPL software and carries that obligation with it. The upstream licence text
travels inside the package.

## Files with a broken duration header

Many recorders — dashcams especially — write a container header whose duration is wrong, or
whose timeline does not start at zero. Such a file will report a duration of hundreds of hours
while a 60-second clip plays.

The player never trusts `duration`. It derives the timeline from `seekable`, which reports what
the decoder will actually let you reach, and applies the offset in one place (`Player`), so
every other module works in display time starting at 0. Bookmarks are stored in that same
display time and stay correct.

## Layout

```
src/
  main/
    main.js       Electron entry: window, menu, file handling, media:// protocol
    preload.js    the entire renderer↔Node bridge (no raw ipc reaches the page)
    store.js      atomic JSON persistence in userData
    ffmpeg.js     finds and runs the bundled binary; progress stream, duration probe
    clips.js      the export jobs (trim, convert) — one slot, cancellable
  renderer/
    index.html
    styles/       base.css (tokens, shell) · player.css (controls) · panels.css
    js/
      app.js        coordinator — the only file that decides what an action does
      player.js     <video> wrapper
      controls.js   control bar
      progress.js   the scrubber: buffered ranges, hover, drag, chapter segments
      bookmarks.js  bookmark model + the inline composer
      trim.js       the trim bar and export progress
      panels.js     settings menu, shortcuts editor, bookmark list
      keyboard.js   global shortcut dispatch
      keymap.js     bindings, defaults, conflict detection
      settings.js   preferences with validation
      format.js     time formatting
      icons.js      the icon set, drawn/generated here
scripts/
  drive.js        launches the real app under Xvfb, drives it with synthetic
                  input, asserts behaviour and captures screenshots
  drive-trim.js   the same, for trim mode and a real export to disk
  drive-folder.js the same, for stepping between videos in one folder
```

Clicks and keypresses both resolve to the same action ids, dispatched in one `switch` in
`app.js`, so the two input paths cannot drift apart.

## Verifying

Both drivers boot the actual app — nothing stubbed — and assert against what really happens.

`scripts/drive.js` covers **29 behaviours**: media loads over the custom protocol with working
byte-range seeking, the composer captures the right timestamp, four bookmarks produce five
timeline segments, hover tooltips carry chapter titles, submenus navigate, a rebound key starts
working while the old one stops, a lying duration header falls back to `seekable`, and bookmarks
reach disk and come back after a restart.

`scripts/drive-trim.js` covers **32 more**, ending in files on disk whose durations are measured
back with ffmpeg: a fast cut keeps the whole marked range and reports how much earlier it really
starts, an exact cut is frame accurate and reports nothing, the handles refuse to cross, a
chapter preselects the cut and names the file, an H.265 MKV converts and then plays, and backing
out of the save dialog changes nothing. The only stub is the native save dialog, which synthetic
input cannot answer.

`scripts/drive-folder.js` covers **16 more** for folder navigation: both arrows appear only when
there is somewhere to go, `clip10` sorts after `clip9`, the position tracks, walking off either
end explains itself, a lone video grows no arrows, and the arrows fade with the chrome.

```bash
VP_VIDEO=/path/to/clip.mp4 VP_SHOT_DIR=/tmp/shots \
  xvfb-run -a ./node_modules/.bin/electron --no-sandbox --disable-gpu scripts/drive.js

VP_VIDEO=/path/to/clip.mp4 VP_VIDEO_UNPLAYABLE=/path/to/x265.mkv VP_SHOT_DIR=/tmp/shots \
  xvfb-run -a ./node_modules/.bin/electron --no-sandbox --disable-gpu scripts/drive-trim.js

VP_FOLDER=/dir/with/several VP_ALONE=/dir/with/one VP_SHOT_DIR=/tmp/shots \
  xvfb-run -a ./node_modules/.bin/electron --no-sandbox --disable-gpu scripts/drive-folder.js
```

Both write into the default user data directory. Pass `--user-data-dir=<tmp>` to run against a
clean profile — a previous run leaves rebound keys and library entries behind, which will fail
later runs for reasons that have nothing to do with the code.

## Not built

Subtitles, hover thumbnail previews on the scrubber, playlists, and audio track selection.
Thumbnails are the notable gap: unlike a streaming service there is no pre-generated storyboard,
so they have to be produced locally by seeking a hidden video into a canvas.

Trimming cuts **one clip at a time**. Exporting every bookmarked chapter in one pass is the
obvious next step and the engine already supports it — what is missing is a job queue and a
folder picker instead of a single save dialog.

This is a trimmer, not an editor. Joining clips, multiple tracks, transitions and titles all
need a document model and a compositor, which is a different program with a different shape.

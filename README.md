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

Updates install **silently**: the window closes and reopens on the new version, with no
installer wizard. There is nothing for that wizard to ask — the install location has been in the
registry since the first install — so every page of it was a Next button standing between the
user and the update they had just asked for.

The wizard still appears for the **first** install, where choosing a folder is a real choice
(`oneClick: false`). Only updates are silent.

One caveat inherent to how this works: `quitAndInstall` runs in the *outgoing* version, so the
silent flag takes effect from the first update installed **by** a build that has it — the update
that introduces it is still installed by the old, noisy code.

Publishing a new version:

```bash
npm version patch
git push --follow-tags
```

`.github/workflows/release.yml` builds the installer on Windows and attaches it to a GitHub
Release — the same feed the installed app reads.

The release is created *before* the build, not left to electron-builder. Its uploads run
concurrently and each one creates the release if it is absent, so two starting together means
one wins and the other gets `422 already_exists` and fails the publish. That is how v0.4.0 came
to carry its installer but not `latest.yml`, which made it invisible to the updater. A release
that already exists is never raced for.

The last step asserts that both `latest.yml` and the `.exe` are attached. A release missing the
feed file looks fine on the releases page while every installed copy reports "up to date"
forever — the one failure worth failing the build over.

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

**Playback** — play/pause, seek, volume, loop, fullscreen, picture-in-picture, frame-by-frame
stepping. Frame stepping measures the file's real frame rate via `requestVideoFrameCallback`
instead of assuming 30fps, so it is accurate on 24 and 60fps footage.

**The control bar carries the two things you adjust while watching**, rather than burying them
in a menu:

- **Skip buttons** flank play, drawn with their own amount inside them the way every streaming
  app draws them. The small gear beside them opens a tray: presets at 5/10/15/30/60 seconds, and
  a −/+ stepper for any other number. Change it and both arrows redraw. It is the same value the
  long-skip keys (<kbd>J</kbd> / <kbd>L</kbd>) use, so the button and the key can never disagree.
- **Speed** is a button showing the current rate, not a badge that only appears when something is
  wrong. Click it for all ten speeds (0.25×–3×). It turns yellow off 1×, because a player left at
  2× is a state worth noticing.

Both trays stay open after a choice — speed especially is something you compare rather than set
once, and a tray that closed on the first click would have to be reopened for every comparison.

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
- Renaming happens **in the list row**: click the pencil and the label becomes a field where it
  already sits. <kbd>Enter</kbd> saves, <kbd>Esc</kbd> discards, clicking away saves. It does not
  reuse the composer — that one is anchored to a position on the timeline, which the panel
  covers, so renaming from the list would open a field underneath the list.
- Deleting asks first — the row turns into **Delete? / Keep** in place, no dialog — and then
  stays undoable for five seconds, with the row holding its position in the list while a bar
  drains along it. The removal itself is immediate: the timeline mark goes, the chapters close
  up, the count drops. Confirming a deletion and watching nothing happen for five seconds would
  be worse than either. What the window buys is putting it back, not delaying it.
- Undo restores the original bookmark — same id, time, label and creation stamp — rather than
  adding a lookalike.
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
      popover.js    the small trays that hang off the control bar
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

`scripts/drive.js` covers **55 behaviours**: media loads over the custom protocol with working
byte-range seeking, the composer captures the right timestamp, four bookmarks produce five
timeline segments, hover tooltips carry chapter titles, submenus navigate, a rebound key starts
working while the old one stops, a bookmark renames inside its own row, a delete asks first and stays undoable for five seconds, the skip buttons move by the amount they display and keep
matching it after it is changed, picking a speed applies it and marks the button, dismissing a
tray does not also toggle playback, a lying duration header falls back to `seekable`, a failed
update check is stated rather than swallowed, and bookmarks reach disk and come back after a
restart.

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

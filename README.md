# Video Player

A desktop video player for local files, built around one idea: **marking a moment should cost
nothing**. Press one key and a bookmark lands at exactly the second you were on, with a text
field right there to label it. The marks then split the timeline into chapters you can jump
between.

Electron + vanilla JS. No framework, no build step for the app itself.

## Running it

```bash
npm install
npm start
```

To package a distributable (`dist/`):

```bash
npm run dist
```

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

**Opening files** — file dialog, drag and drop anywhere in the window, "Open with" from the OS,
or the recent list on the welcome screen (which shows how many bookmarks each file has).
Playback position is remembered per file.

## Codec support

Playback uses Chromium's decoders. **MP4/H.264/AAC and WebM/VP8/VP9 work.** MKV containers,
H.265/HEVC and AC3 audio generally will not — the player reports this clearly rather than
failing silently. Bundling FFmpeg would lift that limit and is the main thing standing between
this and "plays anything".

## Layout

```
src/
  main/
    main.js       Electron entry: window, menu, file handling, media:// protocol
    preload.js    the entire renderer↔Node bridge (no raw ipc reaches the page)
    store.js      atomic JSON persistence in userData
  renderer/
    index.html
    styles/       base.css (tokens, shell) · player.css (controls) · panels.css
    js/
      app.js        coordinator — the only file that decides what an action does
      player.js     <video> wrapper
      controls.js   control bar
      progress.js   the scrubber: buffered ranges, hover, drag, chapter segments
      bookmarks.js  bookmark model + the inline composer
      panels.js     settings menu, shortcuts editor, bookmark list
      keyboard.js   global shortcut dispatch
      keymap.js     bindings, defaults, conflict detection
      settings.js   preferences with validation
      format.js     time formatting
      icons.js      the icon set, drawn/generated here
scripts/
  drive.js        launches the real app under Xvfb, drives it with synthetic
                  input, asserts behaviour and captures screenshots
```

Clicks and keypresses both resolve to the same action ids, dispatched in one `switch` in
`app.js`, so the two input paths cannot drift apart.

## Verifying

`scripts/drive.js` boots the actual app — nothing stubbed — and checks 22 behaviours end to
end: media loads over the custom protocol with working byte-range seeking, the composer captures
the right timestamp, four bookmarks produce five timeline segments, hover tooltips carry chapter
titles, submenus navigate, a rebound key starts working while the old one stops, and bookmarks
reach disk.

```bash
VP_VIDEO=/path/to/clip.webm VP_SHOT_DIR=/tmp/shots \
  xvfb-run -a ./node_modules/.bin/electron --no-sandbox scripts/drive.js
```

## Not built

Subtitles, hover thumbnail previews on the scrubber, playlists, and audio track selection.
Thumbnails are the notable gap: unlike a streaming service there is no pre-generated storyboard,
so they have to be produced locally by seeking a hidden video into a canvas.

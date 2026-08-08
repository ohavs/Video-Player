// Coordinator. Owns the wiring, not the behaviour: every module below reports
// intent as an action id, and this file is the single place that decides what
// an action does to the player, the store and the UI.

import { Player } from './player.js';
import { Controls } from './controls.js';
import { Scrubber } from './progress.js';
import { KeyboardLayer } from './keyboard.js';
import { BookmarkStore, BookmarkComposer } from './bookmarks.js';
import { SettingsMenu, ShortcutsSheet, BookmarkPanel } from './panels.js';
import { TrimBar, describeResult } from './trim.js';
import { settings, SPEED_STEPS } from './settings.js';
import { bindingLabel } from './keymap.js';
import { icon } from './icons.js';
import { formatTime, formatSpeed, formatRelativeDate, clamp } from './format.js';

const el = (role) => document.querySelector(`[data-role="${role}"]`);

const dom = {
  app: document.getElementById('app'),
  stage: el('stage'),
  video: el('video'),
  pulse: el('pulse'),
  title: el('title'),
  toasts: el('toasts'),
  welcome: el('welcome'),
  openButton: el('openButton'),
  welcomeKey: el('welcomeKey'),
  recent: el('recent'),
  recentList: el('recentList'),
  recentClear: el('recentClear'),
  welcomeFoot: el('welcomeFoot'),
  welcomeVersion: el('welcomeVersion'),
  welcomeUpdate: el('welcomeUpdate'),
  chrome: el('chrome'),
  controlsHost: el('controls'),
  composerHost: el('composerHost'),
  trimHost: el('trimHost'),
  menuHost: el('menuHost'),
  panelHost: el('panelHost'),
  sheetHost: el('sheetHost'),
  dropVeil: el('dropVeil'),
  updateBar: el('updateBar'),
};

const player = new Player(dom.video);
const store = new BookmarkStore();

let currentFile = null;
let lastPaintedTime = -1;
let positionSaveAt = 0;
let idleTimer = null;
let suppressAutoHide = false;
let pendingResume = 0;   // resume point held until metadata gives us a duration

let clipsReady = false;  // is the bundled video engine actually present
let trimRange = null;    // { in, out } in display seconds while trimming
let activeJob = null;    // the export or conversion currently running

/* ================================================================== *
 * UI construction
 * ================================================================== */

const controls = new Controls(dom.controlsHost, {
  onAction: (action) => runAction(action),
  onVolumeInput: (level) => {
    player.volume = level;
    if (level > 0) player.muted = false;
    settings.patch({ volume: level, muted: player.muted });
  },
});

const scrubber = new Scrubber(controls.scrubberHost, {
  onSeek: (time) => {
    player.seek(time);
    paintTime(true);
  },
  onScrubStart: () => {
    suppressAutoHide = true;
  },
  onScrubEnd: () => {
    suppressAutoHide = false;
    wake();
  },
  onTrimStart: () => {
    suppressAutoHide = true;
  },
  onTrimDrag: (edge, time) => moveTrimEdge(edge, time),
  onTrimEnd: () => {
    suppressAutoHide = false;
    wake();
  },
});

const composer = new BookmarkComposer(dom.composerHost);

const trimBar = new TrimBar(dom.trimHost, {
  onCommand: (command, value) => runTrimCommand(command, value),
});

const menu = new SettingsMenu(dom.menuHost, {
  settings,
  onAction: (action, value) => {
    if (action === 'applySpeed') applySpeed(value);
    else if (action === 'openShortcuts') shortcuts.show();
    else if (action === 'checkUpdates') globalThis.host?.checkForUpdates();
    else if (action === 'installUpdate') globalThis.host?.installUpdate();
  },
});

const shortcuts = new ShortcutsSheet(dom.sheetHost, { settings });

const bookmarkPanel = new BookmarkPanel(dom.panelHost, {
  onJump: (id) => {
    const bookmark = store.byId(id);
    if (bookmark) {
      player.seek(bookmark.time);
      paintTime(true);
    }
  },
  onEdit: (id) => editBookmark(id),
  onDelete: (id) => {
    const bookmark = store.byId(id);
    if (!bookmark) return;
    store.remove(id);
    toast(`Removed ${formatTime(bookmark.time)}`);
  },
  onExport: () => exportBookmarks(),
});

const keyboard = new KeyboardLayer({
  onAction: (action) => runAction(action),
  onDigitSeek: (ratio) => {
    if (!currentFile) return;
    player.seekRatio(ratio);
    paintTime(true);
    flashPulse('seekForward');
  },
  // The shortcuts editor and the composer both own the keyboard while open.
  isBlocked: () => shortcuts.open || composer.isOpen,
});

/* ================================================================== *
 * Actions — the one place a behaviour is defined
 * ================================================================== */

function runAction(action) {
  if (action === 'openFile') {
    openViaDialog();
    return;
  }
  if (action === 'openShortcuts') {
    shortcuts.toggle();
    return;
  }
  if (action === 'openSettings') {
    menu.toggle();
    return;
  }
  if (!currentFile) return;

  switch (action) {
    case 'playPause':
      player.toggle();
      flashPulse(player.paused ? 'pause' : 'play');
      break;

    case 'seekBack':
      player.seekBy(-settings.get('shortSeek'));
      flashPulse('seekBack');
      break;
    case 'seekForward':
      player.seekBy(settings.get('shortSeek'));
      flashPulse('seekForward');
      break;
    case 'seekBackLong':
      player.seekBy(-settings.get('longSeek'));
      flashPulse('seekBack');
      break;
    case 'seekForwardLong':
      player.seekBy(settings.get('longSeek'));
      flashPulse('seekForward');
      break;
    case 'goStart':
      player.seek(0);
      break;
    case 'goEnd':
      player.seek(player.duration);
      break;

    case 'frameBack':
      player.stepFrame(-1);
      break;
    case 'frameForward':
      player.stepFrame(1);
      break;

    case 'volumeUp':
      player.adjustVolume(settings.get('volumeStep') / 100);
      persistVolume();
      toast(`Volume ${Math.round(player.effectiveVolume * 100)}%`);
      break;
    case 'volumeDown':
      player.adjustVolume(-settings.get('volumeStep') / 100);
      persistVolume();
      toast(`Volume ${Math.round(player.effectiveVolume * 100)}%`);
      break;
    case 'mute':
      player.toggleMute();
      persistVolume();
      break;

    case 'speedUp':
      stepSpeed(1);
      break;
    case 'speedDown':
      stepSpeed(-1);
      break;
    case 'speedReset':
      applySpeed(1);
      toast('Normal speed');
      break;

    case 'addBookmark':
      addBookmark();
      break;
    case 'nextBookmark':
      jumpBookmark(1);
      break;
    case 'prevBookmark':
      jumpBookmark(-1);
      break;
    case 'toggleBookmarkList':
      bookmarkPanel.toggle();
      controls.setBookmarkListOpen(bookmarkPanel.open);
      break;

    case 'toggleTrim':
      if (trimRange) closeTrim();
      else openTrim();
      break;
    // Placing a mark is also a way into trim mode: pressing "set clip start"
    // while not trimming should start the cut, not do nothing.
    case 'trimIn':
      if (!trimRange) openTrim();
      if (trimRange) moveTrimEdge('in', player.currentTime);
      break;
    case 'trimOut':
      if (!trimRange) openTrim();
      if (trimRange) moveTrimEdge('out', player.currentTime);
      break;

    case 'fullscreen':
      player.enterFullscreen(dom.stage);
      break;
    case 'pip':
      player.togglePip();
      break;

    default:
      break;
  }

  wake();
}

/* ================================================================== *
 * Bookmarks
 * ================================================================== */

function addBookmark() {
  if (!currentFile) return;

  // The timestamp is taken at the keypress, never at save time — the whole
  // promise of the feature is that the mark lands where you were, not where the
  // video drifted to while you typed.
  const offset = settings.get('bookmarkOffset');
  const time = clamp(player.currentTime - offset, 0, player.duration || 0);

  const wasPlaying = !player.paused;
  const shouldPause = settings.get('pauseWhileAdding');
  if (shouldPause) player.pause();
  suppressAutoHide = true;

  composer.show({
    time,
    anchorRatio: player.duration ? time / player.duration : 0,
    onCommit: ({ text }) => {
      const bookmark = store.add(time, text);
      toast(`Bookmark <strong>${formatTime(time)}</strong>${text ? ` · ${escapeText(text)}` : ''}`, { html: true });
      if (settings.get('jumpToBookmarkOnSave')) player.seek(bookmark.time);
      finishComposing(wasPlaying && shouldPause);
    },
    onCancel: () => finishComposing(wasPlaying && shouldPause),
  });
}

function editBookmark(id) {
  const bookmark = store.byId(id);
  if (!bookmark) return;

  const wasPlaying = !player.paused;
  const shouldPause = settings.get('pauseWhileAdding');
  if (shouldPause) player.pause();
  suppressAutoHide = true;

  composer.show({
    time: bookmark.time,
    text: bookmark.text,
    editingId: id,
    anchorRatio: player.duration ? bookmark.time / player.duration : 0,
    onCommit: ({ text }) => {
      store.update(id, { text });
      finishComposing(wasPlaying && shouldPause);
    },
    onCancel: () => finishComposing(wasPlaying && shouldPause),
  });
}

function finishComposing(resume) {
  suppressAutoHide = false;
  if (resume) player.play();
  wake();
}

function jumpBookmark(direction) {
  const bookmark = direction > 0 ? store.next(player.currentTime) : store.previous(player.currentTime);
  if (!bookmark) {
    toast(direction > 0 ? 'No later bookmark' : 'No earlier bookmark');
    return;
  }
  player.seek(bookmark.time);
  paintTime(true);
  toast(`${formatTime(bookmark.time)}${bookmark.text ? ` · ${escapeText(bookmark.text)}` : ''}`);
}

function exportBookmarks() {
  if (!store.count) {
    toast('Nothing to export yet');
    return;
  }
  const payload = JSON.stringify(store.export(), null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(currentFile?.name || 'bookmarks').replace(/\.[^.]+$/, '')}-bookmarks.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${store.count} bookmark${store.count === 1 ? '' : 's'}`);
}

store.subscribe((items) => {
  scrubber.setBookmarks(items);
  scrubber.setSegments(store.segments(player.duration));
  bookmarkPanel.setItems(items);
  controls.setBookmarkCount(items.length);
  updateChapter(true);
});

/* ================================================================== *
 * Trimming
 * ================================================================== */

// A clip shorter than this is not a clip, and ffmpeg would reject it anyway.
const MIN_CLIP = 0.1;

// Opening trim inside a chapter selects that chapter. It is the reason the
// bookmarks exist: you marked the moment while watching, so the cut should
// already be scoped to it rather than making you find it twice.
function chapterRangeAt(time) {
  const segments = store.segments(player.duration);
  if (segments.length < 2) return null;
  const found = segments.find((s) => time >= s.start && time < s.end) || segments[segments.length - 1];
  return { in: found.start, out: found.end };
}

function openTrim() {
  if (!currentFile || !clipsReady) return;
  const duration = player.duration;
  if (!duration) {
    toast('This file has no readable length to cut.');
    return;
  }

  trimRange = chapterRangeAt(player.currentTime) || { in: 0, out: duration };
  trimBar.setMode(settings.get('trimMode'));
  trimBar.show();
  controls.setTrimOpen(true);
  syncTrim();
  requestAnimationFrame(liftToasts);
  wake();
}

function closeTrim() {
  // A running job owns the bar, so leaving trim mode must not pull it out from
  // under the progress the user is watching.
  if (activeJob) {
    toast('Cancel the export first');
    return;
  }
  trimRange = null;
  trimBar.hide();
  controls.setTrimOpen(false);
  scrubber.setTrim(null);
  liftToasts();
  wake();
}

function syncTrim() {
  scrubber.setTrim(trimRange);
  if (trimRange) trimBar.setRange(trimRange, player.duration);
}

// Measured rather than guessed: the bar is one line taller when the note wraps,
// and a hardcoded offset would leave the toast overlapping it at some widths.
function liftToasts() {
  const lift = trimBar.open ? trimBar.root.offsetHeight + 8 : 0;
  dom.app.style.setProperty('--stack-lift', `${lift}px`);
}

// A selection belongs to one file's timeline, so it cannot survive opening
// another. An export already running keeps the bar until it reports back.
function resetTrimForNewFile() {
  trimRange = null;
  scrubber.setTrim(null);
  controls.setTrimOpen(false);
  if (!activeJob) trimBar.hide();
  liftToasts();
}

function moveTrimEdge(edge, time) {
  if (!trimRange) return;
  const duration = player.duration;
  let next = clamp(time, 0, duration);

  // The handles are not allowed to cross; each stops a hair short of the other.
  if (edge === 'in') next = Math.min(next, trimRange.out - MIN_CLIP);
  else next = Math.max(next, trimRange.in + MIN_CLIP);

  trimRange[edge] = clamp(next, 0, duration);
  syncTrim();
}

function runTrimCommand(command, value) {
  if (command === 'close') {
    closeTrim();
    return;
  }
  if (command === 'cancel') {
    globalThis.host?.cancelClip();
    return;
  }
  if (!trimRange) return;

  switch (command) {
    case 'setIn':
      moveTrimEdge('in', player.currentTime);
      break;
    case 'setOut':
      moveTrimEdge('out', player.currentTime);
      break;
    case 'gotoIn':
      player.seek(trimRange.in);
      paintTime(true);
      break;
    case 'gotoOut':
      player.seek(trimRange.out);
      paintTime(true);
      break;
    case 'mode':
      settings.set('trimMode', value);
      trimBar.setMode(settings.get('trimMode'));
      break;
    case 'export':
      exportClip();
      break;
    default:
      break;
  }
  wake();
}

// "0m10s" / "1h02m30s" — a stamp that survives being part of a filename on
// every platform, which "0:10" does not on Windows.
function compactStamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}h${pad(m)}m${pad(s)}s` : `${m}m${pad(s)}s`;
}

function suggestedClipName() {
  const base = (currentFile?.name || 'clip').replace(/\.[^.]+$/, '');
  // When the selection is exactly a titled chapter, that title is a far better
  // filename than a pair of timestamps.
  const chapter = chapterRangeAt(trimRange.in + 0.01);
  const title = store.activeAt(trimRange.in + 0.01)?.text;
  const matchesChapter =
    chapter && Math.abs(chapter.in - trimRange.in) < 0.05 && Math.abs(chapter.out - trimRange.out) < 0.05;

  if (matchesChapter && title) return `${base} - ${title}`;
  return `${base} - ${compactStamp(trimRange.in)} to ${compactStamp(trimRange.out)}`;
}

async function exportClip() {
  if (!trimRange || !currentFile || activeJob) return;

  const mode = settings.get('trimMode');
  // A stream copy keeps the original streams, so it has to stay in a container
  // that accepts them; a re-encode always produces H.264 and lands in MP4.
  const sourceExtension = (currentFile.name.match(/\.([^.]+)$/)?.[1] || 'mp4').toLowerCase();
  const extension = mode === 'exact' ? 'mp4' : sourceExtension;

  const result = await globalThis.host?.exportClip({
    input: currentFile.path,
    start: trimRange.in,
    end: trimRange.out,
    mode,
    extension,
    suggestedName: suggestedClipName(),
  });

  reportJobResult(result);
}

async function convertCurrent() {
  if (!currentFile || activeJob) return;

  const base = currentFile.name.replace(/\.[^.]+$/, '');
  const result = await globalThis.host?.convertFile({
    input: currentFile.path,
    totalSeconds: player.duration || 0,
    suggestedName: `${base} (playable)`,
  });

  reportJobResult(result, {
    onDone: (output) => openPath(output),
  });
}

function reportJobResult(result, { onDone } = {}) {
  if (!result || result.status === 'canceled') return;

  if (result.status === 'error') {
    toast(result.message || 'The export failed.', { duration: 8000 });
    return;
  }
  if (result.status !== 'done') return;

  toast(describeResult(result), {
    duration: 8000,
    action: {
      label: 'Show file',
      onClick: () => globalThis.host?.revealFile(result.output),
    },
  });
  onDone?.(result.output);
}

/* ================================================================== *
 * Speed and volume
 * ================================================================== */

function applySpeed(rate) {
  player.rate = rate;
  controls.setRate(rate);
  settings.set('defaultSpeed', rate);
}

function stepSpeed(direction) {
  const current = player.rate;
  const index = SPEED_STEPS.findIndex((step) => Math.abs(step - current) < 0.001);
  let next;
  if (index === -1) {
    next = direction > 0
      ? SPEED_STEPS.find((step) => step > current) ?? SPEED_STEPS[SPEED_STEPS.length - 1]
      : [...SPEED_STEPS].reverse().find((step) => step < current) ?? SPEED_STEPS[0];
  } else {
    next = SPEED_STEPS[clamp(index + direction, 0, SPEED_STEPS.length - 1)];
  }
  applySpeed(next);
  toast(formatSpeed(next));
}

function persistVolume() {
  settings.patch({ volume: player.volume, muted: player.muted });
}

/* ================================================================== *
 * Opening files
 * ================================================================== */

async function openViaDialog() {
  try {
    const file = await globalThis.host?.openFileDialog();
    if (file) openFile(file);
  } catch (err) {
    console.error('[app] open dialog failed', err);
  }
}

async function openFile(file) {
  if (!file?.url) return;

  await store.flush();
  currentFile = file;
  resetTrimForNewFile();

  dom.app.dataset.state = 'loaded';
  dom.title.textContent = file.name;
  document.title = `${file.name} — Video Player`;

  controls.setEnabled(true);
  player.load(file);

  const { resumePosition } = await store.attach(file);
  pendingResume = settings.get('rememberPosition') ? resumePosition : 0;

  // Without "remember speed", every file starts at 1× no matter what the last
  // one was left on — otherwise a 2× session silently follows you around.
  applySpeed(settings.get('rememberSpeed') ? settings.get('defaultSpeed') : 1);
  player.loop = settings.get('loop');
  player.volume = settings.get('volume');
  player.muted = settings.get('muted');
  controls.setVolume(player.volume, player.muted);

  bookmarkPanel.setItems(store.list);
  controls.setBookmarkCount(store.count);
  wake();
}

async function openPath(filePath) {
  try {
    const file = await globalThis.host?.describeFile(filePath);
    if (file) openFile(file);
  } catch {
    toast('That file is no longer there');
    refreshRecent();
  }
}

/* ================================================================== *
 * Player events
 * ================================================================== */

player.on('loadedmetadata', () => {
  const duration = player.duration;
  scrubber.setDuration(duration);
  scrubber.setSegments(store.segments(duration));
  store.setMeta({ duration });
  controls.setTime(0, duration);

  // Only offer a resume that is meaningfully into the video and not effectively
  // at the end, where it would just replay the credits.
  const threshold = settings.get('resumeThreshold');
  if (pendingResume > threshold && pendingResume < duration - 10) {
    player.seek(pendingResume);
    toast(`Resumed at ${formatTime(pendingResume)}`);
  }
  pendingResume = 0;

  if (settings.get('autoplayOnOpen')) player.play();
});

player.on('durationchange', () => {
  scrubber.setDuration(player.duration);
  scrubber.setSegments(store.segments(player.duration));
});

player.on('play', () => {
  controls.setPlaying(true);
  startFrameLoop();
  wake();
});

player.on('pause', () => {
  controls.setPlaying(false);
  stopFrameLoop();
  paintTime(true);
  wake();
  savePosition(true);
});

player.on('ended', () => {
  controls.setPlaying(false);
  stopFrameLoop();
  controls.setEnded(true);
  wake();
});

player.on('ratechange', () => controls.setRate(player.rate));
player.on('volumechange', () => controls.setVolume(player.volume, player.muted));
player.on('progress', () => {
  // A growing seekable range can change the real duration mid-playback.
  scrubber.setDuration(player.duration);
  scrubber.setBufferedEnd(player.bufferedEnd());
});
player.on('seeked', () => paintTime(true));

player.on('error', () => {
  const code = dom.video.error?.code;
  // Code 4 is "this decoder cannot do it" — an MKV, or H.265, or anything else
  // Chromium declines. The bundled engine can re-encode a copy that it will
  // play, so the dead end becomes an offer rather than a shrug.
  const unsupported = code === 4;
  const canOffer = unsupported && clipsReady && Boolean(currentFile) && !activeJob;

  toast(
    unsupported
      ? 'This file cannot be played — the container or codec is not supported.'
      : 'Something went wrong loading this file.',
    {
      duration: canOffer ? 12000 : 6000,
      action: canOffer ? { label: 'Make a playable copy', onClick: () => convertCurrent() } : null,
    },
  );
  console.error('[app] media error', dom.video.error);
});

document.addEventListener('fullscreenchange', () => {
  controls.setFullscreen(Boolean(document.fullscreenElement));
  wake();
});

/* ================================================================== *
 * Frame loop
 * ================================================================== */

function paintTime(force = false) {
  const time = player.currentTime;
  if (!force && Math.abs(time - lastPaintedTime) < 0.03) return;
  lastPaintedTime = time;

  scrubber.setTime(time);
  controls.setTime(time, player.duration);
  updateChapter();

  if (!player.paused) savePosition(false);
}

function updateChapter(force = false) {
  const active = store.activeAt(player.currentTime);
  const title = active?.text || '';
  if (force || title !== updateChapter.last) {
    updateChapter.last = title;
    controls.setChapter(title);
    bookmarkPanel.setActive(active?.id || null);
  }
}
updateChapter.last = null;

function savePosition(immediate) {
  if (!currentFile || !settings.get('rememberPosition')) return;
  const now = Date.now();
  if (!immediate && now - positionSaveAt < 5000) return;
  positionSaveAt = now;
  store.setMeta({ position: player.currentTime, duration: player.duration });
}

// The frame loop runs only while something is actually playing. It used to run
// unconditionally, which — with backgroundThrottling disabled so playback stays
// smooth when unfocused — meant the app woke the CPU 60 times a second forever,
// including while sitting idle on the welcome screen.
let frameHandle = null;

function tick() {
  if (player.paused) {
    frameHandle = null;
    return;
  }
  paintTime();
  frameHandle = requestAnimationFrame(tick);
}

function startFrameLoop() {
  if (frameHandle === null) frameHandle = requestAnimationFrame(tick);
}

function stopFrameLoop() {
  if (frameHandle !== null) {
    cancelAnimationFrame(frameHandle);
    frameHandle = null;
  }
}

/* ================================================================== *
 * Stage interaction
 * ================================================================== */

dom.stage.addEventListener('pointerdown', (event) => {
  if (event.target.closest('.controls, .menu, .bookmarks-panel, .composer, .sheet')) return;
  if (menu.open) {
    menu.hide();
    return;
  }
  if (composer.isOpen) return;
  if (!currentFile) return;
  if (event.button !== 0) return;
  runAction('playPause');
});

dom.stage.addEventListener('dblclick', (event) => {
  if (event.target.closest('.controls, .menu, .bookmarks-panel, .composer, .sheet')) return;
  if (!currentFile) return;
  // The two pointerdowns of a double-click have already toggled play twice, so
  // playback is back where it started and this only has to handle fullscreen.
  runAction('fullscreen');
});

dom.openButton.addEventListener('click', () => openViaDialog());

/* ---- auto-hide ---- */

function wake() {
  dom.app.classList.remove('is-idle');
  if (idleTimer) clearTimeout(idleTimer);
  const delay = settings.get('hideControlsDelay');
  idleTimer = setTimeout(() => {
    const busy =
      suppressAutoHide ||
      player.paused ||
      !currentFile ||
      menu.open ||
      shortcuts.open ||
      composer.isOpen ||
      bookmarkPanel.open ||
      trimBar.open;
    if (!busy) dom.app.classList.add('is-idle');
  }, delay);
}

for (const event of ['pointermove', 'pointerdown', 'wheel']) {
  dom.stage.addEventListener(event, () => wake(), { passive: true });
}
window.addEventListener('keydown', () => wake());

// The trim bar reflows at narrow widths, which changes how far the toasts have
// to sit above it.
window.addEventListener('resize', () => liftToasts());

/* ---- drag and drop ---- */

let dragDepth = 0;

window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  dom.app.classList.add('is-dropping');
});

window.addEventListener('dragover', (event) => event.preventDefault());

window.addEventListener('dragleave', (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dom.app.classList.remove('is-dropping');
});

window.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  dom.app.classList.remove('is-dropping');

  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const filePath = globalThis.host?.getPathForFile(file);
  if (filePath) openPath(filePath);
});

/* ================================================================== *
 * Feedback
 * ================================================================== */

function toast(message, { duration = 2200, html = false, action = null } = {}) {
  const node = document.createElement('div');
  node.className = 'toast';

  const body = document.createElement('span');
  if (html) body.innerHTML = message;
  else body.textContent = message;
  node.appendChild(body);

  const dismiss = () => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 240);
  };

  if (action) {
    // Toasts are click-through by default; only one carrying an action opts in.
    node.classList.add('is-actionable');
    const button = document.createElement('button');
    button.className = 'toast-action';
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      clearTimeout(timer);
      dismiss();
      action.onClick?.();
    });
    node.appendChild(button);
  }

  dom.toasts.appendChild(node);
  const timer = setTimeout(dismiss, duration);
}

const PULSE_ICONS = {
  play: 'play',
  pause: 'pause',
  seekBack: 'seekBack',
  seekForward: 'seekForward',
};

function flashPulse(kind) {
  const name = PULSE_ICONS[kind];
  if (!name) return;
  dom.pulse.innerHTML = icon(name);
  dom.pulse.classList.remove('is-active');
  // Force a reflow so the animation restarts on rapid repeats.
  void dom.pulse.offsetWidth;
  dom.pulse.classList.add('is-active');
}

function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ================================================================== *
 * Update notice
 * ================================================================== */

// Dismissal is remembered per state, so waving away the download progress does
// not also hide the "ready to install" notice that follows it.
let updateDismissedFor = '';

function renderUpdateBar(state) {
  const key = `${state.status}:${state.version || ''}`;
  const relevant = state.status === 'downloading' || state.status === 'ready';

  if (!relevant || updateDismissedFor === key) {
    dom.updateBar.hidden = true;
    return;
  }

  dom.updateBar.classList.toggle('is-ready', state.status === 'ready');
  dom.updateBar.dataset.key = key;

  if (state.status === 'ready') {
    dom.updateBar.innerHTML = `
      <span class="update-text">
        <strong class="update-title">Update ready</strong>
        <span class="update-sub">Version ${escapeText(state.version)} installs when you restart</span>
      </span>
      <button class="update-install" data-cmd="install" type="button">Restart &amp; update</button>
      <button class="btn-icon" data-cmd="dismiss" type="button" aria-label="Later">${icon('close')}</button>
    `;
  } else {
    dom.updateBar.innerHTML = `
      <span class="update-text">
        <strong class="update-title">Downloading update</strong>
        <span class="update-sub">Version ${escapeText(state.version || '')} · ${state.percent || 0}%</span>
      </span>
      <button class="btn-icon" data-cmd="dismiss" type="button" aria-label="Hide">${icon('close')}</button>
      <span class="update-progress"><span style="width:${state.percent || 0}%"></span></span>
    `;
  }

  dom.updateBar.hidden = false;
}

// Bookmarks and settings live in userData, which the installer never touches —
// but anything still sitting in a debounce window has to reach disk first.
function installUpdateNow() {
  savePosition(true);
  Promise.all([store.flush(), settings.flush()])
    .catch(() => {})
    .finally(() => globalThis.host?.installUpdate());
}

dom.updateBar.addEventListener('click', (event) => {
  const cmd = event.target.closest('[data-cmd]')?.dataset.cmd;
  if (cmd === 'install') {
    installUpdateNow();
  } else if (cmd === 'dismiss') {
    dom.updateBar.hidden = true;
    updateDismissedFor = dom.updateBar.dataset.key || '';
  }
});

/* ---- the welcome screen's copy, which never hides ---- */

// The corner notice only appears while downloading or once ready. Every other
// state — checking, up to date, and above all *failed* — produced no visible
// output at all, so "no update showed up" and "the check errored" looked
// identical. Here they never do, and the running version is always on screen to
// answer "did it actually update?".
function renderWelcomeUpdate(state) {
  dom.welcomeVersion.textContent = state.appVersion ? `Version ${state.appVersion}` : '';

  const say = (text, action = null) => {
    dom.welcomeUpdate.textContent = '';
    if (text) {
      const label = document.createElement('span');
      label.className = 'welcome-update-text';
      label.textContent = text;
      dom.welcomeUpdate.appendChild(label);
    }
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = action.primary ? 'welcome-update-go' : 'welcome-update-link';
      button.dataset.cmd = action.cmd;
      button.textContent = action.label;
      dom.welcomeUpdate.appendChild(button);
    }
  };

  switch (state.status) {
    case 'checking':
      say('Checking for updates…');
      break;
    case 'downloading':
      say(`Downloading ${state.version || 'update'} — ${state.percent || 0}%`);
      break;
    case 'ready':
      say(`Version ${state.version} is ready`, { cmd: 'install', label: 'Restart & update', primary: true });
      break;
    case 'none':
      say('Up to date', { cmd: 'check', label: 'Check again' });
      break;
    case 'error':
      say(state.message ? `Update check failed: ${state.message}` : 'Could not check for updates',
        { cmd: 'check', label: 'Try again' });
      break;
    case 'disabled':
      say('Running from source — updates are off');
      break;
    default:
      say(null, { cmd: 'check', label: 'Check for updates' });
      break;
  }

  dom.welcomeUpdate.dataset.status = state.status || 'idle';
}

dom.welcomeUpdate.addEventListener('click', (event) => {
  const cmd = event.target.closest('[data-cmd]')?.dataset.cmd;
  if (cmd === 'install') installUpdateNow();
  else if (cmd === 'check') globalThis.host?.checkForUpdates();
});

/* ================================================================== *
 * Recent files
 * ================================================================== */

let recentItems = [];

async function refreshRecent() {
  try {
    recentItems = (await globalThis.host?.recentFiles(8)) || [];
  } catch (err) {
    console.error('[app] recent list failed', err);
    recentItems = [];
  }

  dom.recent.hidden = recentItems.length === 0;
  dom.recentClear.hidden = recentItems.length === 0;
  if (!recentItems.length) {
    // Hiding the container is not enough — the rows have to go, or the next
    // render starts from stale markup.
    dom.recentList.innerHTML = '';
    return;
  }

  dom.recentList.innerHTML = recentItems
    .map((item) => {
      const count = Array.isArray(item.bookmarks) ? item.bookmarks.length : 0;
      const badge = count ? `<span class="recent-badge" title="${count} bookmarks">${count}</span>` : '';
      return `<div class="recent-row" data-fingerprint="${escapeText(item.fingerprint)}">
        <button class="recent-open" type="button" data-path="${escapeText(item.path)}" title="${escapeText(item.path)}">
          <span class="recent-name">${escapeText(item.name || item.path)}</span>
          ${badge}
          <span class="recent-meta">${escapeText(formatRelativeDate(item.lastOpened))}</span>
        </button>
        <button class="btn-icon recent-forget" type="button" data-cmd="forget"
                aria-label="Remove ${escapeText(item.name || '')} from this list">${icon('close')}</button>
      </div>`;
    })
    .join('');
}

// Removing an entry takes its bookmarks with it, so every removal is undoable
// rather than guarded by a confirmation the user would learn to click through.
async function forgetRecent(fingerprint) {
  const entry = recentItems.find((item) => item.fingerprint === fingerprint);
  if (!entry) return;

  await globalThis.host?.forgetEntry(fingerprint);
  await refreshRecent();

  const count = Array.isArray(entry.bookmarks) ? entry.bookmarks.length : 0;
  const detail = count ? ` and ${count} bookmark${count === 1 ? '' : 's'}` : '';
  toast(`Removed ${entry.name}${detail}`, {
    duration: 7000,
    action: {
      label: 'Undo',
      onClick: async () => {
        const { fingerprint: _omit, ...body } = entry;
        await globalThis.host?.saveEntry(fingerprint, body);
        await refreshRecent();
      },
    },
  });
}

async function clearRecent() {
  const removed = [...recentItems];
  if (!removed.length) return;

  await Promise.all(removed.map((item) => globalThis.host?.forgetEntry(item.fingerprint)));
  await refreshRecent();

  toast(`Cleared ${removed.length} item${removed.length === 1 ? '' : 's'}`, {
    duration: 7000,
    action: {
      label: 'Undo',
      onClick: async () => {
        await Promise.all(
          removed.map(({ fingerprint, ...body }) => globalThis.host?.saveEntry(fingerprint, body)),
        );
        await refreshRecent();
      },
    },
  });
}

dom.recentList.addEventListener('click', (event) => {
  const row = event.target.closest('.recent-row');
  if (!row) return;

  if (event.target.closest('[data-cmd="forget"]')) {
    forgetRecent(row.dataset.fingerprint);
    return;
  }
  const open = event.target.closest('[data-path]');
  if (open) openPath(open.dataset.path);
});

// Two-step, because this one is not a single row.
dom.recentClear.addEventListener('click', () => {
  if (dom.recentClear.dataset.armed === 'true') {
    dom.recentClear.dataset.armed = 'false';
    dom.recentClear.textContent = 'Clear all';
    clearRecent();
    return;
  }
  dom.recentClear.dataset.armed = 'true';
  dom.recentClear.textContent = 'Clear all?';
  setTimeout(() => {
    if (dom.recentClear.dataset.armed !== 'true') return;
    dom.recentClear.dataset.armed = 'false';
    dom.recentClear.textContent = 'Clear all';
  }, 4000);
});

/* ================================================================== *
 * Settings reactions
 * ================================================================== */

settings.subscribe((values, changed) => {
  if (changed.includes('keymap')) {
    keyboard.setKeymap(values.keymap);
    controls.setKeymap(values.keymap);
    dom.welcomeKey.textContent = bindingLabel(values.keymap.addBookmark?.[0]);
  }
  if (changed.includes('digitSeekEnabled')) keyboard.setDigitSeekEnabled(values.digitSeekEnabled);
  if (changed.includes('timelineMode')) scrubber.setMode(values.timelineMode);
  if (changed.includes('loop')) player.loop = values.loop;
  if (changed.includes('language')) {
    document.documentElement.lang = values.language;
    document.documentElement.dir = values.language === 'he' ? 'rtl' : 'ltr';
  }
});

/* ================================================================== *
 * Boot
 * ================================================================== */

async function boot() {
  await settings.load();

  keyboard.setKeymap(settings.get('keymap'));
  keyboard.setDigitSeekEnabled(settings.get('digitSeekEnabled'));
  controls.setKeymap(settings.get('keymap'));
  controls.setPlaying(false);
  controls.setVolume(settings.get('volume'), settings.get('muted'));
  controls.setRate(settings.get('defaultSpeed'));
  controls.setPipAvailable(Boolean(document.pictureInPictureEnabled));
  controls.setEnabled(false);

  scrubber.setMode(settings.get('timelineMode'));
  scrubber.setDuration(0);

  // The trim button only exists if the engine behind it does. A packaged build
  // always ships it; a source checkout that skipped the install script may not.
  try {
    clipsReady = Boolean(await globalThis.host?.clipsAvailable());
  } catch {
    clipsReady = false;
  }
  controls.setTrimAvailable(clipsReady);
  trimBar.setMode(settings.get('trimMode'));

  dom.welcomeKey.textContent = bindingLabel(settings.get('keymap').addBookmark?.[0]);
  document.documentElement.lang = settings.get('language');
  document.documentElement.dir = settings.get('language') === 'he' ? 'rtl' : 'ltr';

  await refreshRecent();

  globalThis.host?.onOpenFile((file) => openFile(file));
  globalThis.host?.onMenuAction((action) => runAction(action));

  // Only the running state is handled here. Success, failure and cancellation
  // all come back as the resolved value of the call that started the job, so
  // reporting them from both places would double every message.
  globalThis.host?.onClipProgress((state) => {
    const running = state && state.status === 'running' ? state : null;
    activeJob = running;
    if (running && !trimBar.open) trimBar.show();
    trimBar.setJob(running);
    if (!running && !trimRange) trimBar.hide();
    liftToasts();
    if (running) wake();
  });

  // Updates: the menu row mirrors whatever the main process reports, and a
  // downloaded update is the one state worth interrupting for.
  globalThis.host?.onUpdateStatus((state) => {
    menu.setUpdateState(state);
    renderUpdateBar(state);
    renderWelcomeUpdate(state);
    if (state.status === 'error' && menu.open) toast('Could not check for updates');
  });
  globalThis.host?.getUpdateState()
    .then((state) => {
      menu.setUpdateState(state);
      renderUpdateBar(state);
      renderWelcomeUpdate(state);
    })
    .catch(() => {});

  globalThis.host?.signalReady();
}

// Nothing outlives the window, so flush both stores on the way out.
window.addEventListener('beforeunload', () => {
  savePosition(true);
  store.flush();
  settings.flush();
});

boot();

// Coordinator. Owns the wiring, not the behaviour: every module below reports
// intent as an action id, and this file is the single place that decides what
// an action does to the player, the store and the UI.

import { Player } from './player.js';
import { Controls } from './controls.js';
import { Scrubber } from './progress.js';
import { KeyboardLayer } from './keyboard.js';
import { BookmarkStore, BookmarkComposer } from './bookmarks.js';
import { SettingsMenu, ShortcutsSheet, BookmarkPanel } from './panels.js';
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
  chrome: el('chrome'),
  controlsHost: el('controls'),
  composerHost: el('composerHost'),
  menuHost: el('menuHost'),
  panelHost: el('panelHost'),
  sheetHost: el('sheetHost'),
  dropVeil: el('dropVeil'),
};

const player = new Player(dom.video);
const store = new BookmarkStore();

let currentFile = null;
let lastPaintedTime = -1;
let positionSaveAt = 0;
let idleTimer = null;
let suppressAutoHide = false;
let pendingResume = 0;   // resume point held until metadata gives us a duration

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
});

const composer = new BookmarkComposer(dom.composerHost);

const menu = new SettingsMenu(dom.menuHost, {
  settings,
  onAction: (action, value) => {
    if (action === 'applySpeed') applySpeed(value);
    else if (action === 'openShortcuts') shortcuts.show();
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
  wake();
});

player.on('pause', () => {
  controls.setPlaying(false);
  wake();
  savePosition(true);
});

player.on('ended', () => {
  controls.setPlaying(false);
  controls.setEnded(true);
  wake();
});

player.on('ratechange', () => controls.setRate(player.rate));
player.on('volumechange', () => controls.setVolume(player.volume, player.muted));
player.on('progress', () => scrubber.setBuffered(player.buffered, player.currentTime));
player.on('seeked', () => paintTime(true));

player.on('error', () => {
  const code = dom.video.error?.code;
  const message =
    code === 4
      ? 'This file cannot be played — the container or codec is not supported.'
      : 'Something went wrong loading this file.';
  toast(message, { duration: 6000 });
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

function tick() {
  if (!player.paused) paintTime();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

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
      bookmarkPanel.open;
    if (!busy) dom.app.classList.add('is-idle');
  }, delay);
}

for (const event of ['pointermove', 'pointerdown', 'wheel']) {
  dom.stage.addEventListener(event, () => wake(), { passive: true });
}
window.addEventListener('keydown', () => wake());

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

function toast(message, { duration = 2200, html = false } = {}) {
  const node = document.createElement('div');
  node.className = 'toast';
  if (html) node.innerHTML = message;
  else node.textContent = message;
  dom.toasts.appendChild(node);

  setTimeout(() => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 240);
  }, duration);
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
 * Recent files
 * ================================================================== */

async function refreshRecent() {
  let items = [];
  try {
    items = (await globalThis.host?.recentFiles(8)) || [];
  } catch (err) {
    console.error('[app] recent list failed', err);
  }

  dom.recent.hidden = items.length === 0;
  if (!items.length) return;

  dom.recentList.innerHTML = items
    .map((item) => {
      const count = Array.isArray(item.bookmarks) ? item.bookmarks.length : 0;
      const badge = count ? `<span class="recent-badge">${count}</span>` : '';
      return `<button class="recent-row" type="button" data-path="${escapeText(item.path)}">
        <span class="recent-name">${escapeText(item.name || item.path)}</span>
        ${badge}
        <span class="recent-meta">${escapeText(formatRelativeDate(item.lastOpened))}</span>
      </button>`;
    })
    .join('');
}

dom.recentList.addEventListener('click', (event) => {
  const row = event.target.closest('[data-path]');
  if (row) openPath(row.dataset.path);
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

  dom.welcomeKey.textContent = bindingLabel(settings.get('keymap').addBookmark?.[0]);
  document.documentElement.lang = settings.get('language');
  document.documentElement.dir = settings.get('language') === 'he' ? 'rtl' : 'ltr';

  await refreshRecent();

  globalThis.host?.onOpenFile((file) => openFile(file));
  globalThis.host?.onMenuAction((action) => runAction(action));
  globalThis.host?.signalReady();
}

// Nothing outlives the window, so flush both stores on the way out.
window.addEventListener('beforeunload', () => {
  savePosition(true);
  store.flush();
  settings.flush();
});

boot();

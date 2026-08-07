'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const store = require('./store');
const updater = require('./updater');

const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mov', 'mkv', 'avi'];

const MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
};

let mainWindow = null;
// A file passed on argv or via macOS `open-file` can arrive before the renderer
// is listening, so it waits here until the window says it is ready.
let pendingOpenPath = null;

// Must run before `ready`. `stream` is what makes byte-range replies legal,
// which is what makes seeking work at all.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
]);

/* ------------------------------------------------------------------ *
 * media:// — serves a local file with Range support
 * ------------------------------------------------------------------ */

function decodeMediaUrl(requestUrl) {
  // media://file/<encodeURIComponent(absolutePath)>
  const parsed = new URL(requestUrl);
  return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
}

async function handleMediaRequest(request) {
  let filePath;
  try {
    filePath = decodeMediaUrl(request.url);
  } catch {
    return new Response('Bad media URL', { status: 400 });
  }

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  if (!stat.isFile()) return new Response('Not a file', { status: 404 });

  const size = stat.size;
  const type = MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = request.headers.get('Range');

  if (!range) {
    const stream = fs.createReadStream(filePath);
    return new Response(Readable.toWeb(stream), {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
      },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) {
    return new Response('Bad range', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }

  let start;
  let end;
  if (match[1] === '') {
    // Suffix form: `bytes=-500` means the last 500 bytes.
    const suffix = parseInt(match[2], 10);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return new Response('Bad range', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(match[1], 10);
    end = match[2] === '' ? size - 1 : parseInt(match[2], 10);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return new Response('Range not satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}` },
    });
  }
  end = Math.min(end, size - 1);

  const stream = fs.createReadStream(filePath, { start, end });
  return new Response(Readable.toWeb(stream), {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

/* ------------------------------------------------------------------ *
 * File descriptors handed to the renderer
 * ------------------------------------------------------------------ */

// Identity for a local file. There is no URL to key bookmarks on, so this is
// what ties a set of bookmarks to "the same video" across sessions. Path is
// deliberately included: two identical copies in different folders stay
// separate, which matches what people expect from a file-based player.
function fingerprintOf(filePath, stat) {
  const key = `${filePath}|${stat.size}|${Math.round(stat.mtimeMs)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}-${stat.size.toString(36)}`;
}

async function describeFile(filePath) {
  const resolved = path.resolve(filePath);
  const stat = await fs.promises.stat(resolved);
  return {
    path: resolved,
    name: path.basename(resolved),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    fingerprint: fingerprintOf(resolved, stat),
    url: `media://file/${encodeURIComponent(resolved)}`,
  };
}

function looksLikeVideo(candidate) {
  const ext = path.extname(candidate).toLowerCase().replace('.', '');
  return VIDEO_EXTENSIONS.includes(ext);
}

async function openPathInWindow(filePath) {
  if (!filePath || !looksLikeVideo(filePath)) return;
  try {
    const file = await describeFile(filePath);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('file:open', file);
    } else {
      pendingOpenPath = filePath;
    }
  } catch (err) {
    console.error('[main] cannot open', filePath, err);
  }
}

async function showOpenDialog() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open video',
    properties: ['openFile'],
    filters: [
      { name: 'Video', extensions: VIDEO_EXTENSIONS },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return describeFile(result.filePaths[0]);
}

/* ------------------------------------------------------------------ *
 * Window and menu
 * ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 720,
    minWidth: 480,
    minHeight: 320,
    backgroundColor: '#0f0f0f',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Anything that wants to leave the app goes to the real browser, never into
  // the player window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const file = await showOpenDialog();
            if (file) send('file:open', file);
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    // No accelerators below this point on purpose. A menu accelerator is
    // consumed by the menu before the page ever sees the keydown, which would
    // quietly override whatever the user set in the shortcuts editor. The
    // renderer owns these keys; the menu items are just a discoverable path to
    // the same actions.
    {
      label: 'Playback',
      submenu: [
        { label: 'Play / Pause', click: () => send('menu:action', 'playPause') },
        { type: 'separator' },
        { label: 'Add Bookmark', click: () => send('menu:action', 'addBookmark') },
        { label: 'Bookmark List', click: () => send('menu:action', 'toggleBookmarkList') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Fullscreen', click: () => send('menu:action', 'fullscreen') },
        { label: 'Settings', click: () => send('menu:action', 'openSettings') },
        { label: 'Keyboard Shortcuts', click: () => send('menu:action', 'openShortcuts') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'reload' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('dialog:openFile', () => showOpenDialog());
  ipcMain.handle('file:describe', (_e, filePath) => describeFile(filePath));

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, value) => {
    store.setSettings(value);
    return true;
  });

  ipcMain.handle('library:entry', (_e, fingerprint) => store.getEntry(fingerprint));
  ipcMain.handle('library:save', (_e, fingerprint, entry) => {
    store.setEntry(fingerprint, entry);
    return true;
  });
  ipcMain.handle('library:forget', (_e, fingerprint) => {
    store.deleteEntry(fingerprint);
    return true;
  });
  ipcMain.handle('library:recent', (_e, limit) => store.recent(limit));

  ipcMain.handle('updates:state', () => updater.getState());
  ipcMain.handle('updates:check', () => updater.check({ silent: false }));
  ipcMain.handle('updates:install', () => updater.install());

  ipcMain.handle('window:fullscreen', (_e, value) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    mainWindow.setFullScreen(Boolean(value));
    return mainWindow.isFullScreen();
  });

  // The renderer signals readiness so a file from argv is not dropped on the floor.
  ipcMain.on('renderer:ready', async () => {
    const queued = pendingOpenPath || firstVideoFromArgv(process.argv);
    pendingOpenPath = null;
    if (queued) await openPathInWindow(queued);
  });
}

function firstVideoFromArgv(argv) {
  return argv.slice(1).find((arg) => !arg.startsWith('-') && looksLikeVideo(arg)) || null;
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const queued = firstVideoFromArgv(argv);
    if (queued) openPathInWindow(queued);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // macOS delivers "Open With" this way, and it can fire before `ready`.
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (app.isReady()) openPathInWindow(filePath);
    else pendingOpenPath = filePath;
  });

  app.whenReady().then(() => {
    store.init(app.getPath('userData'));
    protocol.handle('media', handleMediaRequest);
    registerIpc();
    buildMenu();
    createWindow();

    updater.init((state) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updates:status', state);
    });
    // Quiet check shortly after launch; the UI only speaks up if there is
    // something to say.
    setTimeout(() => updater.check({ silent: true }), 4000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Last line of defence for anything still sitting in the debounce window.
  app.on('will-quit', () => store.flushAllSync());
}

// Exported for tooling that drives the app (see scripts/): building a file
// descriptor must use the same fingerprint logic the app itself uses.
module.exports = { describeFile, fingerprintOf };

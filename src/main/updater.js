'use strict';

// Auto-update against GitHub Releases.
//
// The app downloads a new version in the background and installs it on quit, so
// the normal case needs no interaction at all. The settings panel can also ask
// for a check on demand and shows whatever state this module reports.

const { autoUpdater } = require('electron-updater');
const { app } = require('electron');

// idle | checking | none | available | downloading | ready | error | disabled
let state = { status: 'idle', version: null, percent: 0, message: '' };
let sendToRenderer = () => {};
let wired = false;

function publish(next) {
  state = { ...state, ...next };
  sendToRenderer(state);
}

function wire() {
  if (wired) return;
  wired = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => publish({ status: 'checking', message: '' }));

  autoUpdater.on('update-available', (info) =>
    publish({ status: 'downloading', version: info?.version ?? null, percent: 0 }));

  autoUpdater.on('update-not-available', () =>
    publish({ status: 'none', version: app.getVersion(), percent: 0 }));

  autoUpdater.on('download-progress', (progress) =>
    publish({ status: 'downloading', percent: Math.round(progress?.percent ?? 0) }));

  autoUpdater.on('update-downloaded', (info) =>
    publish({ status: 'ready', version: info?.version ?? null, percent: 100 }));

  autoUpdater.on('error', (err) => {
    // A failed update check must never look like a broken app.
    publish({ status: 'error', message: String(err?.message || err || 'Update check failed') });
  });
}

// Running from source has no update feed to talk to, and electron-updater
// throws rather than no-ops, so it is reported as disabled instead.
function isSupported() {
  return app.isPackaged;
}

function init(send) {
  sendToRenderer = typeof send === 'function' ? send : () => {};
  if (!isSupported()) {
    state = { status: 'disabled', version: app.getVersion(), percent: 0, message: 'Running from source' };
    return;
  }
  wire();
}

async function check({ silent = false } = {}) {
  if (!isSupported()) {
    publish({ status: 'disabled', message: 'Running from source' });
    return state;
  }
  wire();
  try {
    if (!silent) publish({ status: 'checking', message: '' });
    await autoUpdater.checkForUpdates();
  } catch (err) {
    publish({ status: 'error', message: String(err?.message || err) });
  }
  return state;
}

function install() {
  if (state.status !== 'ready') return false;

  // Silent. The wizard it used to show had nothing to ask — the install
  // location is already in the registry from the first install, so every page
  // was a Next button standing between the user and the update they had just
  // asked for by pressing "Restart & update".
  //
  // The window closes and reopens on the new version, which is what pressing
  // that button looks like it should do. isForceRunAfter is what reopens it;
  // without it the app would simply vanish.
  //
  // Quitting normally with an update downloaded already installed silently —
  // electron-updater's own on-quit path passes isSilent itself — so this also
  // makes the two routes behave the same way.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return true;
}

const getState = () => ({ ...state, appVersion: app.getVersion() });

module.exports = { init, check, install, getState };

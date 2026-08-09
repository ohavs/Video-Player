'use strict';

// The only bridge between the renderer and Node. Everything is an explicit,
// narrow method — the renderer never sees `fs`, `ipcRenderer`, or a raw channel
// name, so a bug in UI code cannot reach the filesystem.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listen = (channel) => (callback) => {
  const wrapped = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('host', {
  platform: process.platform,

  // Files
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  describeFile: (filePath) => ipcRenderer.invoke('file:describe', filePath),
  // The other videos sitting beside this one, for stepping through a folder.
  siblingsOf: (filePath) => ipcRenderer.invoke('file:siblings', filePath),

  // Dropped File objects no longer carry `.path`; this is the supported way to
  // recover the real location of a file the user dragged in.
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  // Preferences
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (value) => ipcRenderer.invoke('settings:set', value),

  // Per-video record: bookmarks, resume position, metadata
  getEntry: (fingerprint) => ipcRenderer.invoke('library:entry', fingerprint),
  saveEntry: (fingerprint, entry) => ipcRenderer.invoke('library:save', fingerprint, entry),
  forgetEntry: (fingerprint) => ipcRenderer.invoke('library:forget', fingerprint),
  recentFiles: (limit) => ipcRenderer.invoke('library:recent', limit),

  // Cutting and converting. Each call picks a destination and runs to
  // completion; interim progress arrives on onClipProgress.
  clipsAvailable: () => ipcRenderer.invoke('clips:available'),
  exportClip: (payload) => ipcRenderer.invoke('clips:trim', payload),
  convertFile: (payload) => ipcRenderer.invoke('clips:convert', payload),
  cancelClip: () => ipcRenderer.invoke('clips:cancel'),
  revealFile: (filePath) => ipcRenderer.invoke('clips:reveal', filePath),
  onClipProgress: listen('clips:progress'),

  // Updates
  getUpdateState: () => ipcRenderer.invoke('updates:state'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onUpdateStatus: listen('updates:status'),

  // Window
  setWindowFullScreen: (value) => ipcRenderer.invoke('window:fullscreen', value),

  // Events from the main process
  onOpenFile: listen('file:open'),
  onMenuAction: listen('menu:action'),
  signalReady: () => ipcRenderer.send('renderer:ready'),
});

'use strict';

// Two JSON files inside Electron's userData directory:
//   settings.json  – one global object of preferences and key bindings
//   library.json   – { [fingerprint]: { path, name, duration, lastOpened, position, bookmarks[] } }
//
// Writes are debounced and atomic (temp file + rename) so a crash mid-write can
// never leave a truncated file behind — losing bookmarks is the one failure the
// user would actually feel.

const fs = require('fs');
const path = require('path');

const WRITE_DELAY = 250;

class JsonFile {
  constructor(filePath, fallback) {
    this.filePath = filePath;
    this.fallback = fallback;
    this.data = null;
    this.timer = null;
    this.writing = false;
    this.again = false;
  }

  read() {
    if (this.data) return this.data;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = parsed && typeof parsed === 'object' ? parsed : structuredClone(this.fallback);
    } catch {
      // Missing or corrupt — start clean rather than crash on launch.
      this.data = structuredClone(this.fallback);
    }
    return this.data;
  }

  write(next) {
    this.data = next;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), WRITE_DELAY);
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.writing) {
      this.again = true;
      return;
    }
    this.writing = true;
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.promises.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      await fs.promises.rename(tmp, this.filePath);
    } catch (err) {
      console.error('[store] write failed', this.filePath, err);
      try { await fs.promises.unlink(tmp); } catch { /* nothing to clean up */ }
    } finally {
      this.writing = false;
      if (this.again) {
        this.again = false;
        await this.flush();
      }
    }
  }

  flushSync() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.data) return;
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[store] sync write failed', this.filePath, err);
    }
  }
}

let settingsFile = null;
let libraryFile = null;

function init(userDataDir) {
  settingsFile = new JsonFile(path.join(userDataDir, 'settings.json'), {});
  libraryFile = new JsonFile(path.join(userDataDir, 'library.json'), {});
}

const getSettings = () => settingsFile.read();
const setSettings = (value) => settingsFile.write(value || {});

const getLibrary = () => libraryFile.read();

function getEntry(fingerprint) {
  return libraryFile.read()[fingerprint] || null;
}

function setEntry(fingerprint, entry) {
  const lib = libraryFile.read();
  lib[fingerprint] = entry;
  libraryFile.write(lib);
}

function deleteEntry(fingerprint) {
  const lib = libraryFile.read();
  delete lib[fingerprint];
  libraryFile.write(lib);
}

// Most-recent-first, trimmed — the welcome screen only ever shows a handful.
function recent(limit = 12) {
  const lib = libraryFile.read();
  return Object.entries(lib)
    .map(([fingerprint, entry]) => ({ fingerprint, ...entry }))
    .sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0))
    .slice(0, limit);
}

function flushAllSync() {
  settingsFile?.flushSync();
  libraryFile?.flushSync();
}

module.exports = {
  init,
  getSettings,
  setSettings,
  getLibrary,
  getEntry,
  setEntry,
  deleteEntry,
  recent,
  flushAllSync,
};

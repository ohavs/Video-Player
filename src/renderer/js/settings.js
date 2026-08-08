// Preferences: defaults, validation, persistence, change notification.
//
// Every value the settings panel exposes is declared here with a type and a
// range, so a hand-edited settings.json can never put the player into a state
// the UI cannot represent.

import { defaultKeymap } from './keymap.js';

export const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export const DEFAULTS = {
  // Playback
  defaultSpeed: 1,
  rememberSpeed: false,
  rememberPosition: true,
  resumeThreshold: 30,      // don't offer to resume inside the first N seconds
  autoplayOnOpen: true,
  loop: false,
  volume: 1,
  muted: false,

  // Seeking
  shortSeek: 5,
  longSeek: 10,
  volumeStep: 5,
  digitSeekEnabled: true,

  // Bookmarks
  pauseWhileAdding: true,
  bookmarkOffset: 0,        // capture N seconds *before* the keypress
  timelineMode: 'segments', // 'segments' | 'points'
  showBookmarkLabels: true,
  jumpToBookmarkOnSave: false,

  // Trimming
  trimMode: 'fast',         // 'fast' (stream copy) | 'exact' (re-encode)

  // Interface
  hideControlsDelay: 3000,
  language: 'en',           // 'en' | 'he' — drives dir=rtl
  keymap: defaultKeymap(),
};

const NUMBER_RANGES = {
  defaultSpeed: [0.25, 4],
  resumeThreshold: [0, 600],
  volume: [0, 1],
  shortSeek: [1, 60],
  longSeek: [1, 300],
  volumeStep: [1, 50],
  bookmarkOffset: [0, 30],
  hideControlsDelay: [500, 30000],
};

const ENUMS = {
  timelineMode: ['segments', 'points'],
  trimMode: ['fast', 'exact'],
  language: ['en', 'he'],
};

function coerce(key, value) {
  const fallback = DEFAULTS[key];

  if (typeof fallback === 'boolean') return typeof value === 'boolean' ? value : fallback;

  if (typeof fallback === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const range = NUMBER_RANGES[key];
    if (!range) return n;
    return Math.min(range[1], Math.max(range[0], n));
  }

  if (ENUMS[key]) return ENUMS[key].includes(value) ? value : fallback;

  if (key === 'keymap') return sanitizeKeymap(value);

  return value === undefined ? fallback : value;
}

function sanitizeKeymap(value) {
  const base = defaultKeymap();
  if (!value || typeof value !== 'object') return base;
  const result = {};
  for (const actionId of Object.keys(base)) {
    const bindings = value[actionId];
    if (Array.isArray(bindings)) {
      // Keep only well-formed, de-duplicated strings.
      result[actionId] = [...new Set(bindings.filter((b) => typeof b === 'string' && b.length))];
    } else {
      result[actionId] = base[actionId];
    }
  }
  return result;
}

export class Settings {
  constructor() {
    this.values = { ...DEFAULTS };
    this.listeners = new Set();
    this.saveTimer = null;
  }

  async load() {
    let stored = {};
    try {
      stored = (await globalThis.host?.getSettings()) || {};
    } catch (err) {
      console.error('[settings] load failed, using defaults', err);
    }
    const next = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (key in stored) next[key] = coerce(key, stored[key]);
    }
    this.values = next;
    this.emit(Object.keys(DEFAULTS));
    return this.values;
  }

  get(key) {
    return this.values[key];
  }

  all() {
    return { ...this.values };
  }

  set(key, value) {
    if (!(key in DEFAULTS)) return;
    const next = coerce(key, value);
    if (Object.is(next, this.values[key])) return;
    this.values[key] = next;
    this.emit([key]);
    this.save();
  }

  patch(partial) {
    const changed = [];
    for (const [key, value] of Object.entries(partial || {})) {
      if (!(key in DEFAULTS)) continue;
      const next = coerce(key, value);
      if (Object.is(next, this.values[key])) continue;
      this.values[key] = next;
      changed.push(key);
    }
    if (changed.length) {
      this.emit(changed);
      this.save();
    }
  }

  // keymap is an object, so identity comparison in set() would never fire.
  setKeymap(keymap) {
    this.values.keymap = sanitizeKeymap(keymap);
    this.emit(['keymap']);
    this.save();
  }

  resetKeymap() {
    this.setKeymap(defaultKeymap());
  }

  resetAll() {
    this.values = { ...DEFAULTS, keymap: defaultKeymap() };
    this.emit(Object.keys(DEFAULTS));
    this.save();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(changedKeys) {
    for (const listener of this.listeners) {
      try {
        listener(this.values, changedKeys);
      } catch (err) {
        console.error('[settings] listener failed', err);
      }
    }
  }

  save() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      globalThis.host?.setSettings(this.values).catch((err) => {
        console.error('[settings] save failed', err);
      });
    }, 200);
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    return globalThis.host?.setSettings(this.values);
  }
}

export const settings = new Settings();

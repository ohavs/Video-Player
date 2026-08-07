// Bookmarks: the model, and the inline composer that captures one.
//
// A bookmark is a point in time with a label. The timeline can render points as
// they are, or derive contiguous chapter segments from them — see segments()
// below, which is what produces the split progress bar.

import { formatTime, clamp } from './format.js';

const SAVE_DELAY = 300;

const newId = () =>
  (globalThis.crypto?.randomUUID?.() ?? `bm-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);

export class BookmarkStore {
  constructor() {
    this.fingerprint = null;
    this.meta = {};          // path, name, duration, lastOpened, position
    this.items = [];
    this.listeners = new Set();
    this.saveTimer = null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    for (const listener of this.listeners) {
      try {
        listener(this.items);
      } catch (err) {
        console.error('[bookmarks] listener failed', err);
      }
    }
  }

  async attach(file) {
    await this.flush();
    this.fingerprint = file.fingerprint;
    this.meta = { path: file.path, name: file.name, size: file.size };
    this.items = [];

    let entry = null;
    try {
      entry = await globalThis.host?.getEntry(file.fingerprint);
    } catch (err) {
      console.error('[bookmarks] load failed', err);
    }
    if (entry) {
      this.meta = { ...this.meta, ...entry, path: file.path, name: file.name };
      this.items = Array.isArray(entry.bookmarks) ? entry.bookmarks.filter(isValid).sort(byTime) : [];
    }
    this.emit();
    return { resumePosition: Number(entry?.position) || 0 };
  }

  detach() {
    this.flush();
    this.fingerprint = null;
    this.items = [];
    this.emit();
  }

  get list() {
    return this.items;
  }

  get count() {
    return this.items.length;
  }

  add(time, text = '') {
    const bookmark = {
      id: newId(),
      time: Math.max(0, Number(time) || 0),
      text: String(text || '').trim(),
      created: Date.now(),
    };
    this.items.push(bookmark);
    this.items.sort(byTime);
    this.emit();
    this.save();
    return bookmark;
  }

  update(id, patch) {
    const bookmark = this.items.find((b) => b.id === id);
    if (!bookmark) return null;
    if (patch.text !== undefined) bookmark.text = String(patch.text).trim();
    if (patch.time !== undefined) {
      bookmark.time = Math.max(0, Number(patch.time) || 0);
      this.items.sort(byTime);
    }
    this.emit();
    this.save();
    return bookmark;
  }

  remove(id) {
    const index = this.items.findIndex((b) => b.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    this.emit();
    this.save();
    return true;
  }

  clear() {
    if (!this.items.length) return;
    this.items = [];
    this.emit();
    this.save();
  }

  byId(id) {
    return this.items.find((b) => b.id === id) || null;
  }

  // Next / previous relative to a playhead. `next` uses a small forward bias so
  // pressing "previous" right after landing on a mark goes to the one before it
  // rather than re-selecting the current one.
  next(time) {
    return this.items.find((b) => b.time > time + 0.05) || null;
  }

  previous(time) {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i].time < time - 0.6) return this.items[i];
    }
    return null;
  }

  // The bookmark whose chapter contains `time`, or null before the first one.
  activeAt(time) {
    let active = null;
    for (const bookmark of this.items) {
      if (bookmark.time <= time + 0.001) active = bookmark;
      else break;
    }
    return active;
  }

  // Points -> contiguous chapters. Everything before the first bookmark becomes
  // one untitled opening segment so the bar always covers 0..duration with no
  // gaps in coverage, which is what makes the split bar read correctly.
  segments(duration) {
    if (!Number.isFinite(duration) || duration <= 0) return [];
    const marks = this.items.filter((b) => b.time < duration - 0.05);
    if (!marks.length) return [{ start: 0, end: duration, title: '', bookmark: null }];

    const segments = [];
    if (marks[0].time > 0.05) {
      segments.push({ start: 0, end: marks[0].time, title: '', bookmark: null });
    }
    for (let i = 0; i < marks.length; i += 1) {
      const start = Math.max(0, marks[i].time);
      const end = i + 1 < marks.length ? marks[i + 1].time : duration;
      if (end - start <= 0.01) continue;   // two marks on the same frame
      segments.push({ start, end, title: marks[i].text, bookmark: marks[i] });
    }
    return segments;
  }

  setMeta(patch) {
    this.meta = { ...this.meta, ...patch };
    this.save();
  }

  save() {
    if (!this.fingerprint) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeNow();
    }, SAVE_DELAY);
  }

  writeNow() {
    if (!this.fingerprint) return Promise.resolve();
    const entry = { ...this.meta, lastOpened: Date.now(), bookmarks: this.items };
    return globalThis.host?.saveEntry(this.fingerprint, entry)
      .catch((err) => console.error('[bookmarks] save failed', err));
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    return this.writeNow();
  }

  export() {
    return {
      file: this.meta.name,
      duration: this.meta.duration,
      exported: new Date().toISOString(),
      bookmarks: this.items.map((b) => ({ time: b.time, stamp: formatTime(b.time), text: b.text })),
    };
  }
}

const byTime = (a, b) => a.time - b.time;
const isValid = (b) => b && typeof b === 'object' && Number.isFinite(Number(b.time));

/* ------------------------------------------------------------------ *
 * Inline composer
 * ------------------------------------------------------------------ */

// The whole point of the feature is that capturing a moment costs nothing: one
// key, type, Enter. So this is a single field anchored at the mark's position on
// the timeline — never a dialog, never a mode change beyond the field itself.
export class BookmarkComposer {
  constructor(host) {
    this.host = host;
    this.open = false;
    this.session = null;

    this.root = document.createElement('div');
    this.root.className = 'composer';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="composer-arrow"></div>
      <div class="composer-body">
        <span class="composer-stamp" data-role="stamp">0:00</span>
        <input class="composer-input" data-role="input" type="text"
               placeholder="Label this moment…" maxlength="120"
               autocomplete="off" spellcheck="false" />
        <button class="composer-save" data-role="save" type="button" title="Save">Save</button>
      </div>
      <div class="composer-hint"><kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel</div>
    `;

    this.stampEl = this.root.querySelector('[data-role="stamp"]');
    this.inputEl = this.root.querySelector('[data-role="input"]');
    this.saveEl = this.root.querySelector('[data-role="save"]');

    this.inputEl.addEventListener('keydown', (event) => {
      // Stop every key here from reaching the global shortcut layer — otherwise
      // typing "b" in the label would open a second composer.
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        this.commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.cancel();
      }
    });

    // Clicking away keeps what was typed: losing a label to a stray click would
    // be worse than an occasional empty bookmark.
    this.inputEl.addEventListener('blur', () => {
      if (this.open) setTimeout(() => this.open && this.commit(), 120);
    });

    this.saveEl.addEventListener('mousedown', (event) => event.preventDefault());
    this.saveEl.addEventListener('click', () => this.commit());

    host.appendChild(this.root);
  }

  get isOpen() {
    return this.open;
  }

  // `anchorRatio` is 0..1 across the timeline; the field is centred on it and
  // clamped so it never hangs off the edge of the window.
  show({ time, text = '', anchorRatio = 0.5, editingId = null, onCommit, onCancel }) {
    this.session = { time, editingId, onCommit, onCancel };
    this.open = true;

    this.stampEl.textContent = formatTime(time);
    this.inputEl.value = text;
    this.saveEl.textContent = editingId ? 'Update' : 'Save';
    this.root.hidden = false;
    this.root.classList.add('is-open');

    const ratio = clamp(anchorRatio, 0, 1);
    this.root.style.setProperty('--anchor', `${(ratio * 100).toFixed(3)}%`);
    requestAnimationFrame(() => this.position(ratio));

    this.inputEl.focus();
    this.inputEl.select();
  }

  position(ratio) {
    const hostRect = this.host.getBoundingClientRect();
    const width = this.root.offsetWidth || 320;
    const margin = 12;
    const centre = ratio * hostRect.width;
    const left = clamp(centre - width / 2, margin, Math.max(margin, hostRect.width - width - margin));
    this.root.style.left = `${left}px`;
    // The little arrow stays pointing at the real position even when the body
    // has been pushed sideways to stay on screen.
    const arrowOffset = clamp(centre - left, 14, Math.max(14, width - 14));
    this.root.style.setProperty('--arrow-offset', `${arrowOffset}px`);
  }

  commit() {
    if (!this.open || !this.session) return;
    const { time, editingId, onCommit } = this.session;
    const text = this.inputEl.value.trim();
    this.close();
    onCommit?.({ time, text, editingId });
  }

  cancel() {
    if (!this.open || !this.session) return;
    const { onCancel } = this.session;
    this.close();
    onCancel?.();
  }

  close() {
    this.open = false;
    this.session = null;
    this.root.classList.remove('is-open');
    this.root.hidden = true;
    this.inputEl.blur();
  }
}

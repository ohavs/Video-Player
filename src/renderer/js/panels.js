// Three surfaces that sit over the video: the settings menu, the shortcuts
// editor, and the bookmark list.
//
// The settings menu is declarative — each page is a function returning item
// descriptors, re-evaluated on every render, so a toggle can never display a
// value that disagrees with the store behind it.

import { icon } from './icons.js';
import { formatTime, formatSpeed } from './format.js';
import { SPEED_STEPS } from './settings.js';
import {
  ACTIONS, ACTION_GROUPS, ACTION_BY_ID,
  bindingLabel, eventToBinding, findConflict, defaultKeymap,
} from './keymap.js';

/* ================================================================== *
 * Settings menu
 * ================================================================== */

export class SettingsMenu {
  constructor(host, { settings, onAction } = {}) {
    this.settings = settings;
    this.onAction = onAction || (() => {});
    this.open = false;
    this.page = 'root';
    this.updateState = { status: 'idle', appVersion: '' };

    this.root = document.createElement('div');
    this.root.className = 'menu';
    this.root.hidden = true;
    host.appendChild(this.root);

    this.root.addEventListener('click', (event) => this.handleClick(event));
    this.root.addEventListener('pointerdown', (event) => event.stopPropagation());
  }

  pages() {
    const s = this.settings;
    return {
      root: {
        title: null,
        items: [
          { type: 'submenu', id: 'speed', label: 'Speed', value: formatSpeed(s.get('defaultSpeed')) },
          { type: 'toggle', id: 'loop', label: 'Loop', value: s.get('loop') },
          { type: 'submenu', id: 'bookmarks', label: 'Bookmarks' },
          { type: 'submenu', id: 'playback', label: 'Playback' },
          { type: 'action', id: 'shortcuts', label: 'Keyboard shortcuts', glyph: 'keyboard' },
          {
            type: 'action',
            id: this.updateState.status === 'ready' ? 'installUpdate' : 'checkUpdates',
            label: updateLabel(this.updateState),
            glyph: 'reset',
            note: updateNote(this.updateState),
            busy: this.updateState.status === 'checking' || this.updateState.status === 'downloading',
          },
        ],
      },

      speed: {
        title: 'Speed',
        items: SPEED_STEPS.map((rate) => ({
          type: 'radio',
          id: `speed:${rate}`,
          label: formatSpeed(rate),
          checked: Math.abs(s.get('defaultSpeed') - rate) < 0.001,
        })),
      },

      bookmarks: {
        title: 'Bookmarks',
        items: [
          { type: 'toggle', id: 'pauseWhileAdding', label: 'Pause while typing', value: s.get('pauseWhileAdding') },
          {
            type: 'radioInline',
            id: 'timelineMode',
            label: 'Timeline style',
            value: s.get('timelineMode'),
            options: [
              { value: 'segments', label: 'Chapters' },
              { value: 'points', label: 'Markers' },
            ],
          },
          {
            type: 'stepper',
            id: 'bookmarkOffset',
            label: 'Capture offset',
            value: s.get('bookmarkOffset'),
            suffix: 's',
            step: 1,
            min: 0,
            max: 30,
            note: 'Marks this many seconds before the keypress',
          },
          { type: 'toggle', id: 'jumpToBookmarkOnSave', label: 'Jump to mark after saving', value: s.get('jumpToBookmarkOnSave') },
        ],
      },

      playback: {
        title: 'Playback',
        items: [
          { type: 'toggle', id: 'rememberPosition', label: 'Resume where I left off', value: s.get('rememberPosition') },
          { type: 'toggle', id: 'autoplayOnOpen', label: 'Play on open', value: s.get('autoplayOnOpen') },
          { type: 'toggle', id: 'rememberSpeed', label: 'Remember speed', value: s.get('rememberSpeed') },
          { type: 'stepper', id: 'shortSeek', label: 'Short skip', value: s.get('shortSeek'), suffix: 's', step: 1, min: 1, max: 60 },
          { type: 'stepper', id: 'longSeek', label: 'Long skip', value: s.get('longSeek'), suffix: 's', step: 5, min: 1, max: 300 },
          { type: 'stepper', id: 'volumeStep', label: 'Volume step', value: s.get('volumeStep'), suffix: '%', step: 1, min: 1, max: 50 },
          { type: 'toggle', id: 'digitSeekEnabled', label: 'Number keys jump', value: s.get('digitSeekEnabled') },
        ],
      },
    };
  }

  render() {
    const page = this.pages()[this.page] || this.pages().root;
    const header = page.title
      ? `<button class="menu-back" data-nav="root" type="button">${icon('chevronLeft')}<span>${page.title}</span></button>`
      : '';

    this.root.innerHTML = `${header}<div class="menu-items">${page.items.map(renderItem).join('')}</div>`;
    this.root.dataset.page = this.page;
  }

  handleClick(event) {
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      this.page = nav.dataset.nav;
      this.render();
      return;
    }

    const step = event.target.closest('[data-step]');
    if (step) {
      const { id } = step.closest('[data-id]').dataset;
      const delta = Number(step.dataset.step);
      const item = this.findItem(id);
      if (item) {
        const next = Math.min(item.max, Math.max(item.min, Number(item.value) + delta * (item.step || 1)));
        this.settings.set(id, next);
        this.render();
      }
      return;
    }

    const inline = event.target.closest('[data-choose]');
    if (inline) {
      const { id } = inline.closest('[data-id]').dataset;
      this.settings.set(id, inline.dataset.choose);
      this.render();
      return;
    }

    const row = event.target.closest('[data-id]');
    if (!row) return;
    const { id, type } = row.dataset;

    if (type === 'submenu') {
      this.page = id;
      this.render();
    } else if (type === 'toggle') {
      this.settings.set(id, !this.settings.get(id));
      this.render();
    } else if (type === 'radio' && id.startsWith('speed:')) {
      const rate = Number(id.split(':')[1]);
      this.settings.set('defaultSpeed', rate);
      this.onAction('applySpeed', rate);
      this.render();
    } else if (type === 'action' && id === 'shortcuts') {
      this.hide();
      this.onAction('openShortcuts');
    } else if (type === 'action' && id === 'checkUpdates') {
      this.onAction('checkUpdates');
    } else if (type === 'action' && id === 'installUpdate') {
      this.onAction('installUpdate');
    }
  }

  setUpdateState(state) {
    this.updateState = state || this.updateState;
    if (this.open && this.page === 'root') this.render();
  }

  findItem(id) {
    for (const page of Object.values(this.pages())) {
      const found = page.items.find((item) => item.id === id);
      if (found) return found;
    }
    return null;
  }

  show() {
    this.page = 'root';
    this.render();
    this.root.hidden = false;
    this.open = true;
    this.root.classList.add('is-open');
  }

  hide() {
    this.open = false;
    this.root.classList.remove('is-open');
    this.root.hidden = true;
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
  }
}

function renderItem(item) {
  const base = `data-id="${item.id}" data-type="${item.type}"`;

  if (item.type === 'submenu') {
    return `<button class="menu-row" ${base} type="button">
      <span class="menu-label">${escapeHtml(item.label)}</span>
      <span class="menu-value">${escapeHtml(item.value || '')}${icon('chevronRight')}</span>
    </button>`;
  }

  if (item.type === 'action') {
    return `<button class="menu-row ${item.busy ? 'is-busy' : ''}" ${base} type="button">
      <span class="menu-label">${item.glyph ? icon(item.glyph) : ''}${escapeHtml(item.label)}
        ${item.note ? `<small class="menu-note">${escapeHtml(item.note)}</small>` : ''}
      </span>
      <span class="menu-value">${icon('chevronRight')}</span>
    </button>`;
  }

  if (item.type === 'toggle') {
    return `<button class="menu-row" ${base} type="button" role="switch" aria-checked="${item.value}">
      <span class="menu-label">${escapeHtml(item.label)}</span>
      <span class="switch ${item.value ? 'is-on' : ''}"><span class="switch-knob"></span></span>
    </button>`;
  }

  if (item.type === 'radio') {
    return `<button class="menu-row" ${base} type="button" role="menuitemradio" aria-checked="${item.checked}">
      <span class="menu-check">${item.checked ? icon('check') : ''}</span>
      <span class="menu-label">${escapeHtml(item.label)}</span>
    </button>`;
  }

  if (item.type === 'radioInline') {
    const options = item.options
      .map(
        (option) =>
          `<button class="chip ${option.value === item.value ? 'is-on' : ''}" data-choose="${option.value}" type="button">${escapeHtml(option.label)}</button>`,
      )
      .join('');
    return `<div class="menu-row is-static" ${base}>
      <span class="menu-label">${escapeHtml(item.label)}</span>
      <span class="chip-group">${options}</span>
    </div>`;
  }

  if (item.type === 'stepper') {
    return `<div class="menu-row is-static" ${base}>
      <span class="menu-label">${escapeHtml(item.label)}
        ${item.note ? `<small class="menu-note">${escapeHtml(item.note)}</small>` : ''}
      </span>
      <span class="stepper">
        <button data-step="-1" type="button" aria-label="Decrease">−</button>
        <output>${item.value}${item.suffix || ''}</output>
        <button data-step="1" type="button" aria-label="Increase">+</button>
      </span>
    </div>`;
  }

  return '';
}

/* ================================================================== *
 * Shortcuts editor
 * ================================================================== */

export class ShortcutsSheet {
  constructor(host, { settings } = {}) {
    this.settings = settings;
    this.open = false;
    this.capturing = null;   // action id currently listening for a key
    this.notice = '';

    this.root = document.createElement('div');
    this.root.className = 'sheet';
    this.root.hidden = true;
    host.appendChild(this.root);

    this.root.addEventListener('click', (event) => this.handleClick(event));
    this.root.addEventListener('pointerdown', (event) => event.stopPropagation());

    // Capture phase, on window: a rebind must intercept the key before the
    // normal shortcut layer acts on it, or binding "F" would toggle fullscreen.
    this.keyListener = (event) => this.handleKey(event);
  }

  render() {
    const keymap = this.settings.get('keymap');
    const groups = ACTION_GROUPS.map((group) => {
      const rows = ACTIONS.filter((action) => action.group === group.id)
        .map((action) => this.renderRow(action, keymap[action.id] || []))
        .join('');
      return `<section class="sheet-group">
        <h3>${escapeHtml(group.label)}</h3>
        <div class="sheet-rows">${rows}</div>
      </section>`;
    }).join('');

    this.root.innerHTML = `
      <div class="sheet-panel" role="dialog" aria-label="Keyboard shortcuts">
        <header class="sheet-head">
          <h2>Keyboard shortcuts</h2>
          <div class="sheet-head-actions">
            <button class="btn-ghost" data-cmd="resetAll" type="button">${icon('reset')}<span>Reset all</span></button>
            <button class="btn-icon" data-cmd="close" type="button" aria-label="Close">${icon('close')}</button>
          </div>
        </header>
        ${this.notice ? `<p class="sheet-notice">${escapeHtml(this.notice)}</p>` : ''}
        <p class="sheet-hint">Click a shortcut, then press the key you want. Bindings follow the physical key, so they keep working when you switch keyboard layout.</p>
        <div class="sheet-body">${groups}</div>
      </div>
    `;
  }

  renderRow(action, bindings) {
    const isCapturing = this.capturing === action.id;
    const chips = bindings.length
      ? bindings.map((b) => `<kbd class="kbd">${escapeHtml(bindingLabel(b))}</kbd>`).join('')
      : '<span class="kbd is-empty">Not set</span>';

    return `<div class="sheet-row ${isCapturing ? 'is-capturing' : ''}" data-action="${action.id}">
      <span class="sheet-row-label">${escapeHtml(action.label)}</span>
      <span class="sheet-row-keys">${isCapturing ? '<span class="kbd is-listening">Press a key…</span>' : chips}</span>
      <span class="sheet-row-actions">
        <button class="btn-icon" data-cmd="capture" type="button" aria-label="Change">${icon('pencil')}</button>
        <button class="btn-icon" data-cmd="reset" type="button" aria-label="Reset">${icon('reset')}</button>
      </span>
    </div>`;
  }

  handleClick(event) {
    const cmd = event.target.closest('[data-cmd]')?.dataset.cmd;

    if (cmd === 'close' || event.target === this.root) {
      this.hide();
      return;
    }
    if (cmd === 'resetAll') {
      this.settings.resetKeymap();
      this.notice = 'All shortcuts restored to defaults.';
      this.render();
      return;
    }

    const row = event.target.closest('[data-action]');
    if (!row) return;
    const actionId = row.dataset.action;

    if (cmd === 'capture') {
      this.capturing = this.capturing === actionId ? null : actionId;
      this.notice = '';
      this.render();
    } else if (cmd === 'reset') {
      const defaults = defaultKeymap();
      const keymap = { ...this.settings.get('keymap'), [actionId]: defaults[actionId] };
      this.settings.setKeymap(keymap);
      this.notice = '';
      this.render();
    }
  }

  handleKey(event) {
    if (!this.open) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (this.capturing) {
        this.capturing = null;
        this.render();
      } else {
        this.hide();
      }
      return;
    }

    if (!this.capturing) return;

    const binding = eventToBinding(event);
    if (!binding) return;   // a bare modifier — keep listening

    event.preventDefault();
    event.stopPropagation();

    const actionId = this.capturing;
    const keymap = { ...this.settings.get('keymap') };
    const conflict = findConflict(keymap, binding, actionId);

    if (conflict) {
      // Take the key from the other action rather than silently double-binding.
      keymap[conflict] = (keymap[conflict] || []).filter((b) => b !== binding);
      this.notice = `${bindingLabel(binding)} was taken from “${ACTION_BY_ID.get(conflict)?.label ?? conflict}”.`;
    } else {
      this.notice = '';
    }

    keymap[actionId] = [binding];
    this.settings.setKeymap(keymap);
    this.capturing = null;
    this.render();
  }

  show() {
    this.notice = '';
    this.capturing = null;
    this.render();
    this.root.hidden = false;
    this.open = true;
    requestAnimationFrame(() => this.root.classList.add('is-open'));
    window.addEventListener('keydown', this.keyListener, true);
  }

  hide() {
    this.open = false;
    this.capturing = null;
    this.root.classList.remove('is-open');
    this.root.hidden = true;
    window.removeEventListener('keydown', this.keyListener, true);
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
  }
}

/* ================================================================== *
 * Bookmark list
 * ================================================================== */

export class BookmarkPanel {
  constructor(host, { onJump, onRename, onDelete, onUndoDelete, onExport } = {}) {
    this.handlers = { onJump, onRename, onDelete, onUndoDelete, onExport };
    this.open = false;
    this.items = [];
    this.activeId = null;

    // Deleting asks first, in the row rather than in a dialog — the same
    // two-step the "Clear all" button uses, and no modal anywhere in this app.
    this.confirmingId = null;
    this.confirmTimer = null;

    // Then it stays undoable for a few seconds. The coordinator owns the clock;
    // this only draws it.
    this.pending = null;      // { bookmark, expiresAt, window }
    this.countdownTimer = null;

    // Renaming happens in the row itself. It used to open the composer, which
    // is anchored to the timeline underneath this panel — so the field you were
    // asked to type in was behind the thing you had clicked in.
    this.editingId = null;
    this.draft = null;      // survives a re-render mid-edit

    this.root = document.createElement('aside');
    this.root.className = 'bookmarks-panel';
    this.root.hidden = true;
    host.appendChild(this.root);

    this.root.addEventListener('click', (event) => this.handleClick(event));
    this.root.addEventListener('pointerdown', (event) => event.stopPropagation());
    this.root.addEventListener('input', (event) => {
      if (event.target.matches('[data-role="rename"]')) this.draft = event.target.value;
    });
    this.root.addEventListener('keydown', (event) => this.handleKey(event));
    this.root.addEventListener('focusout', (event) => {
      if (!event.target.matches('[data-role="rename"]')) return;
      const { id } = event.target.closest('[data-id]').dataset;
      // Same bargain the composer strikes: losing a label to a stray click
      // elsewhere would be worse than the occasional unintended save. The delay
      // lets a click on Save or Cancel land first.
      setTimeout(() => {
        if (this.editingId === id) this.commitEdit();
      }, 120);
    });
  }

  handleKey(event) {
    if (!event.target.matches('[data-role="rename"]')) return;
    // Every key here belongs to the field — without this, typing a label would
    // fire the global shortcuts behind it.
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelEdit();
    }
  }

  handleClick(event) {
    const cmd = event.target.closest('[data-cmd]')?.dataset.cmd;
    if (cmd === 'close') {
      this.hide();
      return;
    }
    if (cmd === 'export') {
      this.handlers.onExport?.();
      return;
    }
    if (cmd === 'undo') {
      this.handlers.onUndoDelete?.();
      return;
    }

    const row = event.target.closest('[data-id]');
    if (!row) return;
    const { id } = row.dataset;

    if (cmd === 'save') this.commitEdit();
    else if (cmd === 'cancel') this.cancelEdit();
    else if (cmd === 'delete') this.askDelete(id);
    else if (cmd === 'confirmDelete') this.confirmDelete(id);
    else if (cmd === 'cancelDelete') this.clearConfirm();
    else if (cmd === 'edit') this.beginEdit(id);
    // Clicking the field itself is placing a cursor, not asking to jump.
    else if (this.editingId !== id && this.confirmingId !== id) this.handlers.onJump?.(id);
  }

  /* ---------------- deleting, in two steps ---------------- */

  askDelete(id) {
    if (this.editingId) this.commitEdit();
    this.confirmingId = id;
    this.armConfirmTimeout();
    this.render();
  }

  // An armed row that is never answered disarms itself, so a stray click does
  // not leave a Delete button sitting under the pointer indefinitely.
  armConfirmTimeout() {
    clearTimeout(this.confirmTimer);
    this.confirmTimer = setTimeout(() => {
      if (this.confirmingId) this.clearConfirm();
    }, 6000);
  }

  clearConfirm() {
    clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    if (!this.confirmingId) return;
    this.confirmingId = null;
    this.render();
  }

  confirmDelete(id) {
    clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    this.confirmingId = null;
    this.handlers.onDelete?.(id);
  }

  /* ---------------- the undo window ---------------- */

  // `pending` is { bookmark, expiresAt, window } or null.
  setPendingDelete(pending) {
    this.pending = pending || null;
    if (this.open) this.render();
    this.driveCountdown();
  }

  // Only the number ticks, and it is written straight into its node. Re-render
  // once a second would restart the draining bar and drop keyboard focus.
  driveCountdown() {
    clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    if (!this.pending) return;

    const paint = () => {
      const node = this.root.querySelector('[data-role="undoCount"]');
      if (!node) return;
      const left = Math.max(0, Math.ceil((this.pending.expiresAt - Date.now()) / 1000));
      node.textContent = String(left);
    };
    paint();
    this.countdownTimer = setInterval(paint, 250);
  }

  /* ---------------- renaming in place ---------------- */

  beginEdit(id) {
    const bookmark = this.items.find((item) => item.id === id);
    if (!bookmark) return;
    this.editingId = id;
    this.draft = bookmark.text || '';
    this.render();
    this.focusField();
  }

  focusField() {
    const field = this.root.querySelector('[data-role="rename"]');
    if (!field) return;
    field.focus();
    // Cursor at the end rather than a full selection: renaming is usually
    // amending a label, not replacing it.
    const end = field.value.length;
    field.setSelectionRange(end, end);
  }

  commitEdit() {
    const id = this.editingId;
    if (!id) return;
    const text = (this.draft ?? '').trim();
    this.editingId = null;
    this.draft = null;
    this.handlers.onRename?.(id, text);
    this.render();
  }

  cancelEdit() {
    if (!this.editingId) return;
    this.editingId = null;
    this.draft = null;
    this.render();
  }

  setItems(items) {
    this.items = items || [];
    // A row being renamed that disappears from under the edit takes the edit
    // with it.
    if (this.editingId && !this.items.some((item) => item.id === this.editingId)) {
      this.editingId = null;
      this.draft = null;
    }
    if (this.open) {
      const wasEditing = Boolean(this.editingId);
      this.render();
      if (wasEditing) this.focusField();
    }
  }

  setActive(id) {
    if (id === this.activeId) return;
    this.activeId = id;
    if (!this.open) return;
    for (const row of this.root.querySelectorAll('[data-id]')) {
      row.classList.toggle('is-active', row.dataset.id === id);
    }
  }

  // The vanishing bookmark keeps its place in the list rather than moving to a
  // corner: undo belongs where the row was, which is where the eye already is.
  //
  // The bar drains with a CSS animation, and a negative delay set from the time
  // already elapsed makes it resume mid-flight instead of restarting whenever
  // the list re-renders under it.
  renderPendingRow() {
    const { bookmark, expiresAt, window: span } = this.pending;
    const elapsed = Math.max(0, Math.min(span, span - (expiresAt - Date.now())));
    const label = bookmark.text ? escapeHtml(bookmark.text) : 'Untitled';

    return `
      <div class="bm-row bm-undo" data-pending="${escapeHtml(bookmark.id)}">
        <span class="bm-time">${formatTime(bookmark.time)}</span>
        <span class="bm-undo-text">
          Deleted <span class="bm-undo-name">${label}</span>
        </span>
        <span class="bm-undo-count" data-role="undoCount">${Math.ceil(span / 1000)}</span>
        <button class="bm-undo-btn" data-cmd="undo" type="button">Undo</button>
        <span class="bm-undo-bar" style="animation-duration:${span}ms;animation-delay:-${elapsed}ms"></span>
      </div>`;
  }

  renderRow(bookmark) {
    const active = bookmark.id === this.activeId ? ' is-active' : '';

    if (bookmark.id === this.confirmingId) {
      return `
        <div class="bm-row is-confirming${active}" data-id="${bookmark.id}">
          <span class="bm-time">${formatTime(bookmark.time)}</span>
          <!-- Short on purpose. The panel is narrow, and "Delete this
               bookmark?" truncated to "Delete this boo…" — which says less than
               one word does. The row is already highlighted in place with its
               own timestamp, so which bookmark is never in question. -->
          <span class="bm-confirm-text">Delete?</span>
          <span class="bm-actions">
            <button class="bm-confirm-go" data-cmd="confirmDelete" type="button">Delete</button>
            <button class="bm-confirm-no" data-cmd="cancelDelete" type="button">Keep</button>
          </span>
        </div>`;
    }

    if (bookmark.id === this.editingId) {
      return `
        <div class="bm-row is-editing${active}" data-id="${bookmark.id}">
          <span class="bm-time">${formatTime(bookmark.time)}</span>
          <input class="bm-edit" data-role="rename" type="text" maxlength="120"
                 autocomplete="off" spellcheck="false"
                 placeholder="Label this moment…" value="${escapeHtml(this.draft ?? bookmark.text ?? '')}" />
          <span class="bm-actions">
            <button class="btn-icon" data-cmd="save" type="button" aria-label="Save">${icon('check')}</button>
            <button class="btn-icon" data-cmd="cancel" type="button" aria-label="Cancel">${icon('close')}</button>
          </span>
        </div>`;
    }

    return `
      <div class="bm-row${active}" data-id="${bookmark.id}" role="button" tabindex="0">
        <span class="bm-time">${formatTime(bookmark.time)}</span>
        <span class="bm-text ${bookmark.text ? '' : 'is-untitled'}">${escapeHtml(bookmark.text || 'Untitled')}</span>
        <span class="bm-actions">
          <button class="btn-icon" data-cmd="edit" type="button" aria-label="Rename">${icon('pencil')}</button>
          <button class="btn-icon" data-cmd="delete" type="button" aria-label="Delete">${icon('trash')}</button>
        </span>
      </div>`;
  }

  render() {
    // The pending row is merged back in at its own timestamp, so the list stays
    // in time order and the gap does not close until the undo window ends.
    const entries = this.items.map((bookmark) => ({ time: bookmark.time, html: this.renderRow(bookmark) }));
    if (this.pending) {
      entries.push({ time: this.pending.bookmark.time, html: this.renderPendingRow() });
      entries.sort((a, b) => a.time - b.time);
    }

    const rows = entries.length
      ? entries.map((entry) => entry.html).join('')
      : `<div class="bm-empty">
           <p>No bookmarks yet.</p>
           <p class="bm-empty-hint">Press the bookmark key while watching to mark the moment you are on.</p>
         </div>`;

    this.root.innerHTML = `
      <header class="bm-head">
        <h2>Bookmarks <span class="bm-count">${this.items.length}</span></h2>
        <div class="bm-head-actions">
          <button class="btn-icon" data-cmd="export" type="button" aria-label="Export" title="Export as JSON">${icon('folder')}</button>
          <button class="btn-icon" data-cmd="close" type="button" aria-label="Close">${icon('close')}</button>
        </div>
      </header>
      <div class="bm-list">${rows}</div>
    `;
  }

  show() {
    this.render();
    this.root.hidden = false;
    this.open = true;
    requestAnimationFrame(() => this.root.classList.add('is-open'));
  }

  hide() {
    // Closing the panel on a half-typed label keeps it, the same as clicking
    // away from the field does.
    if (this.editingId) this.commitEdit();
    this.open = false;
    this.root.classList.remove('is-open');
    // Wait out the slide-out before hiding, or it vanishes instead of leaving.
    setTimeout(() => {
      if (!this.open) this.root.hidden = true;
    }, 200);
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
  }
}

function updateLabel(state) {
  switch (state.status) {
    case 'checking': return 'Checking for updates…';
    case 'downloading': return `Downloading update… ${state.percent || 0}%`;
    case 'ready': return 'Restart to update';
    case 'none': return 'Up to date';
    case 'error': return 'Check for updates';
    case 'disabled': return 'Updates unavailable';
    default: return 'Check for updates';
  }
}

function updateNote(state) {
  const version = state.appVersion ? `v${state.appVersion}` : '';
  switch (state.status) {
    case 'ready': return `Version ${state.version} is ready to install`;
    case 'none': return version ? `${version} is the latest` : '';
    case 'error': return state.message || 'Last check failed';
    case 'disabled': return 'Running from source — install the app to get updates';
    default: return version;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

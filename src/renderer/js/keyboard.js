// Global shortcut layer.
//
// One listener on the window turns a keydown into an action id and hands it to
// the app. Clicks in the control bar produce the same action ids, so behaviour
// cannot drift between the two.

import { buildLookup, eventToBinding, digitSeek } from './keymap.js';

// Anything that accepts text owns its keys completely — otherwise typing a
// bookmark label would trigger shortcuts on every letter.
function isTextEntry(target) {
  if (!target) return false;
  const tag = target.tagName;
  if (tag === 'INPUT') {
    const type = (target.type || 'text').toLowerCase();
    return !['range', 'checkbox', 'radio', 'button', 'submit'].includes(type);
  }
  return tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

export class KeyboardLayer {
  constructor({ onAction, onDigitSeek, isBlocked } = {}) {
    this.onAction = onAction || (() => {});
    this.onDigitSeek = onDigitSeek || (() => {});
    this.isBlocked = isBlocked || (() => false);
    this.lookup = new Map();
    this.digitEnabled = true;
    this.enabled = true;

    this.listener = (event) => this.handle(event);
    window.addEventListener('keydown', this.listener);
  }

  setKeymap(keymap) {
    this.lookup = buildLookup(keymap);
  }

  setDigitSeekEnabled(enabled) {
    this.digitEnabled = Boolean(enabled);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
  }

  handle(event) {
    if (!this.enabled) return;
    if (event.defaultPrevented) return;
    if (isTextEntry(event.target)) return;
    // A modal surface (the shortcuts editor) is capturing keys of its own.
    if (this.isBlocked()) return;

    const binding = eventToBinding(event);
    if (!binding) return;

    const actionId = this.lookup.get(binding);
    if (actionId) {
      event.preventDefault();
      // Holding a seek key should repeat; holding play/pause should not.
      if (event.repeat && NON_REPEATABLE.has(actionId)) return;
      this.onAction(actionId);
      return;
    }

    if (this.digitEnabled) {
      const ratio = digitSeek(event);
      if (ratio !== null) {
        event.preventDefault();
        this.onDigitSeek(ratio);
      }
    }
  }

  destroy() {
    window.removeEventListener('keydown', this.listener);
  }
}

const NON_REPEATABLE = new Set([
  'playPause',
  'mute',
  'fullscreen',
  'pip',
  'addBookmark',
  'toggleBookmarkList',
  'openSettings',
  'openFile',
  'speedReset',
]);

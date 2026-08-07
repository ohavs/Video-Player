// Keyboard model.
//
// Bindings are stored against `event.code`, not `event.key`. That is deliberate:
// `code` is the physical key, so a binding set on B keeps working when the user
// switches to a Hebrew (or any non-Latin) layout, where `key` would report a
// different character entirely.
//
// A binding is a canonical string: modifiers in fixed order, then the code.
//   "Space", "KeyK", "Shift+Period", "Ctrl+KeyB", "Meta+Comma"

const MODIFIER_CODES = new Set([
  'ShiftLeft', 'ShiftRight',
  'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight',
]);

export const isMac = () => (globalThis.host?.platform ?? '') === 'darwin';

// "Mod" in the defaults below means Cmd on macOS, Ctrl everywhere else.
const expandMod = (binding) => binding.replace('Mod+', isMac() ? 'Meta+' : 'Ctrl+');

export const ACTION_GROUPS = [
  { id: 'playback', label: 'Playback' },
  { id: 'navigation', label: 'Navigation' },
  { id: 'audio', label: 'Audio' },
  { id: 'bookmarks', label: 'Bookmarks' },
  { id: 'view', label: 'View' },
];

// Order here is the order shown in the shortcuts editor.
export const ACTIONS = [
  { id: 'playPause', label: 'Play / pause', group: 'playback', defaults: ['Space', 'KeyK'] },
  { id: 'speedDown', label: 'Slower', group: 'playback', defaults: ['Shift+Comma'] },
  { id: 'speedUp', label: 'Faster', group: 'playback', defaults: ['Shift+Period'] },
  { id: 'speedReset', label: 'Normal speed', group: 'playback', defaults: ['Backquote'] },
  { id: 'frameBack', label: 'Previous frame', group: 'playback', defaults: ['Comma'] },
  { id: 'frameForward', label: 'Next frame', group: 'playback', defaults: ['Period'] },

  { id: 'seekBack', label: 'Back (short)', group: 'navigation', defaults: ['ArrowLeft'] },
  { id: 'seekForward', label: 'Forward (short)', group: 'navigation', defaults: ['ArrowRight'] },
  { id: 'seekBackLong', label: 'Back (long)', group: 'navigation', defaults: ['KeyJ'] },
  { id: 'seekForwardLong', label: 'Forward (long)', group: 'navigation', defaults: ['KeyL'] },
  { id: 'goStart', label: 'Go to start', group: 'navigation', defaults: ['Home'] },
  { id: 'goEnd', label: 'Go to end', group: 'navigation', defaults: ['End'] },

  { id: 'volumeUp', label: 'Volume up', group: 'audio', defaults: ['ArrowUp'] },
  { id: 'volumeDown', label: 'Volume down', group: 'audio', defaults: ['ArrowDown'] },
  { id: 'mute', label: 'Mute', group: 'audio', defaults: ['KeyM'] },

  { id: 'addBookmark', label: 'Add bookmark', group: 'bookmarks', defaults: ['KeyB'] },
  { id: 'prevBookmark', label: 'Previous bookmark', group: 'bookmarks', defaults: ['BracketLeft'] },
  { id: 'nextBookmark', label: 'Next bookmark', group: 'bookmarks', defaults: ['BracketRight'] },
  { id: 'toggleBookmarkList', label: 'Bookmark list', group: 'bookmarks', defaults: ['Mod+KeyB'] },

  { id: 'fullscreen', label: 'Fullscreen', group: 'view', defaults: ['KeyF'] },
  { id: 'pip', label: 'Picture in picture', group: 'view', defaults: ['KeyI'] },
  { id: 'openSettings', label: 'Settings', group: 'view', defaults: ['Mod+Comma'] },
  { id: 'openFile', label: 'Open file', group: 'view', defaults: ['Mod+KeyO'] },
];

export const ACTION_BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

export function defaultKeymap() {
  const map = {};
  for (const action of ACTIONS) map[action.id] = action.defaults.map(expandMod);
  return map;
}

/* ------------------------------------------------------------------ *
 * Event -> binding
 * ------------------------------------------------------------------ */

export function eventToBinding(event) {
  const { code } = event;
  if (!code || MODIFIER_CODES.has(code)) return null;

  const parts = [];
  if (event.metaKey) parts.push('Meta');
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(code);
  return parts.join('+');
}

/* ------------------------------------------------------------------ *
 * Binding -> human label
 * ------------------------------------------------------------------ */

const CODE_LABELS = {
  Space: 'Space',
  Enter: 'Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};

function codeLabel(code) {
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return code;
}

const MODIFIER_LABELS_MAC = { Meta: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
const MODIFIER_LABELS = { Meta: 'Win', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };

export function bindingLabel(binding) {
  if (!binding) return '—';
  const parts = binding.split('+');
  const code = parts.pop();
  const labels = isMac() ? MODIFIER_LABELS_MAC : MODIFIER_LABELS;
  const mods = parts.map((m) => labels[m] || m);
  const joiner = isMac() ? '' : ' + ';
  const key = codeLabel(code);
  return mods.length ? `${mods.join(joiner)}${joiner}${key}` : key;
}

/* ------------------------------------------------------------------ *
 * Lookups and conflicts
 * ------------------------------------------------------------------ */

// Flattens { actionId: [binding] } into { binding: actionId } for O(1) dispatch.
export function buildLookup(keymap) {
  const lookup = new Map();
  for (const [actionId, bindings] of Object.entries(keymap || {})) {
    if (!ACTION_BY_ID.has(actionId)) continue;
    for (const binding of bindings || []) {
      if (binding && !lookup.has(binding)) lookup.set(binding, actionId);
    }
  }
  return lookup;
}

// Which other action already owns this binding, if any.
export function findConflict(keymap, binding, exceptActionId) {
  for (const [actionId, bindings] of Object.entries(keymap || {})) {
    if (actionId === exceptActionId) continue;
    if ((bindings || []).includes(binding)) return actionId;
  }
  return null;
}

// Digits are handled as one switchable feature rather than ten bindings, since
// "press 4 to jump to 40%" is a single idea.
export function digitSeek(event) {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  const match = /^Digit(\d)$/.exec(event.code);
  return match ? Number(match[1]) / 10 : null;
}

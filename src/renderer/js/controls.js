// The control bar: transport row plus the scrubber host above it.
//
// This module owns DOM and nothing else. It never touches the video element —
// it reports intent as action ids, the same vocabulary the keyboard layer uses,
// so a click and a keypress travel exactly one code path.

import { icon, volumeIcon } from './icons.js';
import { formatPair, formatSpeed } from './format.js';
import { bindingLabel } from './keymap.js';

export class Controls {
  constructor(root, { onAction, onVolumeInput } = {}) {
    this.root = root;
    this.onAction = onAction || (() => {});
    this.onVolumeInput = onVolumeInput || (() => {});
    this.build();
    this.bind();
  }

  build() {
    this.root.className = 'controls';
    this.root.innerHTML = `
      <div class="scrubber-host" data-role="scrubberHost"></div>
      <div class="control-row">
        <div class="control-group control-left">
          <button class="cbtn" data-action="playPause" data-role="play" type="button" aria-label="Play">
            ${icon('play')}
          </button>

          <div class="volume" data-role="volume">
            <button class="cbtn" data-action="mute" data-role="mute" type="button" aria-label="Mute">
              ${volumeIcon(1)}
            </button>
            <div class="volume-slot">
              <input class="volume-range" data-role="volumeRange" type="range"
                     min="0" max="100" value="100" step="1" aria-label="Volume" />
            </div>
          </div>

          <div class="time" data-role="time">
            <span class="time-current" data-role="timeCurrent">0:00</span>
            <span class="time-sep">/</span>
            <span class="time-duration" data-role="timeDuration">0:00</span>
          </div>

          <div class="chapter" data-role="chapter" hidden>
            <span class="chapter-dot"></span>
            <span class="chapter-name" data-role="chapterName"></span>
          </div>
        </div>

        <div class="control-group control-right">
          <span class="rate-badge" data-role="rateBadge" hidden>1×</span>

          <button class="cbtn cbtn-accent" data-action="addBookmark" data-role="addBookmark"
                  type="button" aria-label="Add bookmark">
            ${icon('bookmarkAdd')}
          </button>
          <button class="cbtn" data-action="toggleBookmarkList" data-role="bookmarkList"
                  type="button" aria-label="Bookmark list">
            ${icon('list')}
            <span class="cbtn-count" data-role="bookmarkCount" hidden>0</span>
          </button>
          <button class="cbtn" data-action="toggleTrim" data-role="trim"
                  type="button" aria-label="Trim and export" hidden>
            ${icon('scissors')}
          </button>
          <button class="cbtn" data-action="openSettings" data-role="settings"
                  type="button" aria-label="Settings">
            ${icon('settings')}
          </button>
          <button class="cbtn" data-action="pip" data-role="pip"
                  type="button" aria-label="Picture in picture">
            ${icon('pip')}
          </button>
          <button class="cbtn" data-action="fullscreen" data-role="fullscreen"
                  type="button" aria-label="Fullscreen">
            ${icon('expand')}
          </button>
        </div>
      </div>
    `;

    const q = (role) => this.root.querySelector(`[data-role="${role}"]`);
    this.scrubberHost = q('scrubberHost');
    this.playEl = q('play');
    this.muteEl = q('mute');
    this.volumeRangeEl = q('volumeRange');
    this.timeCurrentEl = q('timeCurrent');
    this.timeDurationEl = q('timeDuration');
    this.chapterEl = q('chapter');
    this.chapterNameEl = q('chapterName');
    this.rateBadgeEl = q('rateBadge');
    this.bookmarkCountEl = q('bookmarkCount');
    this.pipEl = q('pip');
    this.fullscreenEl = q('fullscreen');
    this.bookmarkListEl = q('bookmarkList');
    this.trimEl = q('trim');
  }

  bind() {
    this.root.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button || !this.root.contains(button)) return;
      event.preventDefault();
      // Returning focus to the surface keeps the space bar meaning "play/pause"
      // instead of "press the button I just clicked again".
      button.blur();
      this.onAction(button.dataset.action);
    });

    this.volumeRangeEl.addEventListener('input', () => {
      this.onVolumeInput(Number(this.volumeRangeEl.value) / 100);
    });

    // The bar must not swallow clicks meant for the video surface behind it.
    this.root.addEventListener('pointerdown', (event) => event.stopPropagation());
    this.root.addEventListener('dblclick', (event) => event.stopPropagation());
  }

  /* ---------------- state in ---------------- */

  setPlaying(playing) {
    this.playEl.innerHTML = icon(playing ? 'pause' : 'play');
    this.playEl.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    this.applyHint(this.playEl, 'playPause', playing ? 'Pause' : 'Play');
  }

  setEnded(ended) {
    if (!ended) return;
    this.playEl.innerHTML = icon('replay');
    this.playEl.setAttribute('aria-label', 'Replay');
  }

  setTime(current, duration) {
    const pair = formatPair(current, duration);
    if (this.timeCurrentEl.textContent !== pair.current) this.timeCurrentEl.textContent = pair.current;
    if (this.timeDurationEl.textContent !== pair.duration) this.timeDurationEl.textContent = pair.duration;
  }

  setVolume(level, muted) {
    const effective = muted ? 0 : level;
    this.muteEl.innerHTML = volumeIcon(effective);
    this.muteEl.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    this.applyHint(this.muteEl, 'mute', muted ? 'Unmute' : 'Mute');
    // Skip while the user is dragging the slider, or the value fights the drag.
    if (document.activeElement !== this.volumeRangeEl) {
      this.volumeRangeEl.value = String(Math.round(effective * 100));
    }
    this.volumeRangeEl.style.setProperty('--filled', `${effective * 100}%`);
  }

  setRate(rate) {
    const isNormal = Math.abs(rate - 1) < 0.001;
    this.rateBadgeEl.hidden = isNormal;
    this.rateBadgeEl.textContent = formatSpeed(rate);
  }

  setChapter(title) {
    const text = (title || '').trim();
    this.chapterEl.hidden = !text;
    if (text) this.chapterNameEl.textContent = text;
  }

  setBookmarkCount(count) {
    this.bookmarkCountEl.hidden = !count;
    this.bookmarkCountEl.textContent = String(count);
  }

  setFullscreen(active) {
    this.fullscreenEl.innerHTML = icon(active ? 'compress' : 'expand');
    this.fullscreenEl.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Fullscreen');
    this.applyHint(this.fullscreenEl, 'fullscreen', active ? 'Exit fullscreen' : 'Fullscreen');
  }

  setPipAvailable(available) {
    this.pipEl.hidden = !available;
  }

  setBookmarkListOpen(open) {
    this.bookmarkListEl.classList.toggle('is-active', Boolean(open));
  }

  setTrimOpen(open) {
    this.trimEl.classList.toggle('is-active', Boolean(open));
  }

  // Hidden rather than disabled when the engine is missing: a permanently dead
  // button teaches nothing, and this is not a state the user can fix from here.
  setTrimAvailable(available) {
    this.trimEl.hidden = !available;
  }

  setEnabled(enabled) {
    this.root.classList.toggle('is-disabled', !enabled);
    for (const button of this.root.querySelectorAll('[data-action]')) {
      button.disabled = !enabled;
    }
    this.volumeRangeEl.disabled = !enabled;
  }

  /* ---------------- shortcut hints ---------------- */

  // Tooltips show the binding actually in force, so rebinding a key updates
  // what the UI claims about itself.
  setKeymap(keymap) {
    this.keymap = keymap || {};
    const labels = {
      playPause: 'Play/pause',
      mute: 'Mute',
      addBookmark: 'Add bookmark',
      toggleBookmarkList: 'Bookmark list',
      toggleTrim: 'Trim & export',
      openSettings: 'Settings',
      pip: 'Picture in picture',
      fullscreen: 'Fullscreen',
    };
    for (const button of this.root.querySelectorAll('[data-action]')) {
      const action = button.dataset.action;
      this.applyHint(button, action, labels[action] || button.getAttribute('aria-label') || '');
    }
  }

  applyHint(button, actionId, label) {
    const binding = this.keymap?.[actionId]?.[0];
    button.title = binding ? `${label} (${bindingLabel(binding)})` : label;
  }
}

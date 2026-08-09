// The trim bar: the strip that appears above the controls once you are cutting
// a clip, and the running state of an export.
//
// It owns no timing logic. The range lives in the coordinator, which is also
// what drives the handles on the scrubber, so the two can never disagree about
// where the cut is.

import { icon } from './icons.js';
import { formatTime, formatFileSize } from './format.js';

// Tenths matter when placing a cut, and the shared formatTime floors to whole
// seconds — so marks get their own stamp rather than looking like they snapped.
//
// Rounded to tenths *before* being split, not after. Taking the fraction first
// reads 24.9 as 24.8, because a mark computed as 25.0 - 0.1 is really
// 24.899999999999999 and flooring its fraction throws the tenth away.
function stamp(seconds) {
  const tenths = Math.round(Math.max(0, Number(seconds) || 0) * 10);
  return `${formatTime(Math.floor(tenths / 10))}.${tenths % 10}`;
}

// Written to answer "which do I pick?" rather than to describe how each works.
// On most footage the two produce near-identical clips, so the note has to say
// when the difference is worth paying for instead of only that it exists.
const MODE_NOTES = {
  fast:
    'Copies the video untouched — finishes in seconds, pixel-for-pixel identical to the original. '
    + 'The start snaps back to the nearest keyframe, so the clip may begin a moment early, never late. '
    + 'Use this unless the first frame has to be exact.',
  exact:
    'Re-encodes so the clip starts on precisely the frame you marked. Takes roughly as long as the clip '
    + 'itself and loses a little quality. Worth it only when that leading moment matters.',
};

export class TrimBar {
  constructor(host, { onCommand } = {}) {
    this.onCommand = onCommand || (() => {});
    this.open = false;
    this.range = { in: 0, out: 0 };
    this.duration = 0;
    this.mode = 'fast';
    this.job = null;

    this.root = document.createElement('div');
    this.root.className = 'trimbar';
    this.root.hidden = true;
    this.build();
    host.appendChild(this.root);

    this.root.addEventListener('pointerdown', (event) => event.stopPropagation());
    this.root.addEventListener('dblclick', (event) => event.stopPropagation());
    this.root.addEventListener('click', (event) => this.handleClick(event));
  }

  build() {
    this.root.innerHTML = `
      <div class="trim-idle" data-role="idle">
        <span class="trim-badge">${icon('scissors')}<span>Trim</span></span>

        <div class="trim-marks">
          <button class="trim-mark" data-cmd="gotoIn" type="button" title="Jump to the start mark">
            <small>In</small><b data-role="inStamp">0:00.0</b>
          </button>
          <button class="trim-set" data-cmd="setIn" type="button" title="Move the start mark to the playhead">Set</button>

          <span class="trim-span" aria-hidden="true"></span>

          <button class="trim-mark" data-cmd="gotoOut" type="button" title="Jump to the end mark">
            <small>Out</small><b data-role="outStamp">0:00.0</b>
          </button>
          <button class="trim-set" data-cmd="setOut" type="button" title="Move the end mark to the playhead">Set</button>

          <span class="trim-length"><small>Length</small><b data-role="lengthStamp">0:00.0</b></span>
        </div>

        <div class="trim-tail">
          <span class="chip-group trim-modes">
            <button class="chip" data-mode="fast" type="button">Fast</button>
            <button class="chip" data-mode="exact" type="button">Exact</button>
          </span>
          <button class="trim-export" data-cmd="export" type="button">${icon('download')}<span>Export…</span></button>
          <button class="btn-icon" data-cmd="close" type="button" aria-label="Leave trim mode">${icon('close')}</button>
        </div>
      </div>

      <div class="trim-busy" data-role="busy" hidden>
        <span class="trim-busy-text" data-role="busyText">Exporting…</span>
        <span class="trim-progress"><span data-role="busyFill"></span></span>
        <button class="trim-cancel" data-cmd="cancel" type="button">Cancel</button>
      </div>

      <p class="trim-note" data-role="note"></p>
    `;

    const q = (role) => this.root.querySelector(`[data-role="${role}"]`);
    this.idleEl = q('idle');
    this.busyEl = q('busy');
    this.inEl = q('inStamp');
    this.outEl = q('outStamp');
    this.lengthEl = q('lengthStamp');
    this.noteEl = q('note');
    this.busyTextEl = q('busyText');
    this.busyFillEl = q('busyFill');
    this.exportEl = this.root.querySelector('[data-cmd="export"]');
    this.modeEls = [...this.root.querySelectorAll('[data-mode]')];
  }

  handleClick(event) {
    const modeButton = event.target.closest('[data-mode]');
    if (modeButton) {
      this.onCommand('mode', modeButton.dataset.mode);
      return;
    }
    const cmd = event.target.closest('[data-cmd]')?.dataset.cmd;
    if (cmd) this.onCommand(cmd);
  }

  /* ---------------- state in ---------------- */

  setRange(range, duration) {
    this.range = { in: range.in, out: range.out };
    this.duration = duration || 0;
    this.paint();
  }

  setMode(mode) {
    this.mode = mode === 'exact' ? 'exact' : 'fast';
    this.paint();
  }

  // `job` is null when idle, otherwise the progress record from the main
  // process. Everything except the running state is reported as a toast by the
  // coordinator, so only 'running' changes what this bar shows.
  setJob(job) {
    this.job = job && job.status === 'running' ? job : null;
    this.paint();
  }

  paint() {
    if (!this.open) return;

    const length = Math.max(0, this.range.out - this.range.in);
    this.inEl.textContent = stamp(this.range.in);
    this.outEl.textContent = stamp(this.range.out);
    this.lengthEl.textContent = stamp(length);

    for (const button of this.modeEls) {
      button.classList.toggle('is-on', button.dataset.mode === this.mode);
    }

    // Nothing shorter than a tenth of a second is a clip, and ffmpeg would
    // refuse it anyway — better to grey the button than to explain the failure.
    const tooShort = length < 0.1;
    this.exportEl.disabled = tooShort || Boolean(this.job);
    this.root.classList.toggle('is-empty', tooShort);

    const busy = Boolean(this.job);
    this.idleEl.hidden = busy;
    this.busyEl.hidden = !busy;

    if (busy) {
      const percent = Math.max(0, Math.min(100, this.job.percent || 0));
      const label = this.job.kind === 'convert' ? 'Converting' : 'Exporting';
      // Converting a file the player could not open means there is no known
      // duration to measure against, so it reports what it has written instead
      // of a percentage it would have to invent.
      const measured = (this.job.totalSeconds || 0) > 0;
      this.busyTextEl.textContent = measured
        ? `${label}… ${percent}%`
        : `${label}… ${formatTime(this.job.seconds || 0)} written`;
      this.busyFillEl.style.width = measured ? `${percent}%` : '';
      this.root.classList.toggle('is-indeterminate', !measured);
      this.noteEl.textContent = 'You can keep watching while this runs.';
    } else {
      this.root.classList.remove('is-indeterminate');
      this.noteEl.textContent = tooShort
        ? 'Drag the handles on the timeline, or use Set to place a mark at the playhead.'
        : MODE_NOTES[this.mode];
    }
  }

  /* ---------------- visibility ---------------- */

  show() {
    this.open = true;
    this.root.hidden = false;
    this.paint();
    requestAnimationFrame(() => this.root.classList.add('is-open'));
  }

  hide() {
    this.open = false;
    this.root.classList.remove('is-open');
    this.root.hidden = true;
  }
}

// Named here rather than in the coordinator so the wording that describes a
// finished export lives next to the wording that describes a running one.
export function describeResult(result) {
  if (!result || result.status !== 'done') return '';

  const size = formatFileSize(result.size);
  if (result.kind === 'convert') {
    return size ? `Converted copy saved · ${size}` : 'Converted copy saved';
  }

  const parts = ['Clip saved'];
  if (size) parts.push(size);

  // A fast cut that snapped back to an earlier keyframe wrote more than was
  // asked for. Reporting by how much is what turns "Fast and Exact seem the
  // same" into a number measured on the user's own file — and on footage with
  // dense keyframes the honest answer is that they very nearly are.
  const extra = (result.writtenSeconds || 0) - (result.requestedSeconds || 0);
  if (extra > 0.15) parts.push(`starts ${extra.toFixed(1)}s early (nearest keyframe)`);

  return parts.join(' · ');
}

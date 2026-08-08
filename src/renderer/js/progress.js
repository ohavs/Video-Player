// The scrubber.
//
// Two rendering modes over the same data:
//   segments – the bar is split at every bookmark, with a gap between chapters
//   points   – one continuous bar with a tick at every bookmark
//
// Structure is rebuilt only when the chapter layout actually changes; the
// per-frame path just writes widths, so scrubbing stays cheap.
//
// The track is forced LTR even when the app is in Hebrew: a timeline reads as
// time flowing left-to-right in every locale, and flipping it would make the
// playhead run backwards.

import { formatTime, clamp } from './format.js';

export class Scrubber {
  constructor(root, handlers = {}) {
    this.root = root;
    this.handlers = handlers;

    this.duration = 0;
    this.currentTime = 0;
    this.bufferedEnd = 0;
    this.segments = [];
    this.bookmarks = [];
    this.mode = 'segments';

    this.hoverRatio = null;
    this.scrubbing = false;
    this.pointerId = null;
    this.layoutKey = '';

    this.trim = null;          // { in, out } in display seconds, or null
    this.draggingEdge = null;  // 'in' | 'out' while a handle is held

    this.build();
    this.bind();
    this.bindTrim();
  }

  build() {
    this.root.classList.add('scrubber');
    this.root.setAttribute('role', 'slider');
    this.root.setAttribute('tabindex', '0');
    this.root.setAttribute('aria-label', 'Seek');
    this.root.setAttribute('aria-valuemin', '0');

    this.root.innerHTML = `
      <div class="scrub-hit" data-role="hit">
        <div class="scrub-track" data-role="track"></div>
        <div class="scrub-marks" data-role="marks"></div>
        <div class="scrub-trim" data-role="trimLayer" hidden>
          <span class="trim-shade" data-role="trimBefore"></span>
          <span class="trim-shade" data-role="trimAfter"></span>
          <span class="trim-band" data-role="trimBand"></span>
          <span class="trim-grip" data-role="trimInGrip" data-edge="in"
                role="slider" tabindex="0" aria-label="Clip start"></span>
          <span class="trim-grip" data-role="trimOutGrip" data-edge="out"
                role="slider" tabindex="0" aria-label="Clip end"></span>
        </div>
        <div class="scrub-knob" data-role="knob"></div>
      </div>
      <div class="scrub-tip" data-role="tip" hidden>
        <span class="tip-title" data-role="tipTitle"></span>
        <span class="tip-time" data-role="tipTime">0:00</span>
      </div>
    `;

    this.hitEl = this.root.querySelector('[data-role="hit"]');
    this.trackEl = this.root.querySelector('[data-role="track"]');
    this.marksEl = this.root.querySelector('[data-role="marks"]');
    this.knobEl = this.root.querySelector('[data-role="knob"]');
    this.tipEl = this.root.querySelector('[data-role="tip"]');
    this.tipTitleEl = this.root.querySelector('[data-role="tipTitle"]');
    this.tipTimeEl = this.root.querySelector('[data-role="tipTime"]');

    // Not "trim": the control bar's trim button already owns that role name, and
    // the scrubber lives inside the control bar — a shared name makes an
    // unscoped lookup silently return whichever comes first in the document.
    this.trimEl = this.root.querySelector('[data-role="trimLayer"]');
    this.trimBeforeEl = this.root.querySelector('[data-role="trimBefore"]');
    this.trimAfterEl = this.root.querySelector('[data-role="trimAfter"]');
    this.trimBandEl = this.root.querySelector('[data-role="trimBand"]');
    this.trimGrips = [
      this.root.querySelector('[data-role="trimInGrip"]'),
      this.root.querySelector('[data-role="trimOutGrip"]'),
    ];
  }

  bind() {
    this.hitEl.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !this.duration) return;
      event.preventDefault();
      this.scrubbing = true;
      this.pointerId = event.pointerId;
      // Capture means the drag keeps working past the edges of the bar — the
      // pointer can leave the window entirely and still scrub.
      this.hitEl.setPointerCapture(event.pointerId);
      this.root.classList.add('is-scrubbing');
      const ratio = this.ratioFromEvent(event);
      this.hoverRatio = ratio;
      this.handlers.onScrubStart?.(ratio * this.duration);
      this.handlers.onSeek?.(ratio * this.duration, true);
      this.paintHover();
    });

    this.hitEl.addEventListener('pointermove', (event) => {
      if (!this.duration) return;
      const ratio = this.ratioFromEvent(event);
      this.hoverRatio = ratio;
      if (this.scrubbing) this.handlers.onSeek?.(ratio * this.duration, true);
      this.paintHover();
    });

    const endScrub = (event) => {
      if (!this.scrubbing || (this.pointerId !== null && event.pointerId !== this.pointerId)) return;
      this.scrubbing = false;
      this.pointerId = null;
      this.root.classList.remove('is-scrubbing');
      try {
        this.hitEl.releasePointerCapture(event.pointerId);
      } catch {
        // Capture may already be gone; nothing to release.
      }
      const ratio = this.ratioFromEvent(event);
      this.handlers.onSeek?.(ratio * this.duration, false);
      this.handlers.onScrubEnd?.(ratio * this.duration);
    };

    this.hitEl.addEventListener('pointerup', endScrub);
    this.hitEl.addEventListener('pointercancel', endScrub);

    this.hitEl.addEventListener('pointerenter', () => this.root.classList.add('is-hover'));
    this.hitEl.addEventListener('pointerleave', () => {
      this.root.classList.remove('is-hover');
      if (!this.scrubbing) {
        this.hoverRatio = null;
        this.paintHover();
      }
    });
  }

  // The trim handles sit inside the scrub hit area, so every one of these
  // listeners stops propagation: without it, grabbing a handle would also start
  // a seek on the bar underneath and the playhead would jump to the handle.
  bindTrim() {
    for (const grip of this.trimGrips) {
      grip.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || !this.duration || !this.trim) return;
        event.preventDefault();
        event.stopPropagation();
        this.draggingEdge = grip.dataset.edge;
        grip.setPointerCapture(event.pointerId);
        this.root.classList.add('is-trimming');
        this.handlers.onTrimStart?.(this.draggingEdge);
      });

      grip.addEventListener('pointermove', (event) => {
        if (!this.draggingEdge) return;
        event.stopPropagation();
        this.handlers.onTrimDrag?.(this.draggingEdge, this.ratioFromEvent(event) * this.duration);
      });

      const endDrag = (event) => {
        if (!this.draggingEdge) return;
        event.stopPropagation();
        const edge = this.draggingEdge;
        this.draggingEdge = null;
        this.root.classList.remove('is-trimming');
        try {
          grip.releasePointerCapture(event.pointerId);
        } catch {
          // Capture may already be gone.
        }
        this.handlers.onTrimEnd?.(edge);
      };

      grip.addEventListener('pointerup', endDrag);
      grip.addEventListener('pointercancel', endDrag);

      // Arrow keys nudge a handle a frame-ish at a time, with Shift for a
      // coarser step — the only way to place a mark precisely without a mouse.
      grip.addEventListener('keydown', (event) => {
        if (!this.trim) return;
        const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
        if (!direction) return;
        event.preventDefault();
        event.stopPropagation();
        const edge = grip.dataset.edge;
        const step = event.shiftKey ? 1 : 0.04;
        this.handlers.onTrimDrag?.(edge, this.trim[edge] + direction * step);
        this.handlers.onTrimEnd?.(edge);
      });
    }
  }

  ratioFromEvent(event) {
    const rect = this.hitEl.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return clamp((event.clientX - rect.left) / rect.width, 0, 1);
  }

  /* ---------------- data in ---------------- */

  setDuration(duration) {
    this.duration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    this.root.setAttribute('aria-valuemax', String(Math.floor(this.duration)));
    this.relayout();
  }

  setMode(mode) {
    const next = mode === 'points' ? 'points' : 'segments';
    if (next === this.mode) return;
    this.mode = next;
    this.root.dataset.mode = next;
    this.relayout();
  }

  setBookmarks(items) {
    this.bookmarks = items || [];
    this.relayout();
  }

  setSegments(segments) {
    this.segments = segments || [];
    this.relayout();
  }

  setTime(time) {
    this.currentTime = Number.isFinite(time) ? time : 0;
    this.paint();
  }

  // Already resolved to display time by the player, which owns the offset.
  setBufferedEnd(end) {
    this.bufferedEnd = Number.isFinite(end) ? end : 0;
    this.paint();
  }

  // `range` is { in, out } in display seconds, or null to leave trim mode.
  setTrim(range) {
    this.trim = range && Number.isFinite(range.in) && Number.isFinite(range.out)
      ? { in: range.in, out: range.out }
      : null;
    this.root.classList.toggle('has-trim', Boolean(this.trim));
    this.trimEl.hidden = !this.trim;
    this.paintTrim();
  }

  /* ---------------- structure ---------------- */

  // Rebuilding the DOM on every frame would be wasteful, so the segment
  // boundaries are hashed and the rebuild only runs when they really change.
  relayout() {
    const layout = this.mode === 'segments' && this.segments.length > 1
      ? this.segments.map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)}`).join('|')
      : `single:${this.duration.toFixed(2)}`;
    const key = `${this.mode}:${layout}`;
    if (key === this.layoutKey) {
      this.paintMarks();
      this.paint();
      return;
    }
    this.layoutKey = key;

    this.trackEl.innerHTML = '';
    this.cells = [];

    const cellsData =
      this.mode === 'segments' && this.segments.length > 1
        ? this.segments
        : [{ start: 0, end: this.duration || 1, title: '', bookmark: null }];

    for (const segment of cellsData) {
      const span = Math.max(0.0001, segment.end - segment.start);
      const cell = document.createElement('div');
      cell.className = 'seg';
      cell.style.flexGrow = String(span);
      cell.innerHTML = `
        <span class="seg-buffered"></span>
        <span class="seg-hover"></span>
        <span class="seg-played"></span>
      `;
      this.trackEl.appendChild(cell);
      this.cells.push({
        el: cell,
        start: segment.start,
        end: segment.end,
        span,
        buffered: cell.querySelector('.seg-buffered'),
        hover: cell.querySelector('.seg-hover'),
        played: cell.querySelector('.seg-played'),
      });
    }

    this.paintMarks();
    this.paint();
  }

  paintMarks() {
    this.marksEl.innerHTML = '';
    // In segments mode the gaps between chapters already show where the marks
    // are; drawing ticks on top would be redundant.
    if (this.mode !== 'points' || !this.duration) return;
    for (const bookmark of this.bookmarks) {
      if (bookmark.time < 0 || bookmark.time > this.duration) continue;
      const mark = document.createElement('span');
      mark.className = 'scrub-mark';
      mark.style.left = `${(bookmark.time / this.duration) * 100}%`;
      mark.dataset.id = bookmark.id;
      mark.title = bookmark.text || formatTime(bookmark.time);
      this.marksEl.appendChild(mark);
    }
  }

  /* ---------------- per-frame paint ---------------- */

  paint() {
    if (!this.cells) return;
    const played = this.duration ? clamp(this.currentTime / this.duration, 0, 1) : 0;

    for (const cell of this.cells) {
      cell.played.style.transform = `scaleX(${fillOf(this.currentTime, cell)})`;
      cell.buffered.style.transform = `scaleX(${fillOf(this.bufferedEnd, cell)})`;
    }

    this.knobEl.style.left = `${played * 100}%`;
    this.root.setAttribute('aria-valuenow', String(Math.floor(this.currentTime)));
    this.root.setAttribute('aria-valuetext', formatTime(this.currentTime));
    this.paintHover();
    // Cheap enough to redo here: it exits immediately when trim is off, and
    // keeping it on the paint path means a duration change can never leave the
    // handles sitting at stale positions.
    this.paintTrim();
  }

  paintTrim() {
    if (!this.trim || !this.duration) return;
    const from = clamp(this.trim.in / this.duration, 0, 1) * 100;
    const to = clamp(this.trim.out / this.duration, 0, 1) * 100;

    // Everything outside the selection is dimmed, so the clip reads as the part
    // of the timeline that survives rather than as a highlight laid on top.
    this.trimBeforeEl.style.left = '0%';
    this.trimBeforeEl.style.width = `${from}%`;
    this.trimAfterEl.style.left = `${to}%`;
    this.trimAfterEl.style.width = `${Math.max(0, 100 - to)}%`;

    this.trimBandEl.style.left = `${from}%`;
    this.trimBandEl.style.width = `${Math.max(0, to - from)}%`;

    this.trimGrips[0].style.left = `${from}%`;
    this.trimGrips[1].style.left = `${to}%`;

    for (const [index, grip] of this.trimGrips.entries()) {
      const time = index === 0 ? this.trim.in : this.trim.out;
      grip.setAttribute('aria-valuemin', '0');
      grip.setAttribute('aria-valuemax', String(Math.floor(this.duration)));
      grip.setAttribute('aria-valuenow', String(Math.floor(time)));
      grip.setAttribute('aria-valuetext', formatTime(time));
    }
  }

  paintHover() {
    if (!this.cells) return;
    const ratio = this.hoverRatio;

    if (ratio === null) {
      for (const cell of this.cells) cell.hover.style.transform = 'scaleX(0)';
      this.tipEl.hidden = true;
      return;
    }

    const time = ratio * this.duration;
    for (const cell of this.cells) cell.hover.style.transform = `scaleX(${fillOf(time, cell)})`;

    const chapter = this.chapterAt(time);
    this.tipTimeEl.textContent = formatTime(time);
    if (chapter && chapter.title) {
      this.tipTitleEl.textContent = chapter.title;
      this.tipTitleEl.hidden = false;
    } else {
      this.tipTitleEl.textContent = '';
      this.tipTitleEl.hidden = true;
    }

    this.tipEl.hidden = false;
    // Keep the tooltip inside the bar's own width rather than letting it hang
    // off the window edge near 0:00 and the end.
    const rect = this.hitEl.getBoundingClientRect();
    const tipWidth = this.tipEl.offsetWidth || 64;
    const centre = ratio * rect.width;
    const left = clamp(centre, tipWidth / 2 + 4, Math.max(tipWidth / 2 + 4, rect.width - tipWidth / 2 - 4));
    this.tipEl.style.left = `${left}px`;
  }

  chapterAt(time) {
    if (!this.segments.length) return null;
    for (const segment of this.segments) {
      if (time >= segment.start && time < segment.end) return segment;
    }
    return this.segments[this.segments.length - 1];
  }
}

// How much of one cell is covered at `time`, as a 0..1 scale factor.
function fillOf(time, cell) {
  if (time <= cell.start) return 0;
  if (time >= cell.end) return 1;
  return clamp((time - cell.start) / cell.span, 0, 1);
}

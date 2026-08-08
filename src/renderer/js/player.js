// Thin wrapper over the <video> element.
//
// The browser already does decoding, buffering and accurate seeking, so this
// exists only to give the rest of the app a stable vocabulary (toggle, seekBy,
// stepFrame, …) and to normalise the few things the element gets awkward about:
// frame stepping, fullscreen and picture-in-picture.

import { clamp } from './format.js';

const DEFAULT_FPS = 30;

export class Player {
  constructor(videoEl) {
    this.el = videoEl;
    this.fps = DEFAULT_FPS;
    this.fpsSamples = [];
    this.frameHandle = null;
    this.file = null;

    // Where this file's timeline really starts and how long it really runs.
    // See refreshTimeline().
    this.origin = 0;
    this.span = 0;

    // 'metadata', not 'auto'. Duration and dimensions still arrive immediately,
    // but Chromium no longer tries to pull the whole file up front — on a
    // multi-gigabyte recording that read is what makes opening feel frozen.
    // Playback buffers on demand through range requests.
    this.el.preload = 'metadata';
    this.el.playsInline = true;

    // Registered here, in the constructor, so these run before the app's own
    // handlers for the same events — the app reads duration inside them.
    for (const event of ['loadedmetadata', 'durationchange', 'progress', 'seeked']) {
      this.el.addEventListener(event, () => this.refreshTimeline());
    }
  }

  /* ---------------- timeline ---------------- */

  // `duration` cannot be trusted. Plenty of real files — dashcam recordings in
  // particular — carry a broken or absolute-timestamped header, reporting
  // durations of hundreds of hours and a timeline that does not start at zero.
  // `seekable` reports what the decoder will actually let us reach, so that is
  // what the UI is built on: everything outside this class works in display
  // time starting at 0, and the offset is applied here.
  refreshTimeline() {
    const seekable = this.el.seekable;
    let origin = 0;
    let end = 0;

    if (seekable && seekable.length) {
      const first = seekable.start(0);
      const last = seekable.end(seekable.length - 1);
      if (Number.isFinite(first) && first >= 0) origin = first;
      if (Number.isFinite(last) && last > origin) end = last;
    }

    if (!end) {
      const reported = this.el.duration;
      if (Number.isFinite(reported) && reported > 0) end = origin + reported;
    }

    this.origin = origin;
    this.span = Math.max(0, end - origin);
  }

  /* ---------------- source ---------------- */

  load(file) {
    this.file = file;
    this.fps = DEFAULT_FPS;
    this.fpsSamples = [];
    this.origin = 0;
    this.span = 0;
    this.el.src = file.url;
    this.el.load();
    this.measureFrameRate();
  }

  unload() {
    this.file = null;
    this.el.removeAttribute('src');
    this.el.load();
  }

  /* ---------------- transport ---------------- */

  // Display time: 0 .. span, regardless of what the file's header claims.
  get duration() {
    return this.span;
  }

  get currentTime() {
    if (this.span <= 0) return 0;
    return clamp((this.el.currentTime || 0) - this.origin, 0, this.span);
  }

  get paused() {
    return this.el.paused;
  }

  get ended() {
    return this.el.ended;
  }

  play() {
    // Autoplay can be rejected; a rejected promise here is not a real error.
    return this.el.play().catch(() => {});
  }

  pause() {
    this.el.pause();
  }

  toggle() {
    if (this.el.paused) this.play();
    else this.pause();
  }

  seek(time) {
    if (this.span <= 0) return;
    this.el.currentTime = this.origin + clamp(time, 0, Math.max(0, this.span - 0.02));
  }

  seekBy(delta) {
    this.seek(this.currentTime + delta);
  }

  seekRatio(ratio) {
    if (!this.duration) return;
    this.seek(clamp(ratio, 0, 1) * this.duration);
  }

  // Stepping only makes sense paused; playing through it would fight the clock.
  stepFrame(direction) {
    this.pause();
    this.seek(this.currentTime + direction * (1 / this.fps));
  }

  /* ---------------- audio ---------------- */

  get volume() {
    return this.el.volume;
  }

  set volume(value) {
    const next = clamp(value, 0, 1);
    this.el.volume = next;
    // Nudging the volume up is an implicit request to hear something.
    if (next > 0 && this.el.muted) this.el.muted = false;
  }

  get muted() {
    return this.el.muted;
  }

  set muted(value) {
    this.el.muted = Boolean(value);
  }

  toggleMute() {
    this.el.muted = !this.el.muted;
    // Unmuting a track sitting at zero would still be silent.
    if (!this.el.muted && this.el.volume === 0) this.el.volume = 0.5;
  }

  adjustVolume(delta) {
    this.volume = this.el.volume + delta;
  }

  get effectiveVolume() {
    return this.el.muted ? 0 : this.el.volume;
  }

  /* ---------------- rate ---------------- */

  get rate() {
    return this.el.playbackRate;
  }

  set rate(value) {
    this.el.playbackRate = clamp(value, 0.0625, 16);
  }

  get loop() {
    return this.el.loop;
  }

  set loop(value) {
    this.el.loop = Boolean(value);
  }

  /* ---------------- display ---------------- */

  get buffered() {
    return this.el.buffered;
  }

  // How far the contiguous buffer under the playhead reaches, in display time.
  // Disjoint ranges elsewhere in the file are deliberately ignored — painting
  // them all is noise rather than information.
  bufferedEnd() {
    const ranges = this.el.buffered;
    if (!ranges || !ranges.length || this.span <= 0) return 0;

    const raw = this.el.currentTime || 0;
    let end = 0;
    for (let i = 0; i < ranges.length; i += 1) {
      if (ranges.start(i) <= raw + 0.5 && ranges.end(i) >= raw) {
        end = Math.max(end, ranges.end(i));
      }
    }
    return end ? clamp(end - this.origin, 0, this.span) : 0;
  }

  async enterFullscreen(container) {
    const target = container || this.el;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await target.requestFullscreen();
    } catch (err) {
      console.error('[player] fullscreen failed', err);
    }
  }

  get isFullscreen() {
    return Boolean(document.fullscreenElement);
  }

  async togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (document.pictureInPictureEnabled) await this.el.requestPictureInPicture();
    } catch (err) {
      console.error('[player] picture-in-picture failed', err);
    }
  }

  /* ---------------- frame rate ---------------- */

  // Frame stepping needs a frame duration. requestVideoFrameCallback reports the
  // real presentation times, so a handful of samples gives a far better answer
  // than assuming 30fps — which would drift badly on 24fps or 60fps footage.
  measureFrameRate() {
    if (typeof this.el.requestVideoFrameCallback !== 'function') return;
    if (this.frameHandle) {
      try {
        this.el.cancelVideoFrameCallback(this.frameHandle);
      } catch {
        // Handle may already have fired.
      }
      this.frameHandle = null;
    }

    let last = null;
    const sample = (_now, metadata) => {
      const stamp = metadata?.mediaTime;
      if (Number.isFinite(stamp)) {
        if (last !== null) {
          const delta = stamp - last;
          if (delta > 0.001 && delta < 0.2) this.fpsSamples.push(1 / delta);
        }
        last = stamp;
      }
      if (this.fpsSamples.length >= 12) {
        // Median resists the odd dropped or duplicated frame.
        const sorted = [...this.fpsSamples].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        if (Number.isFinite(median) && median > 1) this.fps = Math.round(median * 100) / 100;
        this.frameHandle = null;
        return;
      }
      this.frameHandle = this.el.requestVideoFrameCallback(sample);
    };

    this.frameHandle = this.el.requestVideoFrameCallback(sample);
  }

  on(event, handler) {
    this.el.addEventListener(event, handler);
    return () => this.el.removeEventListener(event, handler);
  }
}

'use strict';

// Producing a new file from an open one: cutting a clip, and converting
// something Chromium refuses to decode into something it will play.
//
// Both are the same shape — one ffmpeg run, one progress stream, one output file
// — so they share a single job slot. Only one runs at a time: these are disk and
// CPU bound, and two at once would make both slower while making the progress
// reporting meaningless.

const fs = require('fs');
const path = require('path');
const ffmpeg = require('./ffmpeg');

// Containers that accept the faststart flag. Setting it elsewhere is harmless
// but produces a warning on every run, so it is only passed where it applies.
const FASTSTART_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov']);

// Re-encode settings. veryfast/crf 20 is the point where a cut still looks like
// the original at a speed that does not make the user wonder if it hung.
const VIDEO_ENCODE = [
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-crf', '20',
  '-pix_fmt', 'yuv420p',
];
const AUDIO_ENCODE = ['-c:a', 'aac', '-b:a', '192k'];

let active = null;   // { cancel, output, kind }

const isBusy = () => active !== null;

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  // Windows and macOS both hand back case-insensitive filesystems by default,
  // so a case-only difference is still the same file being overwritten.
  return process.platform === 'linux' ? left === right : left.toLowerCase() === right.toLowerCase();
}

async function removeQuietly(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // Never written, or already gone.
  }
}

function faststartFor(output) {
  return FASTSTART_EXTENSIONS.has(path.extname(output).toLowerCase())
    ? ['-movflags', '+faststart']
    : [];
}

/* ------------------------------------------------------------------ *
 * Argument construction
 * ------------------------------------------------------------------ */

// `-ss` before `-i` is the fast seek: ffmpeg jumps straight to the nearest
// keyframe at or before the mark instead of decoding everything up to it. In
// copy mode that keyframe *is* the cut point, which is why a fast cut can start
// a second or two early — it can never start late, so the marked moment is
// always inside the result.
function trimArgs({ input, output, start, duration, mode }) {
  const seek = ['-ss', start.toFixed(3), '-i', input, '-t', duration.toFixed(3)];
  const codecs = mode === 'exact'
    ? [...VIDEO_ENCODE, ...AUDIO_ENCODE]
    : ['-c', 'copy', '-avoid_negative_ts', 'make_zero'];

  return ['-y', ...seek, ...codecs, ...faststartFor(output), '-progress', 'pipe:1', '-nostats', output];
}

function convertArgs({ input, output }) {
  return [
    '-y', '-i', input,
    ...VIDEO_ENCODE, ...AUDIO_ENCODE,
    ...faststartFor(output),
    '-progress', 'pipe:1', '-nostats',
    output,
  ];
}

/* ------------------------------------------------------------------ *
 * The job slot
 * ------------------------------------------------------------------ */

async function execute({ kind, args, output, totalSeconds, requestedSeconds, onProgress }) {
  const report = typeof onProgress === 'function' ? onProgress : () => {};

  // The final progress tick is the length of what was actually written. Keeping
  // it means a finished copy can report how much it really produced, which is
  // the only way to tell the user what a keyframe cut cost them on their file
  // rather than in the abstract.
  let writtenSeconds = 0;

  // totalSeconds travels with every update so the UI can tell "0% so far" from
  // "there is no total to be a percentage of" — the latter happens converting a
  // file the player could not open, where no duration was ever read.
  const { promise, cancel } = ffmpeg.run(args, {
    onSeconds: (seconds) => {
      writtenSeconds = seconds;
      const percent = totalSeconds > 0
        ? Math.max(0, Math.min(99, Math.round((seconds / totalSeconds) * 100)))
        : 0;
      report({ status: 'running', kind, percent, seconds, totalSeconds, output });
    },
  });

  active = { cancel, output, kind };
  report({ status: 'running', kind, percent: 0, seconds: 0, totalSeconds, output });

  try {
    const { canceled } = await promise;

    if (canceled) {
      // A cancelled run leaves a truncated file that would otherwise sit in the
      // user's folder looking like a finished clip.
      await removeQuietly(output);
      const result = { status: 'canceled', kind, output: null };
      report(result);
      return result;
    }

    let size = 0;
    try {
      size = (await fs.promises.stat(output)).size;
    } catch {
      throw new Error('The video engine finished but wrote no file.');
    }
    if (size === 0) {
      await removeQuietly(output);
      throw new Error('The video engine produced an empty file.');
    }

    // Reading the finished header is the only way to learn what a stream copy
    // really produced; the progress stream reports the length that was asked
    // for. Falls back to that if the probe cannot answer.
    let measured = null;
    try {
      measured = await ffmpeg.probeDuration(output);
    } catch {
      measured = null;
    }

    const result = {
      status: 'done',
      kind,
      output,
      size,
      percent: 100,
      writtenSeconds: Number.isFinite(measured) && measured > 0 ? measured : writtenSeconds,
      requestedSeconds: requestedSeconds || 0,
    };
    report(result);
    return result;
  } catch (err) {
    await removeQuietly(output);
    const result = { status: 'error', kind, output: null, message: String(err?.message || err) };
    report(result);
    return result;
  } finally {
    active = null;
  }
}

/* ------------------------------------------------------------------ *
 * Public jobs
 * ------------------------------------------------------------------ */

// `start` and `end` arrive in the same display seconds the UI shows. ffmpeg
// measures `-ss` from the start of the content too, so files whose container
// timestamps do not begin at zero — dashcam recordings, most often — need no
// conversion here.
async function trim({ input, output, start, end, mode }, onProgress) {
  if (isBusy()) throw new Error('Another export is already running.');

  const from = Math.max(0, Number(start) || 0);
  const to = Number(end) || 0;
  const duration = to - from;

  if (!(duration > 0.1)) throw new Error('The selection is too short to export.');
  if (!fs.existsSync(input)) throw new Error('The source file is no longer there.');
  if (samePath(input, output)) throw new Error('Choose a different name — a clip cannot overwrite its own source.');

  return execute({
    kind: 'trim',
    args: trimArgs({ input, output, start: from, duration, mode: mode === 'exact' ? 'exact' : 'fast' }),
    output,
    totalSeconds: duration,
    requestedSeconds: duration,
    onProgress,
  });
}

async function convert({ input, output, totalSeconds }, onProgress) {
  if (isBusy()) throw new Error('Another export is already running.');
  if (!fs.existsSync(input)) throw new Error('The source file is no longer there.');
  if (samePath(input, output)) throw new Error('Choose a different name — the copy cannot overwrite its source.');

  return execute({
    kind: 'convert',
    args: convertArgs({ input, output }),
    output,
    totalSeconds: Number(totalSeconds) || 0,
    onProgress,
  });
}

function cancel() {
  if (!active) return false;
  active.cancel();
  return true;
}

// Cancelling on the way out stops a job from holding the process open, and the
// partial file is cleaned up by execute()'s cancel path.
function shutdown() {
  if (active) active.cancel();
}

module.exports = {
  available: () => ffmpeg.isAvailable(),
  trim,
  convert,
  cancel,
  isBusy,
  shutdown,
};

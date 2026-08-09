'use strict';

// Locating and running the bundled ffmpeg.
//
// The binary ships inside the app rather than relying on one being installed: a
// player that can only cut video on machines that already have ffmpeg is a
// player that, for most people, cannot cut video at all.
//
// Nothing above this module knows ffmpeg exists. It takes an argument list and
// reports progress and failure in ordinary terms.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let cachedPath;

// ffmpeg-static resolves to a path inside app.asar once packaged, and nothing
// can be executed from inside an archive. electron-builder unpacks it alongside
// (see asarUnpack in package.json); this rewrites the path to point at the copy
// that is a real file on disk.
function resolveBinary() {
  if (cachedPath !== undefined) return cachedPath;

  let candidate = null;
  try {
    candidate = require('ffmpeg-static');
  } catch {
    candidate = null;
  }

  if (typeof candidate === 'string' && candidate) {
    const unpacked = candidate.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    if (unpacked !== candidate && fs.existsSync(unpacked)) candidate = unpacked;
  }

  cachedPath = typeof candidate === 'string' && candidate && fs.existsSync(candidate) ? candidate : null;
  return cachedPath;
}

function isAvailable() {
  return Boolean(resolveBinary());
}

/* ------------------------------------------------------------------ *
 * Running
 * ------------------------------------------------------------------ */

// `-progress pipe:1` prints machine-readable key=value lines on stdout, which is
// far more reliable than scraping the human-facing stderr output. Both
// out_time_us and out_time_ms are microseconds — the _ms name is a long-standing
// misnomer in ffmpeg, not a unit to divide by a thousand.
function parseProgressChunk(text, onTick) {
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key === 'out_time_us' || key === 'out_time_ms') {
      const micros = Number(value);
      if (Number.isFinite(micros) && micros >= 0) onTick(micros / 1e6);
    }
  }
}

// Keeps the tail of stderr so a failure can say what actually went wrong rather
// than only reporting an exit code.
function tailOf(lines, count = 4) {
  return lines
    .join('')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(' · ');
}

// Returns { promise, cancel }. `cancel()` resolves the promise with
// { canceled: true } rather than rejecting — a user pressing Cancel is not an
// error and should not be reported as one.
function run(args, { onSeconds } = {}) {
  const binary = resolveBinary();
  if (!binary) {
    return {
      promise: Promise.reject(new Error('The bundled video engine is missing from this install.')),
      cancel: () => {},
    };
  }

  let child = null;
  let canceled = false;

  const promise = new Promise((resolve, reject) => {
    child = spawn(binary, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
      windowsHide: true,
    });

    const errorLines = [];

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (typeof onSeconds === 'function') parseProgressChunk(chunk, onSeconds);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      errorLines.push(chunk);
      // A runaway stderr must not grow without bound on a long job.
      if (errorLines.length > 60) errorLines.splice(0, errorLines.length - 60);
    });

    child.on('error', (err) => {
      if (canceled) resolve({ canceled: true });
      else reject(new Error(`Could not start the video engine: ${err.message}`));
    });

    child.on('close', (code) => {
      if (canceled) {
        resolve({ canceled: true });
        return;
      }
      if (code === 0) {
        resolve({ canceled: false });
        return;
      }
      const detail = tailOf(errorLines);
      reject(new Error(detail || `The video engine stopped with code ${code}.`));
    });
  });

  const cancel = () => {
    if (canceled || !child || child.exitCode !== null) return;
    canceled = true;
    // SIGKILL rather than a graceful signal: ffmpeg asked to stop mid-write
    // would finalise a half-length file that looks complete. The partial output
    // is deleted by the caller instead.
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  };

  return { promise, cancel };
}

/* ------------------------------------------------------------------ *
 * Measuring
 * ------------------------------------------------------------------ */

// How long a finished file actually is.
//
// The progress stream cannot answer this for a stream copy: `-ss 10 -t 15`
// makes ffmpeg count 15 seconds from the seek point and report that, while the
// file it writes begins at the keyframe before 10 and so runs longer. Only the
// header of the result knows.
//
// ffmpeg with no output exits non-zero by design ("At least one output file
// must be specified"), so the exit code is ignored — the header line is the
// whole point of the call.
function probeDuration(filePath) {
  const binary = resolveBinary();
  if (!binary) return Promise.resolve(null);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, ['-hide_banner', '-nostdin', '-i', filePath], { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 65536) child.kill();
    });

    child.on('error', () => resolve(null));
    child.on('close', () => {
      const match = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(stderr);
      resolve(match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null);
    });
  });
}

module.exports = { isAvailable, resolveBinary, run, probeDuration };

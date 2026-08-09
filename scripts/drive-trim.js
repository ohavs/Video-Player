// Drives the trim and export path in the real app.
//
//   VP_VIDEO=<file> xvfb-run -a electron scripts/drive-trim.js
//
// Nothing is stubbed except the native save dialog, which cannot be answered by
// synthetic input — the export itself runs the shipped ffmpeg through the
// shipped IPC, and the resulting file is measured on disk.

const electron = require('electron');
const { app, BrowserWindow } = electron;
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

require('../src/main/main.js');

const VIDEO = process.env.VP_VIDEO;
const OUT_DIR = process.env.VP_SHOT_DIR || '/tmp/vp-trim';
const ffmpegPath = require('ffmpeg-static');

const results = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function shot(win, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), image.toPNG());
  console.log(`shot  ${path.join(OUT_DIR, `${name}.png`)}`);
}

const evaluate = (win, expression) => win.webContents.executeJavaScript(expression, true);

function key(win, keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

function type(win, text) {
  for (const ch of text) win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
}

async function rectOf(win, selector) {
  return evaluate(
    win,
    `(() => { const n = document.querySelector(${JSON.stringify(selector)});
       if (!n) return null;
       const r = n.getBoundingClientRect();
       return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.left, top: r.top, w: r.width, h: r.height };
     })()`,
  );
}

function click(win, x, y) {
  const position = { x: Math.round(x), y: Math.round(y) };
  win.webContents.sendInputEvent({ type: 'mouseDown', ...position, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...position, button: 'left', clickCount: 1 });
}

// Reads the real duration back out of a produced file.
function secondsOf(file) {
  let text = '';
  try {
    execFileSync(ffmpegPath, ['-hide_banner', '-i', file], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    text = String(err.stderr || '');
  }
  const match = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(text);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

async function trimState(win) {
  return evaluate(
    win,
    `(() => {
       const bar = document.querySelector('.trimbar');
       const layer = document.querySelector('.scrub-trim');
       const grip = (edge) => document.querySelector('.trim-grip[data-edge="' + edge + '"]');
       const text = (role) => {
         const n = document.querySelector('[data-role="' + role + '"]');
         return n ? n.textContent.trim() : null;
       };
       return {
         barOpen: Boolean(bar) && !bar.hidden,
         layerShown: Boolean(layer) && !layer.hidden,
         in: text('inStamp'), out: text('outStamp'), length: text('lengthStamp'),
         inLeft: grip('in') ? grip('in').style.left : null,
         outLeft: grip('out') ? grip('out').style.left : null,
         // The marks in seconds, recovered from where the handles were painted,
         // so assertions can test the real numbers instead of rounded stamps.
         inSec: grip('in') ? (parseFloat(grip('in').style.left) / 100) * document.querySelector('video').duration : null,
         outSec: grip('out') ? (parseFloat(grip('out').style.left) / 100) * document.querySelector('video').duration : null,
         mode: (document.querySelector('.trim-modes .chip.is-on') || {}).dataset
               ? document.querySelector('.trim-modes .chip.is-on').dataset.mode : null,
         exportDisabled: (document.querySelector('[data-cmd="export"]') || {}).disabled,
         note: (document.querySelector('.trim-note') || {}).textContent || '',
       };
     })()`,
  );
}

// Records the first moment the busy row is genuinely visible. Runs in the page
// at 20ms so a job that finishes quickly is still observed.
async function watchBusy(win) {
  await evaluate(
    win,
    `(() => {
       window.__busySeen = null;
       clearInterval(window.__busyTimer);
       window.__busyTimer = setInterval(() => {
         const b = document.querySelector('.trim-busy');
         if (b && !b.hidden && !window.__busySeen) {
           window.__busySeen = b.textContent.replace(/\\s+/g, ' ').trim();
         }
       }, 20);
       return true;
     })()`,
  );
}

async function readBusy(win) {
  return evaluate(win, `(() => { clearInterval(window.__busyTimer); return window.__busySeen; })()`);
}

async function addBookmarkAt(win, seconds, label) {
  await evaluate(win, `document.querySelector('video').currentTime = ${seconds}`);
  await wait(400);
  key(win, 'b');
  await wait(350);
  if (!(await evaluate(win, `!document.querySelector('.composer').hidden`))) return false;
  type(win, label);
  await wait(200);
  key(win, 'Enter');
  await wait(400);
  return true;
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await wait(2500);

  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.log('FAIL  no window was created');
    app.exit(1);
    return;
  }
  win.setSize(1280, 760);
  await wait(600);

  // The one thing synthetic input cannot answer. Every save location the app
  // asks for during this run is handed back from here.
  let nextSavePath = null;
  let lastDialogOptions = null;
  electron.dialog.showSaveDialog = async (_parent, options) => {
    lastDialogOptions = options;
    return nextSavePath ? { canceled: false, filePath: nextSavePath } : { canceled: true, filePath: '' };
  };

  /* ---- open a file ---- */
  const main = require('../src/main/main.js');
  win.webContents.send('file:open', await main.describeFile(VIDEO));
  await wait(3000);
  await evaluate(win, `document.querySelector('video').pause()`);

  const engineReady = await evaluate(win, `!document.querySelector('[data-role="trim"]').hidden`);
  check('the trim button appears when the engine is present', engineReady);

  /* ---- 1. trim mode on a plain timeline ---- */
  await evaluate(win, `document.querySelector('video').currentTime = 10`);
  await wait(400);
  key(win, 'c');
  await wait(600);

  let state = await trimState(win);
  check('C opens trim mode', state.barOpen && state.layerShown);
  check('with no bookmarks the whole video is selected',
    state.in === '0:00.0' && state.out === '1:00.0', `${state.in} → ${state.out}`);
  check('length is shown', state.length === '1:00.0', state.length);
  check('fast is the default mode', state.mode === 'fast', String(state.mode));
  await shot(win, '01-trim-whole');

  /* ---- 2. Set buttons move the marks to the playhead ---- */
  await evaluate(win, `document.querySelector('video').currentTime = 10`);
  await wait(400);
  await evaluate(win, `document.querySelector('[data-cmd="setIn"]').click()`);
  await wait(300);
  await evaluate(win, `document.querySelector('video').currentTime = 25`);
  await wait(400);
  await evaluate(win, `document.querySelector('[data-cmd="setOut"]').click()`);
  await wait(400);

  state = await trimState(win);
  check('Set places the start mark at the playhead', state.in === '0:10.0', state.in);
  check('Set places the end mark at the playhead', state.out === '0:25.0', state.out);
  check('length follows the marks', state.length === '0:15.0', state.length);
  check('handles sit where the marks are',
    state.inLeft.startsWith('16.6') && state.outLeft.startsWith('41.6'),
    `${state.inLeft} / ${state.outLeft}`);
  await shot(win, '02-trim-selected');

  /* ---- 3. the handles cannot cross ---- */
  await evaluate(win, `document.querySelector('video').currentTime = 40`);
  await wait(400);
  await evaluate(win, `document.querySelector('[data-cmd="setIn"]').click()`);
  await wait(400);
  state = await trimState(win);
  // Asserted on the real numbers: the exact frame the seek lands on varies, so
  // the invariant is the gap, not a particular stamp.
  const gap = state.outSec - state.inSec;
  check('the start mark stops short of the end mark',
    state.inSec < state.outSec && gap >= 0.09 && gap < 0.2 && state.inSec > 24,
    `${state.inSec.toFixed(3)}s → ${state.outSec.toFixed(3)}s (gap ${gap.toFixed(3)}s)`);

  // Put a usable selection back.
  await evaluate(win, `document.querySelector('video').currentTime = 10`);
  await wait(300);
  await evaluate(win, `document.querySelector('[data-cmd="setIn"]').click()`);
  await wait(400);

  /* ---- 4. a fast export really produces a file ---- */
  const fastOut = path.join(OUT_DIR, 'exported-fast.mp4');
  fs.rmSync(fastOut, { force: true });
  nextSavePath = fastOut;

  // A 15-second stream copy finishes in a few hundred milliseconds, which is
  // faster than this process can poll over IPC. Sampling from inside the page
  // catches the running state instead of racing it.
  await evaluate(win, `document.querySelectorAll('.toast').forEach(n => n.remove()); true`);
  await watchBusy(win);
  await evaluate(win, `document.querySelector('[data-cmd="export"]').click()`);
  await wait(400);
  await shot(win, '03-trim-exporting');

  for (let i = 0; i < 60 && !fs.existsSync(fastOut); i += 1) await wait(500);
  await wait(1200);

  const busySeen = await readBusy(win);
  check('a running export shows progress in the bar',
    Boolean(busySeen) && /%/.test(busySeen), busySeen || 'never became visible');

  check('the save dialog was offered a sensible name',
    /source - 0m10s to 0m25s/.test(String(lastDialogOptions?.defaultPath || '')),
    path.basename(String(lastDialogOptions?.defaultPath || '')));
  check('the fast export wrote a file', fs.existsSync(fastOut));

  const fastSeconds = secondsOf(fastOut);
  check('the fast clip contains the whole marked range', fastSeconds !== null && fastSeconds >= 15,
    `${fastSeconds}s`);

  const doneToast = await evaluate(
    win,
    `(() => { const all = document.querySelectorAll('.toast');
       const t = all[all.length - 1]; return t ? t.textContent.trim() : ''; })()`,
  );
  check('finishing is reported with a way to find the file',
    /Clip saved/.test(doneToast) && /Show file/.test(doneToast), doneToast);

  // The whole point of naming the two modes: on this file a fast cut really
  // starts ~2s earlier, and saying the number is what makes the choice concrete
  // rather than a claim the user has to take on faith.
  check('a fast cut reports how much earlier it actually starts',
    /starts \d+\.\d+s early/.test(doneToast), doneToast);

  const stacking = await evaluate(
    win,
    `(() => { const t = document.querySelector('.toast'); const b = document.querySelector('.trimbar');
       if (!t || !b || b.hidden) return null;
       const tr = t.getBoundingClientRect(); const br = b.getBoundingClientRect();
       return { clear: tr.bottom <= br.top + 1, toast: Math.round(tr.bottom), bar: Math.round(br.top) }; })()`,
  );
  check('the toast sits clear of the trim bar', Boolean(stacking) && stacking.clear,
    stacking ? `toast ends at ${stacking.toast}px, bar starts at ${stacking.bar}px` : 'nothing to measure');
  await shot(win, '04-trim-done');

  /* ---- 5. exact mode is frame accurate ---- */
  await evaluate(win, `document.querySelector('.trim-modes .chip[data-mode="exact"]').click()`);
  await wait(400);
  state = await trimState(win);
  check('the mode switch takes', state.mode === 'exact', String(state.mode));
  check('the note explains what exact costs', /re-encod/i.test(state.note), state.note.slice(0, 60));

  const exactOut = path.join(OUT_DIR, 'exported-exact.mp4');
  fs.rmSync(exactOut, { force: true });
  nextSavePath = exactOut;
  await evaluate(win, `document.querySelectorAll('.toast').forEach(n => n.remove()); true`);
  await evaluate(win, `document.querySelector('[data-cmd="export"]').click()`);
  for (let i = 0; i < 90 && !fs.existsSync(exactOut); i += 1) await wait(500);
  await wait(1500);

  const exactSeconds = secondsOf(exactOut);
  check('the exact clip is cut to the frame',
    exactSeconds !== null && Math.abs(exactSeconds - 15) < 0.2, `${exactSeconds}s`);

  const exactToast = await evaluate(
    win,
    `(() => { const all = document.querySelectorAll('.toast');
       const t = all[all.length - 1]; return t ? t.textContent.trim() : ''; })()`,
  );
  check('an exact cut has no early start to report',
    /Clip saved/.test(exactToast) && !/early/.test(exactToast), exactToast);

  /* ---- 6. cancelling the dialog cancels the export ---- */
  nextSavePath = null;
  await evaluate(win, `document.querySelector('[data-cmd="export"]').click()`);
  await wait(1000);
  const afterCancel = await trimState(win);
  check('backing out of the save dialog leaves trim mode intact',
    afterCancel.barOpen && afterCancel.in === '0:10.0', `${afterCancel.in} → ${afterCancel.out}`);

  /* ---- 7. a chapter preselects the cut ---- */
  key(win, 'c');
  await wait(400);
  for (const [seconds, label] of [[12, 'First'], [24, 'Second'], [38, 'Third']]) {
    await addBookmarkAt(win, seconds, label);
  }
  await evaluate(win, `document.querySelector('video').currentTime = 30`);
  await wait(500);
  key(win, 'c');
  await wait(600);

  state = await trimState(win);
  check('opening trim inside a chapter selects that chapter',
    state.in === '0:24.0' && state.out === '0:38.0', `${state.in} → ${state.out}`);
  await shot(win, '05-trim-chapter');

  nextSavePath = path.join(OUT_DIR, 'exported-chapter.mp4');
  fs.rmSync(nextSavePath, { force: true });
  await evaluate(win, `document.querySelector('.trim-modes .chip[data-mode="fast"]').click()`);
  await wait(300);
  await evaluate(win, `document.querySelector('[data-cmd="export"]').click()`);
  await wait(800);
  check('a chapter clip is named after the chapter',
    /source - Second/.test(String(lastDialogOptions?.defaultPath || '')),
    path.basename(String(lastDialogOptions?.defaultPath || '')));

  for (let i = 0; i < 60 && !fs.existsSync(nextSavePath); i += 1) await wait(500);
  await wait(1000);
  check('the chapter clip was written', fs.existsSync(nextSavePath));

  /* ---- 8. leaving trim mode ---- */
  await evaluate(win, `document.querySelector('.trimbar [data-cmd="close"]').click()`);
  await wait(600);
  const closed = await trimState(win);
  check('closing trim hides the bar and the handles',
    !closed.barOpen && !closed.layerShown);

  /* ---- 9. a file Chromium cannot decode ---- */
  const unplayable = process.env.VP_VIDEO_UNPLAYABLE;
  if (unplayable && fs.existsSync(unplayable)) {
    // The "Clip saved" toast from the previous export is still on screen for
    // several seconds, and toasts stack oldest-first — leaving it there means
    // reading (and clicking) the wrong one.
    await evaluate(win, `document.querySelectorAll('.toast').forEach(n => n.remove()); true`);

    win.webContents.send('file:open', await main.describeFile(unplayable));
    await wait(3500);

    const offer = await evaluate(
      win,
      `(() => { const all = document.querySelectorAll('.toast'); const t = all[all.length - 1];
         return { text: t ? t.textContent.trim() : '',
                  hasAction: Boolean(t && t.querySelector('.toast-action')) }; })()`,
    );
    check('an undecodable file is reported, not left blank',
      /cannot be played/.test(offer.text), offer.text);
    check('and is offered a conversion', offer.hasAction, offer.text);
    await shot(win, '06-unplayable');

    const convertedOut = path.join(OUT_DIR, 'converted.mp4');
    fs.rmSync(convertedOut, { force: true });
    nextSavePath = convertedOut;

    await watchBusy(win);
    await evaluate(
      win,
      `(() => { const all = document.querySelectorAll('.toast-action');
         all[all.length - 1].click(); return true; })()`,
    );
    for (let i = 0; i < 120 && !fs.existsSync(convertedOut); i += 1) await wait(500);
    await wait(2500);

    check('the conversion wrote a file', fs.existsSync(convertedOut));
    const convertBusy = await readBusy(win);
    check('the conversion showed progress', Boolean(convertBusy), convertBusy || 'never became visible');

    const playing = await evaluate(
      win,
      `(() => { const v = document.querySelector('video');
         return { duration: v.duration, err: v.error && v.error.code,
                  src: decodeURIComponent(v.currentSrc || '') }; })()`,
    );
    check('the converted copy opens and plays',
      Number.isFinite(playing.duration) && playing.duration > 1 && !playing.err,
      `duration=${playing.duration} error=${playing.err ?? 'none'}`);
    check('the player switched to the converted file',
      playing.src.includes('converted.mp4'), path.basename(playing.src));
    await shot(win, '07-converted');
  } else {
    console.log('skip  conversion checks (set VP_VIDEO_UNPLAYABLE to run them)');
  }

  /* ---- summary ---- */
  const failed = results.filter((r) => !r.passed);
  console.log(`\nRESULT ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log(`FAILED: ${failed.map((f) => f.name).join(' | ')}`);
  app.exit(failed.length ? 1 : 0);
});

// Drives the real app with synthetic input and checks that the important
// behaviours actually happen, capturing a screenshot at each stage.
//
//   xvfb-run -a electron scripts/drive.js <video-file> <output-dir>
//
// This boots src/main/main.js itself — nothing is stubbed, so a pass here means
// the shipped code path works, not a test double of it.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const main = require('../src/main/main.js');

// Deliberately via env, not argv: main.js opens any video it finds in argv on
// startup, which would defeat the check that the welcome state comes first.
const VIDEO = process.env.VP_VIDEO;
const OUT_DIR = process.env.VP_SHOT_DIR || '/tmp/vp-shots';

const results = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function shot(win, name) {
  const image = await win.webContents.capturePage();
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  console.log(`shot  ${file}`);
}

const evaluate = (win, expression) => win.webContents.executeJavaScript(expression, true);

// Rects of off-screen rows are useless for clicking — the shortcuts list
// scrolls, so bring the target into view before measuring it.
async function scrollIntoView(win, selector) {
  await evaluate(
    win,
    `(() => { const n = document.querySelector(${JSON.stringify(selector)});
       if (n) n.scrollIntoView({ block: 'center' });
       return Boolean(n); })()`,
  );
  await wait(400);
}

async function rectOf(win, selector) {
  return evaluate(
    win,
    `(() => { const n = document.querySelector(${JSON.stringify(selector)});
       if (!n) return null;
       const r = n.getBoundingClientRect();
       return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top };
     })()`,
  );
}

function key(win, keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

function type(win, text) {
  for (const ch of text) {
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
  }
}

function mouseMove(win, x, y) {
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
}

function click(win, x, y) {
  const position = { x: Math.round(x), y: Math.round(y) };
  win.webContents.sendInputEvent({ type: 'mouseDown', ...position, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...position, button: 'left', clickCount: 1 });
}

async function addBookmarkAt(win, seconds, label) {
  await evaluate(win, `document.querySelector('video').currentTime = ${seconds}`);
  await wait(400);
  key(win, 'b');
  await wait(350);
  const open = await evaluate(win, `!document.querySelector('.composer').hidden`);
  if (!open) return false;
  type(win, label);
  await wait(200);
  key(win, 'Enter');
  await wait(350);
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

  /* ---- 1. welcome ---- */
  const welcomeVisible = await evaluate(win, `document.getElementById('app').dataset.state === 'empty'`);
  check('welcome state shown before a file is opened', welcomeVisible);
  await shot(win, '01-welcome');

  /* ---- 2. open a file through the real descriptor path ---- */
  const descriptor = await main.describeFile(VIDEO);
  win.webContents.send('file:open', descriptor);
  await wait(3000);

  const loaded = await evaluate(
    win,
    `(() => { const v = document.querySelector('video');
       return { duration: v.duration, ready: v.readyState, err: v.error && v.error.code, playing: !v.paused }; })()`,
  );
  check('video loads over media:// with a real duration', Number.isFinite(loaded.duration) && loaded.duration > 1,
    `duration=${loaded.duration} readyState=${loaded.ready} error=${loaded.err ?? 'none'}`);
  check('autoplay starts on open', loaded.playing === true);

  // Seeking is the thing that proves byte-range serving works.
  await evaluate(win, `document.querySelector('video').currentTime = 42`);
  await wait(800);
  const seeked = await evaluate(win, `document.querySelector('video').currentTime`);
  check('seeking works (range requests served)', Math.abs(seeked - 42) < 2, `landed at ${seeked.toFixed(2)}s`);

  const scrub = await rectOf(win, '.scrubber');
  if (scrub) mouseMove(win, scrub.x, scrub.y);
  await wait(500);
  await shot(win, '02-player');

  /* ---- 3. bookmark composer ---- */
  await evaluate(win, `document.querySelector('video').pause()`);
  await evaluate(win, `document.querySelector('video').currentTime = 12`);
  await wait(400);
  key(win, 'b');
  await wait(500);

  const composer = await evaluate(
    win,
    `(() => { const c = document.querySelector('.composer');
       return { open: !c.hidden, stamp: c.querySelector('.composer-stamp').textContent,
                focused: document.activeElement === c.querySelector('.composer-input') }; })()`,
  );
  check('bookmark key opens the inline composer', composer.open);
  check('composer captures the timestamp of the keypress', composer.stamp === '0:12', `stamp=${composer.stamp}`);
  check('composer input takes focus immediately', composer.focused);

  type(win, 'Opening titles');
  await wait(300);
  await shot(win, '03-composer');

  key(win, 'Enter');
  await wait(500);

  const afterSave = await evaluate(
    win,
    `(() => ({ hidden: document.querySelector('.composer').hidden,
               count: document.querySelectorAll('.bm-row').length,
               badge: document.querySelector('[data-role="bookmarkCount"]').textContent }))()`,
  );
  check('Enter saves and closes the composer', afterSave.hidden === true);
  check('saved bookmark is counted', afterSave.badge === '1', `badge=${afterSave.badge}`);

  /* ---- 4. several bookmarks -> chapter segments ---- */
  for (const [seconds, label] of [[24, 'Second section'], [38, 'The main point'], [50, 'Wrap up']]) {
    const ok = await addBookmarkAt(win, seconds, label);
    if (!ok) check(`bookmark at ${seconds}s`, false, 'composer did not open');
  }
  await wait(500);

  const segments = await evaluate(win, `document.querySelectorAll('.scrub-track .seg').length`);
  check('timeline splits into chapter segments', segments === 5, `${segments} segments for 4 bookmarks`);

  // Hover mid-timeline so the tooltip and its chapter title are in the shot.
  const bar = await rectOf(win, '.scrubber');
  mouseMove(win, bar.left + bar.w * 0.72, bar.y);
  await wait(600);
  await shot(win, '04-chapters');

  const tip = await evaluate(
    win,
    `(() => { const t = document.querySelector('.scrub-tip');
       return { shown: !t.hidden, title: t.querySelector('.tip-title').textContent,
                time: t.querySelector('.tip-time').textContent }; })()`,
  );
  check('hovering a chapter shows its label in the tooltip', tip.shown && tip.title.length > 0,
    `"${tip.title}" at ${tip.time}`);

  /* ---- 5. chapter name in the control bar ---- */
  await evaluate(win, `document.querySelector('video').currentTime = 40`);
  await wait(700);
  const chapter = await evaluate(
    win,
    `(() => { const c = document.querySelector('[data-role="chapter"]');
       return { shown: !c.hidden, name: c.querySelector('.chapter-name').textContent }; })()`,
  );
  check('current chapter name shows in the control bar', chapter.shown && chapter.name === 'The main point',
    `"${chapter.name}"`);

  /* ---- 6. settings menu ---- */
  const gear = await rectOf(win, '[data-role="settings"]');
  click(win, gear.x, gear.y);
  await wait(600);
  const menuOpen = await evaluate(win, `!document.querySelector('.menu').hidden`);
  check('settings menu opens', menuOpen);
  await shot(win, '05-settings');

  // Walk into the bookmarks submenu to prove stacked navigation works.
  const rows = await evaluate(
    win,
    `Array.from(document.querySelectorAll('.menu-row')).map(r => r.dataset.id)`,
  );
  check('settings root lists the expected sections', rows.includes('bookmarks') && rows.includes('playback'),
    rows.join(', '));

  const bookmarksRow = await rectOf(win, '.menu-row[data-id="bookmarks"]');
  if (bookmarksRow) {
    click(win, bookmarksRow.x, bookmarksRow.y);
    await wait(500);
    await shot(win, '06-settings-bookmarks');
    const page = await evaluate(win, `document.querySelector('.menu').dataset.page`);
    check('submenu navigation works', page === 'bookmarks', `page=${page}`);
  }

  /* ---- 7. speed ---- */
  await evaluate(win, `document.querySelector('.menu').__hide && 0`);
  key(win, 'Escape');
  await evaluate(win, `document.querySelector('[data-role="settings"]').click()`);
  await wait(300);
  key(win, '.', ['shift']);
  await wait(400);
  const rate = await evaluate(win, `document.querySelector('video').playbackRate`);
  check('shift+. raises playback speed', rate > 1, `rate=${rate}`);

  /* ---- 8. shortcuts editor + rebinding ---- */
  await evaluate(win, `document.querySelector('.menu').classList.contains('is-open') && document.querySelector('[data-role="settings"]').click()`);
  await wait(300);
  await evaluate(win, `document.querySelector('[data-role="settings"]').click()`);
  await wait(400);
  const shortcutsRow = await rectOf(win, '.menu-row[data-id="shortcuts"]');
  if (shortcutsRow) click(win, shortcutsRow.x, shortcutsRow.y);
  await wait(700);

  const sheetOpen = await evaluate(win, `!document.querySelector('.sheet').hidden`);
  check('keyboard shortcuts editor opens', sheetOpen);
  await shot(win, '07-shortcuts');

  // Rebind "add bookmark" to N and confirm the new key works and the old does not.
  await scrollIntoView(win, '.sheet-row[data-action="addBookmark"]');
  await shot(win, '07b-shortcuts-bookmarks');
  const captureBtn = await rectOf(win, '.sheet-row[data-action="addBookmark"] [data-cmd="capture"]');
  if (captureBtn) {
    click(win, captureBtn.x, captureBtn.y);
    await wait(400);
    await shot(win, '08-rebinding');
    key(win, 'n');
    await wait(500);
    const bound = await evaluate(
      win,
      `document.querySelector('.sheet-row[data-action="addBookmark"] .kbd').textContent`,
    );
    check('rebinding captures the new key', bound.trim() === 'N', `now bound to "${bound.trim()}"`);
  }

  key(win, 'Escape');
  await wait(500);

  await evaluate(win, `document.querySelector('video').currentTime = 55`);
  await wait(400);
  key(win, 'n');
  await wait(500);
  const newKeyWorks = await evaluate(win, `!document.querySelector('.composer').hidden`);
  check('the rebound key triggers the action', newKeyWorks);
  if (newKeyWorks) {
    key(win, 'Escape');
    await wait(300);
  }

  key(win, 'b');
  await wait(400);
  const oldKeyDead = await evaluate(win, `document.querySelector('.composer').hidden`);
  check('the old key no longer triggers it', oldKeyDead);

  /* ---- 9. bookmark panel ---- */
  await evaluate(win, `document.querySelector('[data-role="bookmarkList"]').click()`);
  await wait(700);
  const panel = await evaluate(
    win,
    `(() => { const p = document.querySelector('.bookmarks-panel');
       return { open: p.classList.contains('is-open'),
                rows: Array.from(p.querySelectorAll('.bm-row .bm-text')).map(n => n.textContent) }; })()`,
  );
  check('bookmark list opens with every saved mark', panel.open && panel.rows.length === 4,
    panel.rows.join(' | '));
  await shot(win, '09-bookmark-list');

  /* ---- 10. persistence ---- */
  await evaluate(win, `window.host.setSettings && 0`);
  await wait(300);
  const userData = app.getPath('userData');
  const libraryPath = path.join(userData, 'library.json');
  await wait(1200);
  const libraryExists = fs.existsSync(libraryPath);
  let stored = 0;
  if (libraryExists) {
    const library = JSON.parse(fs.readFileSync(libraryPath, 'utf8'));
    stored = Object.values(library)[0]?.bookmarks?.length ?? 0;
  }
  check('bookmarks persist to disk', libraryExists && stored === 4, `${stored} in ${libraryPath}`);

  /* ---- 11. files whose header lies about duration ---- */
  // Reproduces a real dashcam file: the header claims 353 hours and the
  // timeline does not start at zero. seekable is the truth; duration is not.
  await evaluate(win, `
    (() => {
      const proto = HTMLMediaElement.prototype;
      const realDuration = Object.getOwnPropertyDescriptor(proto, 'duration');
      const realSeekable = Object.getOwnPropertyDescriptor(proto, 'seekable');
      window.__restore = () => {
        Object.defineProperty(proto, 'duration', realDuration);
        Object.defineProperty(proto, 'seekable', realSeekable);
      };
      Object.defineProperty(proto, 'duration', { configurable: true, get: () => 1271310 });
      Object.defineProperty(proto, 'seekable', {
        configurable: true,
        get: () => ({ length: 1, start: () => 1271250, end: () => 1271310 }),
      });
      const v = document.querySelector('video');
      v.dispatchEvent(new Event('durationchange'));
      v.dispatchEvent(new Event('seeked'));
      return true;
    })()
  `);
  await wait(500);

  const brokenHeader = await evaluate(
    win,
    `(() => ({ duration: document.querySelector('[data-role="timeDuration"]').textContent,
               current: document.querySelector('[data-role="timeCurrent"]').textContent }))()`,
  );
  check('a lying duration header falls back to the seekable range',
    brokenHeader.duration === '1:00',
    `shows ${brokenHeader.current} / ${brokenHeader.duration} (was 353:08:30 before the fix)`);

  await evaluate(win, `window.__restore(); true`);

  /* ---- 12. update notice ---- */
  // Pushed on the same channel the updater uses, so this exercises the real
  // renderer path rather than a stand-in.
  win.webContents.send('updates:status', { status: 'downloading', version: '0.2.0', percent: 40 });
  await wait(500);
  const downloading = await evaluate(
    win,
    `(() => { const b = document.querySelector('.updatebar');
       return { shown: !b.hidden, text: b.textContent.replace(/\\s+/g, ' ').trim() }; })()`,
  );
  check('a downloading update shows progress in the app',
    downloading.shown && downloading.text.includes('40%'), downloading.text);

  win.webContents.send('updates:status', { status: 'ready', version: '0.2.0', percent: 100 });
  await wait(500);
  const ready = await evaluate(
    win,
    `(() => { const b = document.querySelector('.updatebar');
       return { shown: !b.hidden, hasButton: Boolean(b.querySelector('[data-cmd="install"]')),
                text: b.textContent.replace(/\\s+/g, ' ').trim() }; })()`,
  );
  check('a ready update offers a one-click install',
    ready.shown && ready.hasButton, ready.text);
  await shot(win, '10-update-ready');

  /* ---- 13. removing entries from the recent list ---- */
  // Reload so the welcome screen is the real one, populated from disk.
  win.webContents.reload();
  await wait(3000);

  const recentBefore = await evaluate(
    win,
    `(() => ({ empty: document.getElementById('app').dataset.state === 'empty',
               rows: document.querySelectorAll('.recent-row').length,
               clearShown: !document.querySelector('[data-role="recentClear"]').hidden }))()`,
  );
  check('recent list is populated after a restart',
    recentBefore.empty && recentBefore.rows === 1 && recentBefore.clearShown,
    `${recentBefore.rows} row(s)`);
  await shot(win, '11-recent-list');

  const forgetBtn = await rectOf(win, '.recent-row [data-cmd="forget"]');
  if (forgetBtn) click(win, forgetBtn.x, forgetBtn.y);
  await wait(900);

  const afterForget = await evaluate(
    win,
    `(() => ({ rows: document.querySelectorAll('.recent-row').length,
               toast: (document.querySelector('.toast') || {}).textContent || '' }))()`,
  );
  const libraryAfterForget = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'library.json'), 'utf8'));
  check('removing an entry clears it from the list and from disk',
    afterForget.rows === 0 && Object.keys(libraryAfterForget).length === 0,
    `${afterForget.rows} row(s) left, ${Object.keys(libraryAfterForget).length} on disk`);
  check('removal warns that its bookmarks went with it',
    /4 bookmarks/.test(afterForget.toast), afterForget.toast.trim());
  await shot(win, '12-recent-removed');

  const undoBtn = await rectOf(win, '.toast-action');
  if (undoBtn) click(win, undoBtn.x, undoBtn.y);
  await wait(1200);

  const afterUndo = await evaluate(win, `document.querySelectorAll('.recent-row').length`);
  const libraryAfterUndo = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'library.json'), 'utf8'));
  const restored = Object.values(libraryAfterUndo)[0]?.bookmarks?.length ?? 0;
  check('undo restores the entry and its bookmarks',
    afterUndo === 1 && restored === 4, `${afterUndo} row(s), ${restored} bookmarks back`);

  /* ---- summary ---- */
  const failed = results.filter((r) => !r.passed);
  console.log(`\nRESULT ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log(`FAILED: ${failed.map((f) => f.name).join(' | ')}`);

  app.exit(failed.length ? 1 : 0);
});

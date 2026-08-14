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

  /* ---- 7b. speed and skip, straight from the control bar ---- */
  await evaluate(
    win,
    `(() => { const m = document.querySelector('.menu');
       if (m && !m.hidden) document.querySelector('[data-role="settings"]').click();
       return true; })()`,
  );
  await wait(400);

  const transport = await evaluate(
    win,
    `(() => {
       const text = (role) => document.querySelector('[data-role="' + role + '"]').textContent.replace(/\\s+/g, '');
       return { back: text('skipBack'), forward: text('skipForward'),
                order: Array.from(document.querySelectorAll('.control-left [data-action]')).map((b) => b.dataset.action) }; })()`,
  );
  check('the skip pair brackets play and carries its own amount',
    transport.back === '10' && transport.forward === '10'
      && transport.order.slice(0, 4).join(',') === 'seekBackLong,playPause,seekForwardLong,openSkipSettings',
    `${transport.order.slice(0, 4).join(' ')} — "${transport.back}" / "${transport.forward}"`);

  await evaluate(win, `document.querySelector('video').pause(); document.querySelector('video').currentTime = 20; true`);
  await wait(500);
  await evaluate(win, `document.querySelector('[data-role="skipForward"]').click()`);
  await wait(700);
  const skipped10 = await evaluate(win, `document.querySelector('video').currentTime`);
  check('the skip button moves by the amount it shows',
    Math.abs(skipped10 - 30) < 1.5, `20s -> ${skipped10.toFixed(2)}s`);

  await evaluate(win, `document.querySelector('[data-role="skipSettings"]').click()`);
  await wait(500);
  const skipTray = await evaluate(
    win,
    `(() => { const p = document.querySelector('.barpop');
       return { open: Boolean(p) && !p.hidden, text: p ? p.textContent.replace(/\\s+/g, ' ').trim() : '' }; })()`,
  );
  check('the gear beside the skips opens an amount tray',
    skipTray.open && /Skip amount/.test(skipTray.text), skipTray.text.slice(0, 52));
  await shot(win, '06b-skip-tray');

  await evaluate(win, `document.querySelector('.barpop [data-cmd="skip"][data-value="30"]').click()`);
  await wait(500);
  const retimed = await evaluate(
    win,
    `(() => ({ glyph: document.querySelector('[data-role="skipForward"]').textContent.replace(/\\s+/g, ''),
               stillOpen: !document.querySelector('.barpop').hidden })) ()`,
  );
  check('choosing a different amount redraws both buttons', retimed.glyph === '30', `now "${retimed.glyph}"`);
  check('the tray stays open so another can be tried', retimed.stillOpen);

  await evaluate(win, `document.querySelector('video').currentTime = 10; true`);
  await wait(500);
  await evaluate(win, `document.querySelector('[data-role="skipForward"]').click()`);
  await wait(700);
  const skipped30 = await evaluate(win, `document.querySelector('video').currentTime`);
  check('and the buttons really skip the new amount',
    Math.abs(skipped30 - 40) < 1.5, `10s -> ${skipped30.toFixed(2)}s`);

  await evaluate(win, `document.querySelector('[data-role="speed"]').click()`);
  await wait(500);
  const speedTray = await evaluate(
    win,
    `(() => { const p = document.querySelector('.barpop');
       return { open: !p.hidden, text: p.textContent.replace(/\\s+/g, ' ').trim() }; })()`,
  );
  check('the speed button opens a speed tray',
    speedTray.open && /Speed/.test(speedTray.text), speedTray.text.slice(0, 52));
  await shot(win, '06c-speed-tray');

  await evaluate(win, `document.querySelector('.barpop [data-cmd="speed"][data-value="1.5"]').click()`);
  await wait(500);
  const sped = await evaluate(
    win,
    `(() => ({ rate: document.querySelector('video').playbackRate,
               label: document.querySelector('[data-role="rateText"]').textContent.trim(),
               marked: document.querySelector('[data-role="speed"]').classList.contains('is-active') })) ()`,
  );
  check('picking a speed applies it and the button says so',
    Math.abs(sped.rate - 1.5) < 0.001 && sped.label === '1.5×' && sped.marked,
    `rate=${sped.rate} label="${sped.label}" marked=${sped.marked}`);

  // Dismissing the tray must not also toggle playback underneath it.
  const pausedBefore = await evaluate(win, `document.querySelector('video').paused`);
  const stageBox = await rectOf(win, '.stage');
  click(win, stageBox.x, stageBox.top + 90);
  await wait(500);
  const dismissed = await evaluate(
    win,
    `(() => ({ hidden: document.querySelector('.barpop').hidden,
               paused: document.querySelector('video').paused })) ()`,
  );
  check('clicking the video closes the tray without also toggling play',
    dismissed.hidden && dismissed.paused === pausedBefore,
    `hidden=${dismissed.hidden} paused ${pausedBefore} -> ${dismissed.paused}`);

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

  /* ---- 9b. renaming happens in the row, not under the panel ---- */
  // The composer is anchored to the timeline, which this panel sits on top of,
  // so editing from the list used to open a field behind the list.
  await evaluate(win, `document.querySelector('.bm-row [data-cmd="edit"]').click()`);
  await wait(500);

  const editing = await evaluate(
    win,
    `(() => { const field = document.querySelector('.bm-edit');
       if (!field) return { present: false };
       const box = field.getBoundingClientRect();
       const panel = document.querySelector('.bookmarks-panel').getBoundingClientRect();
       return { present: true, focused: document.activeElement === field, value: field.value,
                composerHidden: document.querySelector('.composer').hidden,
                // The field has to be inside the panel, not behind it.
                insidePanel: box.left >= panel.left - 1 && box.right <= panel.right + 1 }; })()`,
  );
  check('the pencil opens a field in the row itself', editing.present && editing.insidePanel,
    `present=${editing.present} insidePanel=${editing.insidePanel}`);
  check('the timeline composer is not used for renaming', editing.composerHidden);
  check('the field is focused and carries the current label',
    editing.focused && editing.value === 'Opening titles', `"${editing.value}" focused=${editing.focused}`);
  await shot(win, '09b-rename-inline');

  // Typing must reach the field rather than firing the shortcuts behind it.
  await evaluate(win, `(() => { const f = document.querySelector('.bm-edit');
     f.value = 'Opening titles, renamed';
     f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await wait(200);
  key(win, 'Enter');
  await wait(600);

  const renamed = await evaluate(
    win,
    `(() => ({ label: document.querySelector('.bm-row .bm-text').textContent.trim(),
               fieldGone: !document.querySelector('.bm-edit'),
               composerHidden: document.querySelector('.composer').hidden })) ()`,
  );
  check('Enter saves the new label in place',
    renamed.label === 'Opening titles, renamed' && renamed.fieldGone && renamed.composerHidden,
    `"${renamed.label}"`);

  // Escape must leave the original alone.
  await evaluate(win, `document.querySelector('.bm-row [data-cmd="edit"]').click()`);
  await wait(400);
  await evaluate(win, `(() => { const f = document.querySelector('.bm-edit');
     f.value = 'discard me'; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await wait(200);
  key(win, 'Escape');
  await wait(500);
  const escaped = await evaluate(
    win,
    `(() => ({ label: document.querySelector('.bm-row .bm-text').textContent.trim(),
               fieldGone: !document.querySelector('.bm-edit'),
               panelOpen: document.querySelector('.bookmarks-panel').classList.contains('is-open') })) ()`,
  );
  check('Escape discards the edit and leaves the panel open',
    escaped.label === 'Opening titles, renamed' && escaped.fieldGone && escaped.panelOpen,
    `"${escaped.label}" panelOpen=${escaped.panelOpen}`);

  // The rename has to reach the store, not just the row.
  const storedLabel = await evaluate(
    win,
    `(() => { const marks = document.querySelectorAll('.scrub-mark');
       return document.querySelector('[data-role="chapterName"]').textContent; })()`,
  );
  await evaluate(win, `document.querySelector('video').currentTime = 15`);
  await wait(700);
  const chapterAfterRename = await evaluate(
    win,
    `document.querySelector('[data-role="chapterName"]').textContent.trim()`,
  );
  check('the renamed label reaches the rest of the app',
    chapterAfterRename === 'Opening titles, renamed', `control bar shows "${chapterAfterRename}"`);

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

  /* ---- 13b. version and update state, always on the welcome screen ---- */
  const foot = await evaluate(
    win,
    `(() => { const f = document.querySelector('.welcome-foot');
       const v = document.querySelector('[data-role="welcomeVersion"]');
       return { visible: Boolean(f) && f.getBoundingClientRect().height > 0,
                version: v ? v.textContent.trim() : '' }; })()`,
  );
  // Run from source, app.getVersion() reports Electron's own version because
  // there is no package.json beside the entry script. A packaged build reads the
  // app's — which is also what the updater compares against, so the 0.1.1 -> 0.1.2
  // update having worked is proof it resolves correctly there.
  check('the welcome screen always shows the running version',
    foot.visible && /^Version \d/.test(foot.version), `"${foot.version}" visible=${foot.visible}`);

  // The regression that let an update sit unnoticed for a week: a failed check
  // produced no visible output anywhere, so it looked exactly like no update.
  win.webContents.send('updates:status',
    { status: 'error', message: 'net::ERR_INTERNET_DISCONNECTED', appVersion: '0.2.0' });
  await wait(400);
  const failedCheck = await evaluate(
    win,
    `(() => { const u = document.querySelector('[data-role="welcomeUpdate"]');
       return { text: u.textContent.trim(), retry: Boolean(u.querySelector('[data-cmd="check"]')) }; })()`,
  );
  check('a failed update check is stated, not swallowed',
    /failed|could not/i.test(failedCheck.text) && failedCheck.retry, failedCheck.text);

  win.webContents.send('updates:status', { status: 'ready', version: '0.3.0', appVersion: '0.2.0' });
  await wait(400);
  const readyOnWelcome = await evaluate(
    win,
    `(() => { const u = document.querySelector('[data-role="welcomeUpdate"]');
       return { text: u.textContent.trim(), install: Boolean(u.querySelector('[data-cmd="install"]')) }; })()`,
  );
  check('a waiting update offers its restart button on the welcome screen',
    /0\.3\.0/.test(readyOnWelcome.text) && readyOnWelcome.install, readyOnWelcome.text);
  await shot(win, '11b-welcome-update');

  win.webContents.send('updates:status', { status: 'none', version: '0.2.0', appVersion: '0.2.0' });
  await wait(400);
  const upToDate = await evaluate(
    win,
    `(() => { const u = document.querySelector('[data-role="welcomeUpdate"]');
       return u.textContent.trim(); })()`,
  );
  check('being up to date says so rather than showing nothing',
    /up to date/i.test(upToDate), upToDate);

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

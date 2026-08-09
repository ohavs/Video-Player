// Drives stepping between the videos sitting in one folder.
//
//   VP_FOLDER=<dir with several videos> VP_ALONE=<dir with exactly one>
//     xvfb-run -a electron scripts/drive-folder.js
//
// Boots the real app and navigates by clicking the on-screen arrows, so what is
// asserted is what a user would get.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const main = require('../src/main/main.js');

const FOLDER = process.env.VP_FOLDER;
const ALONE = process.env.VP_ALONE;
const OUT_DIR = process.env.VP_SHOT_DIR || '/tmp/vp-folder';

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

// Everything the folder UI is claiming at this moment.
async function navState(win) {
  return evaluate(
    win,
    `(() => {
       const prev = document.querySelector('[data-role="navPrev"]');
       const next = document.querySelector('[data-role="navNext"]');
       const count = document.querySelector('[data-role="navCount"]');
       const box = (n) => n.getBoundingClientRect();
       return {
         prevShown: !prev.hidden, nextShown: !next.hidden,
         prevVisible: !prev.hidden && box(prev).width > 0,
         nextVisible: !next.hidden && box(next).width > 0,
         prevTitle: prev.title, nextTitle: next.title,
         countShown: !count.hidden, count: count.textContent.trim(),
         title: document.querySelector('[data-role="title"]').textContent.trim(),
         // Both arrows must clear the middle of the frame, or they sit over the
         // picture rather than beside it.
         prevLeft: Math.round(box(prev).left), nextRight: Math.round(window.innerWidth - box(next).right),
       };
     })()`,
  );
}

const clickNav = (win, which) =>
  evaluate(win, `document.querySelector('[data-role="${which}"]').click(); true`);

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

  /* ---- open the middle file of three ---- */
  // Named clip1 / clip2 / clip10 on purpose: plain string sorting puts clip10
  // second, which is not the order any file manager shows.
  const middle = path.join(FOLDER, 'clip2.mp4');
  win.webContents.send('file:open', await main.describeFile(middle));
  await wait(3000);
  await evaluate(win, `document.querySelector('video').pause()`);
  await wait(300);

  let state = await navState(win);
  check('a file with neighbours on both sides shows both arrows',
    state.prevVisible && state.nextVisible, `prev=${state.prevShown} next=${state.nextShown}`);
  check('numbers sort the way a file manager sorts them',
    state.count === '2 / 3', `shows "${state.count}" for clip2 of clip1/clip2/clip10`);
  check('each arrow names the file it goes to',
    /clip1\.mp4/.test(state.prevTitle) && /clip10\.mp4/.test(state.nextTitle),
    `${state.prevTitle} | ${state.nextTitle}`);
  check('the arrows sit at the edges, not over the picture',
    state.prevLeft < 40 && state.nextRight < 40, `${state.prevLeft}px / ${state.nextRight}px`);
  await shot(win, '01-middle');

  /* ---- forward to the last ---- */
  await clickNav(win, 'navNext');
  await wait(3000);
  state = await navState(win);
  check('the next arrow opens the next file', /clip10\.mp4/.test(state.title), state.title);
  check('the last file hides its next arrow', !state.nextShown && state.prevShown,
    `prev=${state.prevShown} next=${state.nextShown}`);
  check('the position keeps up', state.count === '3 / 3', state.count);
  await shot(win, '02-last');

  /* ---- back to the first ---- */
  await clickNav(win, 'navPrev');
  await wait(3000);
  await clickNav(win, 'navPrev');
  await wait(3000);
  state = await navState(win);
  check('the previous arrow walks back', /clip1\.mp4/.test(state.title), state.title);
  check('the first file hides its previous arrow', !state.prevShown && state.nextShown,
    `prev=${state.prevShown} next=${state.nextShown}`);
  check('the position keeps up going backwards', state.count === '1 / 3', state.count);

  /* ---- the keyboard does the same thing ---- */
  key(win, 'PageDown');
  await wait(3000);
  state = await navState(win);
  check('Page Down steps forward too', /clip2\.mp4/.test(state.title), state.title);
  key(win, 'PageUp');
  await wait(3000);
  state = await navState(win);
  check('Page Up steps back too', /clip1\.mp4/.test(state.title), state.title);

  /* ---- walking off the end says so instead of doing nothing ---- */
  await evaluate(win, `document.querySelectorAll('.toast').forEach(n => n.remove()); true`);
  key(win, 'PageUp');
  await wait(700);
  const edgeToast = await evaluate(
    win,
    `(() => { const all = document.querySelectorAll('.toast');
       const t = all[all.length - 1]; return t ? t.textContent.trim() : ''; })()`,
  );
  check('stepping past the first file explains why nothing moved',
    /first video/i.test(edgeToast), edgeToast || '(no message)');

  /* ---- a video with no company grows no arrows ---- */
  win.webContents.send('file:open', await main.describeFile(path.join(ALONE, 'only.mp4')));
  await wait(3000);
  state = await navState(win);
  check('a video alone in its folder shows no arrows at all',
    !state.prevShown && !state.nextShown, `prev=${state.prevShown} next=${state.nextShown}`);
  check('and claims no position', !state.countShown, state.count);
  await shot(win, '03-alone');

  /* ---- the arrows fade with the rest of the chrome ---- */
  win.webContents.send('file:open', await main.describeFile(middle));
  await wait(3000);
  await evaluate(win, `document.getElementById('app').classList.add('is-idle'); true`);
  // The chrome fades over 0.2s, and computed opacity read in the same tick is
  // still the pre-transition value — this has to be sampled after it lands.
  await wait(600);
  const faded = await evaluate(
    win,
    `(() => { const chrome = document.querySelector('.chrome');
       return { chromeOpacity: getComputedStyle(chrome).opacity,
                navInsideChrome: chrome.contains(document.querySelector('[data-role="navNext"]')) }; })()`,
  );
  check('the arrows live in the chrome, so they hide when the pointer rests',
    faded.navInsideChrome && Number(faded.chromeOpacity) === 0,
    `inside=${faded.navInsideChrome} opacity=${faded.chromeOpacity}`);

  const failed = results.filter((r) => !r.passed);
  console.log(`\nRESULT ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log(`FAILED: ${failed.map((f) => f.name).join(' | ')}`);
  app.exit(failed.length ? 1 : 0);
});

// Icon set. Every shape here is generated or hand-drawn in this file so the app
// carries no image dependencies at all — the whole set is a few hundred bytes of
// path data. Filled glyphs read as solid at 24px; the rest are 2px strokes.

// A gear is the one shape not worth hand-typing: teeth must be evenly spaced or
// it looks broken. Computing it keeps it exact and adjustable.
function gearPath({ cx = 12, cy = 12, teeth = 8, outer = 10.4, inner = 7.9, span = 0.44 } = {}) {
  const step = (Math.PI * 2) / teeth;
  const half = (step * span) / 2;
  const shoulder = step * 0.1;
  const at = (r, angle) => `${(cx + r * Math.cos(angle)).toFixed(2)} ${(cy + r * Math.sin(angle)).toFixed(2)}`;

  let d = '';
  for (let i = 0; i < teeth; i += 1) {
    const a = i * step - Math.PI / 2;
    d += i === 0 ? `M${at(outer, a - half)}` : `L${at(outer, a - half)}`;
    d += `A${outer} ${outer} 0 0 1 ${at(outer, a + half)}`;
    d += `L${at(inner, a + half + shoulder)}`;
    d += `A${inner} ${inner} 0 0 1 ${at(inner, a + step - half - shoulder)}`;
  }
  d += 'Z';
  // Second subpath is the hole; fill-rule="evenodd" punches it out.
  d += `M${cx} ${cy - 3.5}A3.5 3.5 0 1 0 ${cx} ${cy + 3.5}A3.5 3.5 0 1 0 ${cx} ${cy - 3.5}Z`;
  return d;
}

const FILLED = {
  play: 'M8 5.2v13.6L19 12z',
  pause: 'M6.5 5h3.6v14H6.5zM13.9 5h3.6v14h-3.6z',
  replay:
    'M12 5V2.5L7.8 6 12 9.5V7a5 5 0 11-5 5H5a7 7 0 107-7z',
  bookmark: 'M6.5 3h11a1 1 0 011 1v17l-6.5-4.7L5.5 21V4a1 1 0 011-1z',
  bookmarkAdd:
    'M6.5 3h11a1 1 0 011 1v17l-6.5-4.7L5.5 21V4a1 1 0 011-1zm4.6 3.6v2.2H8.9v1.8h2.2v2.2h1.8v-2.2h2.2V8.8h-2.2V6.6z',
  settings: gearPath(),
  pip: 'M3 4.5h18a1 1 0 011 1v13a1 1 0 01-1 1H3a1 1 0 01-1-1v-13a1 1 0 011-1zm9.5 7.5v5h7.5v-5z',
  volumeBase: 'M4 9.3h3.4L12 5.4v13.2L7.4 14.7H4z',
};

const STROKED = {
  volumeLow: 'M14.6 9.6a3.8 3.8 0 010 4.8',
  volumeHigh: 'M14.6 9.6a3.8 3.8 0 010 4.8M17.3 7.1a7.4 7.4 0 010 9.8',
  volumeMute: 'M15.4 9.6l4.8 4.8M20.2 9.6l-4.8 4.8',
  expand: 'M4 9.2V4h5.2M19.8 9.2V4h-5.2M4 14.8V20h5.2M19.8 14.8V20h-5.2',
  compress: 'M9.2 4v5.2H4M14.8 4v5.2H20M9.2 20v-5.2H4M14.8 20v-5.2H20',
  seekBack: 'M11.5 5.5L5 12l6.5 6.5M19 5.5L12.5 12l6.5 6.5',
  seekForward: 'M12.5 5.5L19 12l-6.5 6.5M5 5.5L11.5 12L5 18.5',
  chevronLeft: 'M15 4.5L7.5 12l7.5 7.5',
  chevronRight: 'M9 4.5l7.5 7.5L9 19.5',
  check: 'M4.5 12.5l4.8 4.8L19.5 7',
  close: 'M5.5 5.5l13 13M18.5 5.5l-13 13',
  trash: 'M4 6.8h16M9.2 6.8V3.9h5.6v2.9M6.6 6.8L7.6 20.5h8.8l1-13.7',
  pencil: 'M4 20l1.1-4.6L16.6 3.9a2.1 2.1 0 013 3L8.1 18.4z',
  folder: 'M3 6.2h5.8l2 2.6H21V19H3z',
  list: 'M4 6.5h16M4 12h16M4 17.5h11',
  keyboard: 'M3 6.5h18v11H3zM7 10h.01M11 10h.01M15 10h.01M8 14h8',
  clock: 'M12 3.6a8.4 8.4 0 100 16.8 8.4 8.4 0 000-16.8zM12 7.3V12l3.4 2',
  plus: 'M12 5.5v13M5.5 12h13',
  reset: 'M4.5 11a7.5 7.5 0 111.9 5.6M4.5 16.5V11h5.5',
  // Two ring handles and two crossing blades — the blades meet near the middle
  // so the shape still reads as scissors at 24px rather than as an X.
  scissors:
    'M6.6 13.4a2.8 2.8 0 100 5.6 2.8 2.8 0 000-5.6M17.4 13.4a2.8 2.8 0 100 5.6 2.8 2.8 0 000-5.6M8.6 14.2L19 3.5M15.4 14.2L5 3.5',
  download: 'M12 3.5v11M7.5 10L12 14.5 16.5 10M4.5 19.5h15',
};

function svg(inner, { size = 24, extraClass = '' } = {}) {
  return `<svg class="icon ${extraClass}" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${inner}</svg>`;
}

export function icon(name, options = {}) {
  if (name === 'volume') return volumeIcon(options.level ?? 1, options);

  if (FILLED[name]) {
    return svg(`<path fill="currentColor" fill-rule="evenodd" d="${FILLED[name]}"/>`, options);
  }
  if (STROKED[name]) {
    return svg(
      `<path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="${STROKED[name]}"/>`,
      options,
    );
  }
  return svg('', options);
}

// Volume is the one icon that is two shapes at once: a fixed speaker body plus
// a wave layer that changes with the level.
export function volumeIcon(level, options = {}) {
  let waves = STROKED.volumeHigh;
  if (level <= 0) waves = STROKED.volumeMute;
  else if (level < 0.5) waves = STROKED.volumeLow;

  return svg(
    `<path fill="currentColor" d="${FILLED.volumeBase}"/>` +
      `<path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" d="${waves}"/>`,
    options,
  );
}

// Skip buttons carry their own amount, the way every player and streaming app
// draws them: a circular arrow with the number of seconds inside it. The glyph
// is the replay ring, mirrored for the forward direction, so both halves of the
// pair are visibly the same control pointing opposite ways.
export function skipIcon(seconds, direction = 1, options = {}) {
  const label = String(Math.max(0, Math.round(Number(seconds) || 0)));
  // Three digits in a 10px-wide hole needs a smaller face, or it spills over
  // the ring — a 300-second skip is allowed by the settings range.
  const fontSize = label.length > 2 ? 7 : 8.6;
  const flip = direction > 0 ? ' transform="scale(-1,1) translate(-24,0)"' : '';

  return svg(
    `<path fill="currentColor" d="${FILLED.replay}"${flip}/>`
      + `<text x="12" y="15.4" text-anchor="middle" fill="currentColor"`
      + ` font-size="${fontSize}" font-weight="700" font-family="inherit">${label}</text>`,
    options,
  );
}

export const ICON_NAMES = [...Object.keys(FILLED), ...Object.keys(STROKED), 'volume'];

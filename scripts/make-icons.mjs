/**
 * Draws the Home Screen icon set.
 *
 * The icons are committed, so this only runs when the mark itself changes:
 *
 *   node scripts/make-icons.mjs
 *
 * It exists rather than a checked-in binary blob with no provenance, because
 * "where did this PNG come from and how do I make a 1024 one" is a question
 * that otherwise has no answer. No image library is involved — a PNG is a
 * zlib stream of filtered scanlines, and node ships zlib.
 *
 * The mark is the diamond the Draft tab already uses (◈), in the dark theme's
 * accent on the dark theme's page black. Deliberately not a new logo: the brief
 * for this work says to use the project's own visual language rather than
 * introduce branding the app does not have.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../src/web/public/', import.meta.url));

/* The palette, taken from the dark theme in src/web/styles.css. */
const TOP = [0x17, 0x20, 0x2c]; // page black, lifted slightly at the top edge
const BOTTOM = [0x0b, 0x0f, 0x14];
const MARK = [0x8f, 0xba, 0xff]; // --accent-text (dark)
const MARK_DIM = [0x4c, 0x7c, 0xd6]; // the inner pip, a step back so the ring leads

/**
 * Coverage of the mark at a point, in a unit square with the origin at the
 * centre. A diamond is `|x| + |y|`, which is why the shape is cheap enough to
 * supersample for free.
 */
function mark(x, y, scale) {
  const d = Math.abs(x) + Math.abs(y);
  const ringOuter = 0.62 * scale;
  const ringInner = 0.44 * scale;
  const pip = 0.2 * scale;
  if (d <= pip) return 'pip';
  if (d >= ringInner && d <= ringOuter) return 'ring';
  return null;
}

/**
 * @param size    pixels square
 * @param scale   how much of the tile the mark spans; a maskable icon keeps
 *                its mark inside the middle 80% because the platform is free
 *                to crop a circle out of the rest.
 */
function draw(size, scale) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4; // supersampling; the diamond's diagonals alias badly without it
  for (let py = 0; py < size; py++) {
    const t = py / (size - 1);
    const bg = [0, 1, 2].map((c) => Math.round(TOP[c] + (BOTTOM[c] - TOP[c]) * t));
    for (let pxi = 0; pxi < size; pxi++) {
      let ring = 0;
      let pip = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((pxi + (sx + 0.5) / SS) / size - 0.5) * 2;
          const y = ((py + (sy + 0.5) / SS) / size - 0.5) * 2;
          const hit = mark(x, y, scale);
          if (hit === 'ring') ring++;
          else if (hit === 'pip') pip++;
        }
      }
      const total = SS * SS;
      const i = (py * size + pxi) * 4;
      const over = (under, colour, coverage) =>
        under.map((v, c) => Math.round(colour[c] * coverage + v * (1 - coverage)));
      let rgb = bg;
      if (pip) rgb = over(rgb, MARK_DIM, pip / total);
      if (ring) rgb = over(rgb, MARK, ring / total);
      px[i] = rgb[0];
      px[i + 1] = rgb[1];
      px[i + 2] = rgb[2];
      px[i + 3] = 255; // opaque: iOS composites a Home Screen icon on nothing
    }
  }
  return px;
}

/* -- the PNG container ----------------------------------------------------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  // Every scanline is prefixed with its filter type; 0 (none) keeps this
  // readable, and the flat regions compress away regardless.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -- the set --------------------------------------------------------------- */

const ICONS = [
  { file: 'icon-192.png', size: 192, scale: 1 },
  { file: 'icon-512.png', size: 512, scale: 1 },
  // Maskable: the mark stays inside the safe circle, so a platform that crops
  // to a circle or a squircle never clips it.
  { file: 'icon-maskable-512.png', size: 512, scale: 0.72 },
  // iOS uses this one for the Home Screen and rounds the corners itself.
  { file: 'apple-touch-icon.png', size: 180, scale: 1 },
];

mkdirSync(OUT, { recursive: true });
for (const { file, size, scale } of ICONS) {
  const bytes = png(size, draw(size, scale));
  writeFileSync(join(OUT, file), bytes);
  console.log(`${file.padEnd(24)} ${size}×${size}  ${(bytes.length / 1024).toFixed(1)} kB`);
}

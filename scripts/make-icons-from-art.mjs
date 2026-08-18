/**
 * Draws the Home Screen icon set by resampling a single square illustration.
 *
 *   node scripts/make-icons-from-art.mjs path/to/artwork.png
 *
 * This is the script that actually produced the committed icons in
 * src/web/public/ (icon-192.png, icon-512.png, icon-maskable-512.png,
 * apple-touch-icon.png, favicon.svg) from "The Junculator" artwork. Its
 * sibling, make-icons.mjs, draws a 32x32 pixel-art grid instead and is kept
 * only as a worked example — running that one would overwrite these with the
 * old Yoshi sprite.
 *
 * The master illustration is not in the repository: it is a couple of
 * megabytes of artwork that changes when the brand changes, not when the code
 * does, so it lives wherever the brand assets live and gets passed in. What
 * belongs in git is this file — "where did this PNG come from and how do I
 * make a 512 one" is a question that otherwise has no answer — plus the small
 * derived PNGs the site actually serves.
 *
 * No image library is involved, for the same reason make-icons.mjs has none:
 * a PNG is a zlib stream of filtered scanlines, and node ships zlib. The
 * decoder handles the 8-bit non-interlaced files that illustration tools
 * export; it will refuse anything else rather than emit quietly wrong pixels.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../src/web/public/', import.meta.url));

/* -- reading the master ----------------------------------------------------- */

/** Channel count per PNG colour type; the ones outside this map are palettes
 * and sub-byte greyscales, which no illustration export produces. */
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Decodes a PNG to a flat RGBA buffer, so the rest of the file handles one
 * pixel layout regardless of what the source was saved as. */
function decode(buf) {
  if (buf.subarray(1, 4).toString('latin1') !== 'PNG') throw new Error('not a PNG');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const depth = buf[24];
  const colour = buf[25];
  if (depth !== 8) throw new Error(`bit depth ${depth} unsupported — re-export as 8-bit`);
  if (buf[28] !== 0) throw new Error('interlaced PNG unsupported — re-export without Adam7');
  const ch = CHANNELS[colour];
  if (!ch) throw new Error(`colour type ${colour} unsupported — re-export as RGB or RGBA`);

  // The image is one zlib stream split across however many IDAT chunks the
  // encoder felt like emitting, so collect them all before inflating.
  const parts = [];
  for (let off = 8; off < buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    if (type === 'IDAT') parts.push(buf.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));

  // Undo the per-scanline filter. Each byte was stored as a difference from
  // some combination of its neighbour to the left (a), the one above (b) and
  // the one above-left (c) — all read back out of the output written so far.
  const stride = width * ch;
  const flat = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? flat[y * stride + x - ch] : 0;
      const b = y > 0 ? flat[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? flat[(y - 1) * stride + x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      flat[y * stride + x] = v & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * ch;
    const grey = colour === 0 || colour === 4;
    rgba[i * 4] = grey ? flat[s] : flat[s];
    rgba[i * 4 + 1] = grey ? flat[s] : flat[s + 1];
    rgba[i * 4 + 2] = grey ? flat[s] : flat[s + 2];
    rgba[i * 4 + 3] = colour === 4 ? flat[s + 1] : colour === 6 ? flat[s + 3] : 255;
  }
  return { width, height, rgba };
}

/* -- resampling ------------------------------------------------------------- */

/**
 * Area-averaging resample: every destination pixel is the mean of the source
 * region it covers, weighted by how much of each source pixel falls inside.
 *
 * This is the filter a large downscale wants. Point sampling a 1254px
 * illustration down to 180 would land on whichever single pixel happened to
 * sit under each sample point, which on artwork this detailed turns the fine
 * lines — the glasses, the calculator keys, the wordmark's serifs — into
 * aliased noise that shimmers differently at each output size.
 */
function resample(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const xr = sw / dw;
  const yr = sh / dh;
  for (let dy = 0; dy < dh; dy++) {
    const y0 = dy * yr;
    const y1 = (dy + 1) * yr;
    for (let dx = 0; dx < dw; dx++) {
      const x0 = dx * xr;
      const x1 = (dx + 1) * xr;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let total = 0;
      for (let sy = Math.floor(y0); sy < Math.min(Math.ceil(y1), sh); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.min(Math.ceil(x1), sw); sx++) {
          const w = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx));
          const i = (sy * sw + sx) * 4;
          r += src[i] * w;
          g += src[i + 1] * w;
          b += src[i + 2] * w;
          a += src[i + 3] * w;
          total += w;
        }
      }
      const i = (dy * dw + dx) * 4;
      out[i] = Math.round(r / total);
      out[i + 1] = Math.round(g / total);
      out[i + 2] = Math.round(b / total);
      out[i + 3] = Math.round(a / total);
    }
  }
  return out;
}

/**
 * Resamples the artwork to `size`, optionally shrunk toward the centre and
 * padded out to the full canvas with `pad`.
 *
 * `scale` below 1 is for the maskable icon: a platform that crops to a circle
 * or a squircle is allowed to eat the outer ~10% on each side, so the artwork
 * has to sit inside that safe zone with something behind it.
 */
function render(art, size, scale, pad) {
  const inner = Math.round((size * scale) / 2) * 2; // even, so the margins match
  const offset = (size - inner) / 2;
  const scaled = resample(art.rgba, art.width, art.height, inner, inner);
  if (inner === size) return scaled;

  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = pad[0];
    out[i * 4 + 1] = pad[1];
    out[i * 4 + 2] = pad[2];
    out[i * 4 + 3] = 255;
  }
  for (let y = 0; y < inner; y++) {
    scaled.copy(out, ((y + offset) * size + offset) * 4, y * inner * 4, (y + 1) * inner * 4);
  }
  return out;
}

/* -- writing the PNG container ---------------------------------------------- */

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

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
  // Paeth on every scanline, unlike make-icons.mjs's filter 0. Flat pixel-art
  // runs compress away on their own; a resampled illustration has a gradient
  // almost everywhere, and predicting from the neighbours roughly halves it.
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 4;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? rgba[y * stride + x - 4] : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4] : 0;
      raw[y * (stride + 1) + 1 + x] = (rgba[y * stride + x] - paeth(a, b, c)) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -- the set ---------------------------------------------------------------- */

/* The artwork is a green frame floating on black, so black is what the
 * maskable icon pads with — anything else would draw a visible seam around
 * the frame on the platforms that don't crop as tightly as they may. */
const PAD = [0, 0, 0];

const ICONS = [
  { file: 'icon-192.png', size: 192, scale: 1 },
  { file: 'icon-512.png', size: 512, scale: 1 },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.8 },
  // iOS uses this one for the Home Screen and rounds the corners itself.
  { file: 'apple-touch-icon.png', size: 180, scale: 1 },
];

const source = process.argv[2];
if (!source) {
  console.error('usage: node scripts/make-icons-from-art.mjs path/to/artwork.png');
  process.exit(1);
}

/**
 * The tab icon, as a raster wrapped in an SVG shell.
 *
 * There is nothing scalable in here — this artwork is a painted illustration,
 * so the "vector" favicon has always been an <image> element. What the SVG
 * buys is the one thing a bare PNG favicon cannot do: browsers treat it as
 * resolution-independent and hand it whatever box they like, rather than
 * picking a fixed .ico size and smearing it.
 *
 * 64 is the size to embed: the tab strip draws it at 16 or 32 CSS px, and
 * anything larger is base64 inflating every page load for detail nobody sees.
 */
function favicon(art) {
  const png64 = png(64, render(art, 64, 1, PAD)).toString('base64');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="The Junculator">
  <image href="data:image/png;base64,${png64}" width="64" height="64" />
</svg>
`;
}

const art = decode(readFileSync(source));
if (art.width !== art.height) {
  // Every target is square; cropping is a decision about the artwork, not one
  // this script should make silently on the way past.
  throw new Error(`artwork is ${art.width}x${art.height} — crop it square first`);
}
console.log(`source ${source}  ${art.width}x${art.height}`);

mkdirSync(OUT, { recursive: true });
for (const { file, size, scale } of ICONS) {
  const bytes = png(size, render(art, size, scale, PAD));
  writeFileSync(join(OUT, file), bytes);
  console.log(`${file.padEnd(24)} ${size}x${size}  ${(bytes.length / 1024).toFixed(1)} kB`);
}

const svg = favicon(art);
writeFileSync(join(OUT, 'favicon.svg'), svg);
console.log(`${'favicon.svg'.padEnd(24)} 64x64    ${(svg.length / 1024).toFixed(1)} kB`);

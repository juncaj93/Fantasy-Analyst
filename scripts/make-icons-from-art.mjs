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

/* -- erasing outline elements the icon doesn't want ---------------------------
 *
 * The illustration draws a green stroke around every element — the
 * character's silhouette, the football, the calculator, the trophy, the
 * "THE JUNCULATOR" badge, and a large rounded-square frame around the whole
 * scene — as its line style. Two of those are cropped for the icon rather
 * than kept: the badge's own stroke, and the frame. The frame is mostly
 * outside ZOOM's crop already, but VERTICAL_SHIFT pushes the crop window's
 * bottom edge to the source's bottom edge to show more of the badge, and the
 * frame's bottom corners live exactly there — so a sliver of it survives
 * cropping as a stray curve along the bottom of every icon. Erasing it at
 * the source is simpler than re-tuning the crop to dodge a shape that was
 * never meant to be part of the icon in the first place. Every other
 * element's outline stays. */

/** True where a pixel is the artwork's outline green — saturated, and green
 * well ahead of both red and blue, which the badge fill, the white text and
 * the black background never are. */
function isOutlineGreen(rgba, w, h, x, y) {
  if (x < 0 || x >= w || y < 0 || y >= h) return false;
  const i = (y * w + x) * 4;
  const r = rgba[i];
  const g = rgba[i + 1];
  const b = rgba[i + 2];
  return g > 110 && g > r * 1.5 && g > b * 1.5;
}

/**
 * Below `yFrom`, finds the largest 8-connected blob of outline green that
 * never touches the source's left or right edge — which rules out the outer
 * frame, the one green shape down there big enough to compete — and returns
 * its pixel coordinates.
 */
function findBadgeOutline(art, yFrom) {
  const { width: w, height: h, rgba } = art;
  const visited = new Uint8Array(w * h);
  let best = null;
  for (let y = yFrom; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (visited[y * w + x] || !isOutlineGreen(rgba, w, h, x, y)) continue;
      const stack = [[x, y]];
      visited[y * w + x] = 1;
      const pixels = [];
      let touchesEdge = false;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        pixels.push([cx, cy]);
        if (cx === 0 || cx === w - 1) touchesEdge = true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= w || ny < yFrom || ny >= h) continue;
          if (visited[ny * w + nx] || !isOutlineGreen(rgba, w, h, nx, ny)) continue;
          visited[ny * w + nx] = 1;
          stack.push([nx, ny]);
        }
      }
      if (!touchesEdge && (!best || pixels.length > best.length)) best = pixels;
    }
  }
  if (!best) throw new Error('no badge outline found below the shoulder line — did the artwork change?');
  return best;
}

/**
 * Finds the outer frame: the single largest 8-connected blob of outline
 * green in the whole source, required to span almost the entire canvas in
 * both directions — a picture frame's signature, and not one any single
 * illustrated element shares. The character's own silhouette is the next
 * largest green shape in this artwork, and it falls well short on height,
 * because it stops at the shoulders rather than running the full canvas.
 * Bailing out below that threshold rather than always returning the largest
 * blob means a redraw that removed the frame gets a clear error here instead
 * of this function quietly erasing whatever illustrated element happened to
 * be biggest.
 */
function findOuterFrame(art) {
  const { width: w, height: h, rgba } = art;
  const visited = new Uint8Array(w * h);
  let best = null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (visited[y * w + x] || !isOutlineGreen(rgba, w, h, x, y)) continue;
      const stack = [[x, y]];
      visited[y * w + x] = 1;
      const pixels = [];
      let minX = x, maxX = x, minY = y, maxY = y;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        pixels.push([cx, cy]);
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          if (visited[ny * w + nx] || !isOutlineGreen(rgba, w, h, nx, ny)) continue;
          visited[ny * w + nx] = 1;
          stack.push([nx, ny]);
        }
      }
      if (!best || pixels.length > best.pixels.length) best = { pixels, minX, maxX, minY, maxY };
    }
  }
  if (!best || (best.maxX - best.minX) / w < 0.85 || (best.maxY - best.minY) / h < 0.85) {
    throw new Error('no full-canvas frame found — did the artwork change?');
  }
  return best.pixels;
}

/**
 * Paints a set of pixels solid black, in place.
 *
 * Not a blend or an inpaint: the badge fill and the background just outside
 * it are both already within a shade of pure black (checked against this
 * artwork — re-check if it changes), so removing the stroke is exactly
 * "the black now covers where the green line was," not a color to blend
 * toward. Blending toward each pixel's neighbours instead would smear in
 * whatever else touches the stroke — the white text sits flush against it in
 * places — and leave a grey ghost of the line rather than erasing it.
 */
function paintBlack(art, pixels) {
  const { width: w, rgba } = art;
  for (const [x, y] of pixels) {
    const i = (y * w + x) * 4;
    rgba[i] = 0;
    rgba[i + 1] = 0;
    rgba[i + 2] = 0;
  }
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

const sourcePath = process.argv[2];
if (!sourcePath) {
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

/**
 * How much of the artwork's outer margin to crop away before anything is
 * resampled from it.
 *
 * The illustration is drawn with a band of black outside its green frame,
 * which is right for a poster and wrong for an icon. iOS masks the Home
 * Screen to a squircle and takes its own bite out of the corners on top of
 * that margin, so at 1.0 the frame floated visibly inside the tile while the
 * logo it replaced had filled the tile edge to edge.
 *
 * 1.13 crops past the frame as well as the margin, so the icon is full bleed
 * — the picture runs to the tile edge and the trend line and background dots
 * bleed off it, the way the logo this artwork replaced did.
 *
 * Only two settings read as deliberate here, which is why this is not a dial
 * to nudge. Up to about 1.08 the frame survives as a ring flush to the edge.
 * From about 1.12 it is gone entirely. In between, the band — a few pixels
 * thick at 180 — is cropped away along the left and right midpoints, where
 * the squircle is at its widest and hides nothing, while surviving in the
 * corners; a ring present in places looks like a mistake in a way that either
 * whole answer does not.
 *
 * Re-measure if the artwork's margin changes.
 */
const ZOOM = 1.13;

/**
 * How far to slide the crop window down the source before cropping it,
 * in source pixels. 0 keeps the crop centred; positive trades the top of
 * the frame for the bottom, which is what "raise the logo" means once the
 * icon is already full bleed — there is no headroom to add, only a choice
 * of which edge gives it up.
 *
 * 72 is not a taste setting either: at ZOOM = 1.13 the crop window is
 * 1110px of a 1254px square, leaving 144px of slack split 72/72 above and
 * below when centred. Sliding the window down by the full 72px spends all
 * of it — the window's bottom edge lands exactly on the source's bottom
 * edge — which is the most of "The Junculator" and the trophy this crop
 * can show without cropping past the image itself. It costs a small strip
 * of the hairline at the top, which is the trade this was asked for.
 *
 * Re-measure alongside ZOOM if either changes.
 */
const VERTICAL_SHIFT = 72;

/** Crops the centre 1/zoom of a square image, slid down by `shift` source
 * pixels and clamped so the window never runs past the source's edges. */
function centreCrop(art, zoom, shift = 0) {
  if (zoom === 1 && shift === 0) return art;
  const side = Math.round(art.width / zoom);
  const xOff = Math.round((art.width - side) / 2);
  const yOff = Math.max(0, Math.min(art.width - side, xOff + shift));
  const rgba = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y++) {
    const from = ((y + yOff) * art.width + xOff) * 4;
    art.rgba.copy(rgba, y * side * 4, from, from + side * 4);
  }
  return { width: side, height: side, rgba };
}

const source = decode(readFileSync(sourcePath));
if (source.width !== source.height) {
  // A non-square source needs a decision about which part of the picture to
  // keep, and that is the illustrator's call rather than one this script
  // should make silently on the way past. The centre crop below is a
  // different thing: a declared, measured zoom on artwork already square.
  throw new Error(`artwork is ${source.width}x${source.height} — crop it square first`);
}

// The badge sits low in the illustration; the character's hand is the
// nearest thing above it that also happens to be outlined in the same
// green, so the search starts below where the hand ends. Measured against
// this artwork's 1254px source — re-measure if the source resolution or the
// pose changes.
const BADGE_SEARCH_Y = 740;
paintBlack(source, findBadgeOutline(source, BADGE_SEARCH_Y));
paintBlack(source, findOuterFrame(source));

const art = centreCrop(source, ZOOM, VERTICAL_SHIFT);
console.log(`source ${sourcePath}  ${source.width}x${source.height}  zoom ${ZOOM} -> ${art.width}x${art.width}`);

mkdirSync(OUT, { recursive: true });
for (const { file, size, scale } of ICONS) {
  const bytes = png(size, render(art, size, scale, PAD));
  writeFileSync(join(OUT, file), bytes);
  console.log(`${file.padEnd(24)} ${size}x${size}  ${(bytes.length / 1024).toFixed(1)} kB`);
}

const svg = favicon(art);
writeFileSync(join(OUT, 'favicon.svg'), svg);
console.log(`${'favicon.svg'.padEnd(24)} 64x64    ${(svg.length / 1024).toFixed(1)} kB`);

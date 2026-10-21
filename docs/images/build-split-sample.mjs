// Builds the landing-page "before / after" split render from the two sample
// exports that already exist in the repo.
//
//   node docs/images/build-split-sample.mjs
//
// Why this exists as code and not as a screenshot:
//   * The app's own split view carries UI chrome — ORIGINAL / CUTOUT tags and a
//     drag handle. Screenshotting it looks like a screenshot.
//   * A screenshot is also unreproducible: change the model and nobody can tell
//     which sample produced it.
// This composes the two existing exports directly, so the graphic is derived,
// byte-reproducible, and carries no app chrome.
//
// The labels are deliberately NOT baked in. Rasterised text at this size looks
// like pixel art, and real type renders better, stays selectable and stays
// accessible — so index.html overlays them in HTML using the app's own styling.
//
// No dependencies: PNG decode and encode are ~150 lines on top of zlib, which
// beats pulling an image library into a repo that ships zero runtime deps.

import { deflateSync, inflateSync } from 'node:zlib';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_PUBLIC = join(HERE, '../../packages/app/public');

// The app's own checkerboard and accent, so the render reads as native rather
// than pasted in. Values copied from index.html.
const CHECKER_A = [0x20, 0x26, 0x2d]; // #20262d
const CHECKER_B = [0x17, 0x1c, 0x21]; // #171c21
const CHECKER_PX = 16;
const ACCENT = [0x34, 0xd3, 0x99]; // #34d399

// Rendered at 1000px: the hero displays it at ~640px, so this is still
// comfortable on a high-DPI screen while keeping the payload sane. The pair it
// replaces (sample-before.png + sample-after.png) weighed 3.3MB.
const OUT_WIDTH = 1000;

// ---------- PNG ----------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode a non-interlaced 8-bit PNG (colour type 2 = RGB, 6 = RGBA). */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`unsupported bit depth ${data[8]}`);
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`unsupported colour type ${colorType} (need 2 or 6)`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const line = raw.subarray(src, src + stride);
    src += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      cur[i] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encode 8-bit RGBA with per-scanline adaptive filtering.
 *
 *  Filter 0 everywhere is simpler and, on a photographic composite, roughly
 *  15-25% larger — which on this image is the difference between a hero that
 *  weighs 2.3MB and one that weighs under 2. Chooses per row by the standard
 *  minimum-sum-of-absolute-differences heuristic. */
function encodePNG(width, height, rgba) {
  const bpp = 4;
  const stride = width * bpp;
  const raw = Buffer.alloc(height * (stride + 1));
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < height; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null;
    let best = 0, bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = cand[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = prev ? prev[i] : 0;
        const c = prev && i >= bpp ? prev[i - bpp] : 0;
        let v;
        if (f === 0) v = row[i];
        else if (f === 1) v = row[i] - a;
        else if (f === 2) v = row[i] - b;
        else if (f === 3) v = row[i] - ((a + b) >> 1);
        else v = row[i] - paeth(a, b, c);
        out[i] = v & 0xff;
        // Signed magnitude, as the PNG spec's heuristic defines it.
        score += out[i] < 128 ? out[i] : 256 - out[i];
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    raw[y * (stride + 1)] = best;
    cand[best].copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- compose ----------

function checkerAt(x, y) {
  return (Math.floor(x / CHECKER_PX) + Math.floor(y / CHECKER_PX)) % 2 === 0 ? CHECKER_A : CHECKER_B;
}

function main() {
  const before = decodePNG(readFileSync(join(HERE, 'sample-before.png')));
  const after = decodePNG(readFileSync(join(HERE, 'sample-after.png')));
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(`source sizes differ: ${before.width}x${before.height} vs ${after.width}x${after.height}`);
  }
  if (before.channels !== 3) throw new Error('sample-before.png must be RGB (no alpha)');
  if (after.channels !== 4) throw new Error('sample-after.png must be RGBA (it is a cutout)');
  console.log(`sources ${before.width}x${before.height}, cutout has alpha`);

  const W = before.width, H = before.height;
  const mid = Math.floor(W / 2);

  // Compose at native resolution first: the cutout is alpha-weighted over the
  // checkerboard, so doing it after any resampling would resample the checker
  // edge and the subject edge together and soften both.
  const full = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (x < mid) {
        const s = (y * W + x) * 3;
        full[o] = before.data[s];
        full[o + 1] = before.data[s + 1];
        full[o + 2] = before.data[s + 2];
        full[o + 3] = 255;
      } else {
        const s = (y * W + x) * 4;
        const a = after.data[s + 3] / 255;
        const [br, bg, bb] = checkerAt(x, y);
        full[o] = Math.round(after.data[s] * a + br * (1 - a));
        full[o + 1] = Math.round(after.data[s + 1] * a + bg * (1 - a));
        full[o + 2] = Math.round(after.data[s + 2] * a + bb * (1 - a));
        full[o + 3] = 255;
      }
    }
  }

  // Box-filter downscale. Averaging in 8-bit accumulates error over a wide box,
  // so accumulate in 16-bit — a visible difference on fur at this scale.
  const scale = OUT_WIDTH / W;
  const ow = OUT_WIDTH;
  const oh = Math.round(H * scale);
  const small = Buffer.alloc(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    const y0 = Math.floor(y / scale), y1 = Math.min(H, Math.max(y0 + 1, Math.floor((y + 1) / scale)));
    for (let x = 0; x < ow; x++) {
      const x0 = Math.floor(x / scale), x1 = Math.min(W, Math.max(x0 + 1, Math.floor((x + 1) / scale)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const s = (yy * W + xx) * 4;
          r += full[s]; g += full[s + 1]; b += full[s + 2]; n++;
        }
      }
      const o = (y * ow + x) * 4;
      small[o] = Math.round(r / n);
      small[o + 1] = Math.round(g / n);
      small[o + 2] = Math.round(b / n);
      small[o + 3] = 255;
    }
  }

  // Divider last, at final scale, so it stays exactly the width it claims to be
  // instead of being resampled into a 2.2px smear.
  const dmid = Math.floor(ow / 2);
  for (let y = 0; y < oh; y++) {
    for (let d = 0; d < 2; d++) {
      const o = (y * ow + dmid + d) * 4;
      small[o] = ACCENT[0]; small[o + 1] = ACCENT[1]; small[o + 2] = ACCENT[2];
    }
  }

  const png = encodePNG(ow, oh, small);
  writeFileSync(join(HERE, 'sample-split.png'), png);
  copyFileSync(join(HERE, 'sample-split.png'), join(APP_PUBLIC, 'sample-split.png'));
  console.log(`wrote sample-split.png — ${ow}x${oh}, ${(png.length / 1024).toFixed(0)} KB`);
  console.log(`copied to packages/app/public/sample-split.png`);
}

main();
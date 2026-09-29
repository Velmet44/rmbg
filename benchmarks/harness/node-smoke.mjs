// Node-side smoke gate: proves the real weights load and segment, timed,
// without any browser. Used when the available machine can't produce timely
// in-browser numbers (weak CPU, no GPU, slow model CDN).
//
// Input is a synthetic salient circle (no decoder needed). This validates
// session build + full inference + mask extraction — not edge quality
// (that needs real fixtures on adequate hardware).
//
// Usage: node node-smoke.mjs <model.onnx> [outdir]
// Writes: mask PNG (pure-JS encoder, no deps) + timings JSON to stdout.

import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import ort from 'onnxruntime-node';

const root = dirname(fileURLToPath(import.meta.url));
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
const modelPath = process.argv[2];
const outDir = process.argv[3] || join(root, 'results', 'node-smoke');
if (!modelPath) { console.error('usage: node node-smoke.mjs <model.onnx> [outdir]'); process.exit(1); }
await mkdir(outDir, { recursive: true });

const W = Number(process.argv[4] || 1024), H = Number(process.argv[4] || 1024);
const R = 0.29 * Math.min(W, H); // scale-invariant salient circle; truth fg = PI*0.29^2 ~= 0.264
// Synthetic salient object: bright circle on dark gradient + noise specks.
const rgb = new Uint8ClampedArray(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - W / 2, y - H / 2);
    const inCircle = d < R ? 1 : 0;
    const v = Math.round(30 + (x / W) * 40);
    const i = (y * W + x) * 3;
    rgb[i] = inCircle ? 235 : v;
    rgb[i + 1] = inCircle ? 120 : v + 10;
    rgb[i + 2] = inCircle ? 60 : v + 20;
  }
}
// BiRefNet-style preprocess: normalize with ImageNet mean/std, NCHW float32.
const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
const input = new Float32Array(3 * H * W);
for (let i = 0; i < W * H; i++) {
  for (let c = 0; c < 3; c++) input[c * W * H + i] = (rgb[i * 3 + c] / 255 - mean[c]) / std[c];
}

let t = performance.now();
const session = await ort.InferenceSession.create(modelPath, {
  executionProviders: ['cpu'],
  graphOptimizationLevel: 'all',
});
const sessionMs = performance.now() - t;
console.log(`session build: ${(sessionMs / 1000).toFixed(1)}s (inputs: ${session.inputNames.join(',')})`);

const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, H, W]) };
t = performance.now();
const out = await session.run(feeds);
const inferMs = performance.now() - t;
const firstKey = Object.keys(out)[0];
const o = out[firstKey];
console.log(`inference: ${(inferMs / 1000).toFixed(1)}s (output ${firstKey} dims ${o.dims})`);

// Squeeze to HxW, min-max normalize to 0..255.
const data = o.data;
const n = o.dims[o.dims.length - 2] * o.dims[o.dims.length - 1];
const plane = data.slice(data.length - n);
let mn = Infinity, mx = -Infinity;
for (const v of plane) { if (v < mn) mn = v; if (v > mx) mx = v; }
const gray = new Uint8Array(n);
for (let i = 0; i < n; i++) gray[i] = Math.round(((plane[i] - mn) / Math.max(1e-6, mx - mn)) * 255);
// Foreground fraction: how much of the mask is "object" (>127)?
let fg = 0;
for (const v of gray) if (v > 127) fg++;
console.log(`foreground fraction: ${(fg / n).toFixed(3)} (circle truth ~0.264)`);

await writeFile(join(outDir, 'timings.json'), JSON.stringify({
  model: modelPath.split(/[\\/]/).pop(), sessionMs: Math.round(sessionMs), inferMs: Math.round(inferMs),
  outputDims: o.dims, fgFraction: fg / n, at: new Date().toISOString(),
}, null, 2));
await writeFile(join(outDir, 'mask.png'), encodeGrayPng(gray, o.dims[o.dims.length - 1], o.dims[o.dims.length - 2]));
console.log('wrote ' + outDir);

/** Minimal grayscale PNG encoder (no dependencies). */
function encodeGrayPng(px, w, h) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    Buffer.from(px.subarray(y * w, (y + 1) * w)).copy(raw, y * (w + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0; // 8-bit grayscale
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
void createReadStream;

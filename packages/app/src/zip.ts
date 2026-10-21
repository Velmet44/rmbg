// Minimal stored (uncompressed) ZIP writer: one single-file download instead
// of N blocked popups, zero dependencies.
//
// Extracted from main.ts so the benchmark runner measures the shipped writer.

const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(d: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < d.length; i++) c = CRC_T[(c ^ d[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export interface ZipEntry { name: string; data: Uint8Array }

export function zipStore(files: ZipEntry[], when: Date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const push = (p: Uint8Array) => { chunks.push(p); total += p.length; };
  const h16 = (v: number) => new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]);
  const h32 = (v: number) => new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);
  const dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | ((when.getSeconds() / 2) | 0);
  const dosDate = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const central: Uint8Array[] = [];
  let cenTotal = 0;
  const cpush = (p: Uint8Array) => { central.push(p); cenTotal += p.length; };
  let off = 0;
  for (const f of files) {
    const nb = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = new Uint8Array(30 + nb.length);
    const dv = new DataView(head.buffer);
    dv.setUint32(0, 0x04034B50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, dosTime, true);
    dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, f.data.length, true);
    dv.setUint32(22, f.data.length, true);
    dv.setUint16(26, nb.length, true);
    dv.setUint16(28, 0, true);
    head.set(nb, 30);
    push(head);
    push(f.data);
    cpush(new Uint8Array([
      ...h32(0x02014B50), ...h16(20), ...h16(20), ...h16(0x0800), ...h16(0),
      ...h16(dosTime), ...h16(dosDate), ...h32(crc), ...h32(f.data.length), ...h32(f.data.length),
      ...h16(nb.length), ...h16(0), ...h16(0), ...h16(0), ...h16(0), ...h32(0), ...h32(off),
    ]));
    cpush(nb);
    off += head.length + f.data.length;
  }
  const cenOff = off;
  for (const c of central) push(c);
  push(new Uint8Array([
    ...h32(0x06054B50), ...h16(0), ...h16(0), ...h16(files.length), ...h16(files.length),
    ...h32(cenTotal), ...h32(cenOff), ...h16(0),
  ]));
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
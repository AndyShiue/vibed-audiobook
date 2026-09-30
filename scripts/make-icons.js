// Generates the PWA icons (PNG) without any image library: a glowing disc with a sound-wave glyph.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const SS = 3;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const p = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
        r += p[0]; g += p[1]; b += p[2]; a += p[3];
      }
      const o = y * (size * 4 + 1) + 1 + x * 4, n = SS * SS;
      raw[o] = r / n; raw[o + 1] = g / n; raw[o + 2] = b / n; raw[o + 3] = a / n;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const capsuleDist = (px, py, cx, cy, halfH, r) => { const dy = Math.max(0, Math.abs(py - cy) - halfH); return Math.hypot(px - cx, dy) - r; };

function pixel(u, v) {
  // background: deep navy with a soft top glow
  const bgTop = [30, 38, 72], bgBot = [11, 13, 18];
  let col = mix(bgTop, bgBot, Math.min(1, Math.hypot(u - 0.5, (v - 0.15) * 1.1) * 1.3));
  // disc
  const d = Math.hypot(u - 0.5, v - 0.5);
  const R = 0.31;
  const glow = Math.exp(-Math.max(0, d - R) * 14) * 0.5;
  col = mix(col, [108, 140, 255], glow);
  if (d < R) col = mix([125, 152, 255], [165, 108, 255], Math.min(1, (u + v) / 2 + (d / R) * 0.2));
  // sound-wave bars
  const bars = [0.07, 0.15, 0.24, 0.15, 0.07];
  for (let i = 0; i < 5; i++) {
    const cx = 0.5 + (i - 2) * 0.072;
    if (capsuleDist(u, v, cx, 0.5, bars[i] / 2, 0.02) < 0) col = [255, 255, 255];
  }
  return [col[0], col[1], col[2], 255];
}

for (const size of [192, 512]) fs.writeFileSync(path.join(out, `icon-${size}.png`), png(size, pixel));
fs.writeFileSync(path.join(out, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<defs><radialGradient id="b" cx=".5" cy=".1" r=".9"><stop offset="0" stop-color="#1e2648"/><stop offset="1" stop-color="#0b0d12"/></radialGradient>
<linearGradient id="d" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7d98ff"/><stop offset="1" stop-color="#a56cff"/></linearGradient></defs>
<rect width="100" height="100" rx="22" fill="url(#b)"/><circle cx="50" cy="50" r="31" fill="url(#d)"/>
<g fill="#fff"><rect x="36" y="46.5" width="4" height="7" rx="2"/><rect x="43.2" y="42.5" width="4" height="15" rx="2"/><rect x="50.4" y="38" width="4" height="24" rx="2"/><rect x="57.6" y="42.5" width="4" height="15" rx="2"/><rect x="64.8" y="46.5" width="4" height="7" rx="2"/></g></svg>`);
console.log('icons written to', out);

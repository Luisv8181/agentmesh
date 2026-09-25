// Generates the extension's PNG icons (blue rounded tile, white three-node mesh). Run: node extension/make-icons.mjs
import { writeFileSync } from 'fs';
import { deflateSync } from 'zlib';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function icon(size) {
  const s = size / 32; // design on a 32-unit grid, supersampled for smooth edges
  const SS = 4;
  const nodes = [[10, 11], [22, 11], [16, 22]];
  const edges = [[0, 1], [1, 2], [2, 0]];
  const inRoundRect = (x, y) => {
    const r = 8, w = 32;
    const cx = Math.min(Math.max(x, r), w - r), cy = Math.min(Math.max(y, r), w - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const distToSeg = (px, py, [ax, ay], [bx, by]) => {
    const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
  };
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const u = (x + (sx + 0.5) / SS) / s, v = (y + (sy + 0.5) / SS) / s;
        if (!inRoundRect(u, v)) continue;
        bg++;
        const onNode = nodes.some(([nx, ny]) => Math.hypot(u - nx, v - ny) <= 3.2);
        const onEdge = edges.some(([a, b]) => distToSeg(u, v, nodes[a], nodes[b]) <= 0.9);
        if (onNode || onEdge) fg++;
      }
      const n = SS * SS, a = bg / n, f = bg ? fg / bg : 0;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = Math.round(37 + (255 - 37) * f);
      raw[o + 1] = Math.round(99 + (255 - 99) * f);
      raw[o + 2] = Math.round(235 + (255 - 235) * f);
      raw[o + 3] = Math.round(255 * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [16, 32, 48, 128]) writeFileSync(new URL(`./icon-${size}.png`, import.meta.url), icon(size));
console.log('icons written');

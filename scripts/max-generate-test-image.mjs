import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const outputPath = path.resolve(process.argv[2] || process.env.MAX_TEST_IMAGE_PATH || 'generated/max-test-post.png');
const width = 640;
const height = 360;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const raw = Buffer.alloc((width * 3 + 1) * height);
for (let y = 0; y < height; y += 1) {
  const rowOffset = y * (width * 3 + 1);
  raw[rowOffset] = 0;
  for (let x = 0; x < width; x += 1) {
    const offset = rowOffset + 1 + x * 3;
    const band = ((Math.floor(x / 80) + Math.floor(y / 60)) % 2) * 22;
    raw[offset] = Math.min(255, 42 + Math.round((x / width) * 90) + band);
    raw[offset + 1] = Math.min(255, 120 + Math.round((y / height) * 65) + band);
    raw[offset + 2] = Math.max(0, 245 - Math.round((x / width) * 45) - band);
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8;
ihdr[9] = 2;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND'),
]);

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, png, { mode: 0o600 });
console.log(`MAX_TEST_IMAGE_CREATED=${outputPath} bytes=${png.length} dimensions=${width}x${height}`);

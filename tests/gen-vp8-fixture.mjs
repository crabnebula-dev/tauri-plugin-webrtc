// Generates tests/fixtures/vp8-160x120.bin: 30 VP8 frames from Chromium WebCodecs.
// Format: repeated [u8 key][u32 LE length][bytes].
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
const srv = http.createServer((_, r) => r.end('<!doctype html>ok')).listen(0, '127.0.0.1');
await new Promise((r) => srv.on('listening', r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${srv.address().port}/`);
const frames = await page.evaluate(async () => {
  const c = new OffscreenCanvas(160, 120), x = c.getContext('2d'); const out = [];
  const enc = new VideoEncoder({ output: (ch) => { const b = new Uint8Array(ch.byteLength); ch.copyTo(b); out.push([ch.type === 'key' ? 1 : 0, Array.from(b)]); }, error: (e) => { throw e; } });
  enc.configure({ codec: 'vp8', width: 160, height: 120, bitrate: 200000, framerate: 15, latencyMode: 'realtime' });
  for (let i = 0; i < 30; i++) {
    x.fillStyle = `hsl(${i * 12},70%,50%)`; x.fillRect(0, 0, 160, 120); x.fillStyle = '#fff'; x.fillRect(i * 4, 50, 20, 20);
    const f = new VideoFrame(c, { timestamp: i * 66666 }); enc.encode(f, { keyFrame: i === 0 }); f.close();
  }
  await enc.flush(); return out;
});
await browser.close();
srv.close();
const parts = [];
for (const [key, bytes] of frames) { const h = Buffer.alloc(5); h[0] = key; h.writeUInt32LE(bytes.length, 1); parts.push(h, Buffer.from(bytes)); }
writeFileSync('../crates/engine/tests/fixtures/vp8-160x120.bin', Buffer.concat(parts));
console.log('frames', frames.length, 'keys', frames.filter((f) => f[0]).length, 'bytes', frames.reduce((a, f) => a + f[1].length, 0));

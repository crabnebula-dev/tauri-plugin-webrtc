// Chrome (libopus via WebCodecs) <-> rusty-opus interop.
// Reads rust-opus.bin (Rust-encoded) and source.f32; writes chrome-opus.bin and chrome-decoded.f32.
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
const dir = process.argv[2];
const srv = http.createServer((_, r) => r.end('<!doctype html>ok')).listen(0, '127.0.0.1');
await new Promise((r) => srv.on('listening', r));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${srv.address().port}/`);
const rust = readFileSync(`${dir}/rust-opus.bin`);
const pkts = []; for (let p = 0; p < rust.length;) { const n = rust.readUInt32LE(p); pkts.push(Array.from(rust.subarray(p + 4, p + 4 + n))); p += 4 + n; }
const src = Array.from(new Float32Array(readFileSync(`${dir}/source.f32`).buffer.slice(0)));
const out = await page.evaluate(async ({ pkts, src }) => {
  // 1. Chrome decodes Rust packets.
  const dec = []; const d = new AudioDecoder({ output: (a) => { const b = new Float32Array(a.numberOfFrames); a.copyTo(b, { planeIndex: 0 }); dec.push(...b); a.close(); }, error: (e) => { throw e; } });
  d.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
  pkts.forEach((p, i) => d.decode(new EncodedAudioChunk({ type: 'key', timestamp: i * 20000, data: new Uint8Array(p) })));
  await d.flush();
  // 2. Chrome encodes the source.
  const enc = []; const e = new AudioEncoder({ output: (c) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); enc.push(Array.from(b)); }, error: (x) => { throw x; } });
  e.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 32000, opus: { frameDuration: 20000, application: 'voip' } });
  for (let i = 0; i + 960 <= src.length; i += 960) {
    e.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: 960, numberOfChannels: 1, timestamp: (i / 48) * 1000, data: new Float32Array(src.slice(i, i + 960)) }));
  }
  await e.flush();
  return { dec, enc };
}, { pkts, src });
await browser.close(); srv.close();
writeFileSync(`${dir}/chrome-decoded.f32`, Buffer.from(new Float32Array(out.dec).buffer));
writeFileSync(`${dir}/chrome-opus.bin`, Buffer.concat(out.enc.flatMap((p) => { const h = Buffer.alloc(4); h.writeUInt32LE(p.length); return [h, Buffer.from(p)]; })));
console.log('chrome decoded samples', out.dec.length, 'chrome packets', out.enc.length);

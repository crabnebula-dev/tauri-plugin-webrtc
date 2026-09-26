// Bundles matrix-js-sdk for the e2e pages: node matrix/build.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(here, 'entry.js')],
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true,
  outfile: path.join(here, '../../examples/e2e-app/dist/mx/matrix.js'),
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  logLevel: 'warning',
});
console.log('built');

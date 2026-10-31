/**
 * Bundle the Obsidian plugin into dist/obsidian-plugin/main.js and copy manifest.json next to it
 * (npm run build:obsidian, part of npm run build). Obsidian loads main.js as CommonJS inside
 * Electron and provides `obsidian` itself. The bundle may use only the pure src/domain/vault
 * modules: never the server, the client, or render.ts (the server's renderer).
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(APP_ROOT, 'dist/obsidian-plugin');

const FORBIDDEN = /(^|\/)src\/(server|client|mcp|shared)\/|(^|\/)src\/domain\/vault\/render\.ts$/;

const r = await build({
  entryPoints: [path.join(HERE, 'src/main.ts')],
  absWorkingDir: APP_ROOT,
  outfile: path.join(OUT_DIR, 'main.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2021',
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});
const bad = Object.keys(r.metafile.inputs).filter((f) => FORBIDDEN.test(f));
if (bad.length) {
  console.error(`The Obsidian plugin must not import: ${bad.join(', ')}`);
  process.exit(1);
}
fs.copyFileSync(path.join(HERE, 'manifest.json'), path.join(OUT_DIR, 'manifest.json'));
console.log(`built ${path.relative(process.cwd(), OUT_DIR) || OUT_DIR}`);

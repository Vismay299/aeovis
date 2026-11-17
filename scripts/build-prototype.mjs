/**
 * Builds the self-contained Perceev prototype.
 *
 * Artifacts run under a strict CSP that blocks every external host, so the
 * webfonts cannot be linked — they have to travel inside the file. This reads
 * the repo's own variable fonts and swaps them into the source's placeholders
 * as base64 data URIs.
 *
 *   node scripts/build-prototype.mjs
 *   docs/design/options/prototype.src.html  ->  docs/design/options/perceev-prototype.html
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SRC = join(root, 'docs', 'design', 'options', 'prototype.src.html');
const OUT = join(root, 'docs', 'design', 'options', 'perceev-prototype.html');

const FONTS = {
  __ARCHIVO_B64__: join(root, 'src', 'app', 'fonts', 'Archivo-VF.woff2'),
  __MONO_B64__: join(root, 'src', 'app', 'fonts', 'SplineSansMono-VF.woff2'),
};

let html = await readFile(SRC, 'utf8');

for (const [token, path] of Object.entries(FONTS)) {
  if (!html.includes(token)) throw new Error(`source is missing placeholder ${token}`);
  const b64 = (await readFile(path)).toString('base64');
  html = html.replaceAll(token, b64);
  console.log(`  ${token.padEnd(16)} -> ${(b64.length / 1024).toFixed(0)} KB base64`);
}

// A leftover placeholder would ship a broken font silently.
const leftover = html.match(/__[A-Z0-9_]+__/g);
if (leftover) throw new Error(`unreplaced placeholders: ${[...new Set(leftover)].join(', ')}`);

await writeFile(OUT, html, 'utf8');
console.log(`\n  built ${OUT}`);
console.log(`  ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB (artifact limit 16 MB)`);

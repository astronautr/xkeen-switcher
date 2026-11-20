// Keep the build's private allowlist separate from the public PWA manifest.
import { readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = new URL('../dist/', import.meta.url);
const digest = data => createHash('sha256').update(data).digest('hex');
const renames = [];
for (const file of await readdir(new URL('ui-assets/', root))) {
  const data = await readFile(new URL(`ui-assets/${file}`, root));
  const target = file.replace(/\.[a-f0-9]{16}\./, `.${digest(data).slice(0, 16)}.`);
  if (file !== target) await rename(new URL(`ui-assets/${file}`, root), new URL(`ui-assets/${target}`, root));
  renames.push([file, target]);
}
for (const name of ['index.html', 'catalog.html']) {
  let html = await readFile(new URL(name, root), 'utf8');
  for (const [before, after] of renames) html = html.replaceAll(before, after);
  await writeFile(new URL(name, root), html);
}
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const assets = {};
async function collect(directory = '') {
  for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
    const file = directory + entry.name;
    if (entry.isDirectory()) { await collect(file + '/'); continue; }
    const type = mime[path.extname(file)];
    if (!type) throw new Error(`Unexpected public build output: ${file}`);
    const data = await readFile(new URL(file, root));
    assets['/' + file] = { file, mime: type, sha256: digest(data) };
  }
}
await collect();
await writeFile(new URL('asset-manifest.json', root), JSON.stringify({ version: 1,
  entries: { app: '/index.html', catalog: '/catalog.html' }, assets }, null, 2) + '\n');

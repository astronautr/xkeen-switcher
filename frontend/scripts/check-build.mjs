import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../dist/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('asset-manifest.json', root), 'utf8'));
assert.deepEqual(manifest.entries, { app: '/index.html', catalog: '/catalog.html' });
for (const [url, record] of Object.entries(manifest.assets)) {
  const bytes = await readFile(new URL(record.file, root));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256);
  assert(!url.endsWith('.map') && !url.includes('node_modules'));
  if (url.startsWith('/ui-assets/')) assert.match(url, /\.[a-f0-9]{16}\.(js|css|svg|png)$/);
}
for (const entry of Object.values(manifest.entries)) {
  const html = await readFile(new URL(entry.slice(1), root), 'utf8');
  const boot = html.indexOf('<script src="/theme-boot.js"></script>');
  const stylesheet = html.indexOf('<link href="/ui-assets/');
  assert(boot >= 0 && boot < stylesheet, `Theme boot must run before compiled styles in ${entry}`);
  assert(!/https?:|\/app\.js|\/ui\.js|\/dom-patch\.js|\/routing\.js|\/devices\.js/.test(html));
  for (const match of html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)) assert(manifest.assets[match[1]], `Unlisted HTML dependency ${match[1]}`);
}
assert.equal(JSON.parse(await readFile(new URL('manifest.webmanifest', root), 'utf8')).start_url, '/');
console.log(`Build manifest verified: ${Object.keys(manifest.assets).length} public files, isolated app/catalog entries`);

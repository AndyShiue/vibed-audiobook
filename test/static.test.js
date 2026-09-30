import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test('service worker precache list matches the files that exist', () => {
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  const listed = [...sw.matchAll(/'(\/[^']*)'/g)].map((m) => m[1]).filter((u) => u !== '/' && !u.startsWith('/api'));
  for (const u of listed) assert.ok(fs.existsSync(path.join(PUBLIC, u)), `sw.js lists ${u} but it does not exist`);
  const appFiles = walk(path.join(PUBLIC, 'js')).map((f) => '/' + path.relative(PUBLIC, f).replaceAll('\\', '/'));
  for (const f of appFiles) assert.ok(listed.includes(f), `${f} is missing from the sw.js precache list (offline use would break)`);
});

test('every relative import in the browser code resolves to a file', () => {
  for (const file of walk(path.join(PUBLIC, 'js'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), m[1])), `${path.relative(PUBLIC, file)} imports missing ${m[1]}`);
    }
  }
});

test('index.html references only existing local assets and every id used by app.js exists', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  for (const m of html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)) assert.ok(fs.existsSync(path.join(PUBLIC, m[1])), `index.html references missing ${m[1]}`);
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const app = fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8');
  for (const m of app.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.has(m[1]), `app.js uses #${m[1]} which is not in index.html`);
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(PUBLIC, icon.src)), `manifest icon ${icon.src} missing`);
});

test('vendored libraries are present', () => {
  for (const f of ['jszip.min.js', 'mammoth.browser.min.js', 'pdfjs/pdf.min.mjs', 'pdfjs/pdf.worker.min.mjs', 'pdfjs/cmaps/UniCNS-UCS2-H.bcmap', 'pdfjs/standard_fonts']) {
    assert.ok(fs.existsSync(path.join(PUBLIC, 'vendor', f)), `public/vendor/${f} missing — run "npm install"`);
  }
});

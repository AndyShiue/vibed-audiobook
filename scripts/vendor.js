// Copies the browser-side libraries out of node_modules into public/vendor so the
// PWA is fully self-contained (works offline, no CDN dependency).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const out = (...p) => path.join(root, 'public', 'vendor', ...p);

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name), d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

try {
  copy(nm('jszip', 'dist', 'jszip.min.js'), out('jszip.min.js'));
  copy(nm('mammoth', 'mammoth.browser.min.js'), out('mammoth.browser.min.js'));
  copy(nm('pdfjs-dist', 'build', 'pdf.min.mjs'), out('pdfjs', 'pdf.min.mjs'));
  copy(nm('pdfjs-dist', 'build', 'pdf.worker.min.mjs'), out('pdfjs', 'pdf.worker.min.mjs'));
  copy(nm('shake.js', 'shake.js'), out('shake.js')); // "shake the phone to ask" (MIT, Alex Gibson)
  copyDir(nm('pdfjs-dist', 'cmaps'), out('pdfjs', 'cmaps'));
  copyDir(nm('pdfjs-dist', 'standard_fonts'), out('pdfjs', 'standard_fonts'));
  console.log('vendor: copied jszip, mammoth, shake.js, pdf.js (+cmaps, fonts) to public/vendor');
} catch (err) {
  console.error('vendor: copy failed —', err.message);
  console.error('Run "npm install" first.');
  process.exitCode = 1;
}

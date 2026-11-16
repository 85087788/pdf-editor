// Copies pdf.js cMaps and standard fonts into public/ so CJK / non-embedded-font
// PDFs render correctly, served from the same origin (no CDN, no tracking).
import { cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = join(dirname(require.resolve('pdfjs-dist/build/pdf.mjs')), '..');
for (const dir of ['cmaps', 'standard_fonts']) {
  const dest = join('public', 'pdfjs', dir);
  if (!existsSync(dest)) cpSync(join(root, dir), dest, { recursive: true });
}

import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { StaticCanvas } from 'fabric';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const BASE = import.meta.env.BASE_URL;

// crypto.randomUUID only exists in secure contexts (https / localhost). The dev
// server listens on 0.0.0.0, so opening it via a LAN IP over http would crash.
export const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** Open a PDF with pdf.js. cMaps + standard fonts are served locally so CJK and
 *  non-embedded-font PDFs render correctly without any third-party request. */
export function openPdfJs(bytes) {
  return pdfjsLib.getDocument({
    data: bytes.slice(), // pdf.js transfers (detaches) the buffer it receives
    cMapUrl: `${BASE}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${BASE}pdfjs/standard_fonts/`,
    isEvalSupported: false,
  }).promise;
}

/** Total rotation (intrinsic /Rotate + user rotation), normalised to 0/90/180/270. */
export const totalRotation = (p) => (((p.baseRotation + p.rotation) % 360) + 360) % 360;

/** Page size as displayed (after rotation), in PDF points. */
export const viewSize = (p) =>
  totalRotation(p) % 180 ? { w: p.baseH, h: p.baseW } : { w: p.baseW, h: p.baseH };

// Thumbnails / renders share one queue so a 300-page document doesn't flood the main thread.
let queue = Promise.resolve();
export function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/**
 * Build the output PDF.
 * @param pages   pages in output order
 * @param sources Map<srcId, {bytes}>
 */
export async function buildPdf(pages, sources) {
  // pdf-lib is only needed for export: load it on demand to keep the first load small.
  const { PDFDocument, degrees } = await import('pdf-lib');
  const output = await PDFDocument.create();

  // Copy all pages of one source in a single copyPages() call so shared
  // resources (fonts, images) are copied once instead of once per page.
  const bySource = new Map();
  pages.forEach((p, i) => {
    if (!bySource.has(p.srcId)) bySource.set(p.srcId, []);
    bySource.get(p.srcId).push(i);
  });
  const copied = new Array(pages.length);
  for (const [srcId, idxs] of bySource) {
    let src;
    try {
      src = await PDFDocument.load(sources.get(srcId).bytes);
    } catch (e) {
      if (/encrypt/i.test(e.message)) throw new Error('This PDF is encrypted/protected and cannot be re-saved.');
      throw e;
    }
    const result = await output.copyPages(src, idxs.map((i) => pages[i].sourcePage - 1));
    idxs.forEach((i, k) => (copied[i] = result[k]));
  }

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const dest = output.addPage(copied[i]);
    const R = totalRotation(p);
    dest.setRotation(degrees(R));
    if (p.overlay?.objects?.length) await drawOverlay(output, dest, p, R, degrees);
  }
  return output.save();
}

/** Render the Fabric annotations (stored in displayed-page coordinates) to a
 *  transparent PNG and place it so it lines up after the page's rotation. */
async function drawOverlay(output, dest, p, R, degrees) {
  const { w, h } = viewSize(p);
  const el = document.createElement('canvas');
  const sc = new StaticCanvas(el, { width: w, height: h, enableRetinaScaling: false });
  await sc.loadFromJSON(p.overlay);
  sc.backgroundColor = '';
  sc.renderAll();
  const png = await output.embedPng(sc.toDataURL({ format: 'png', multiplier: 3 }));
  sc.dispose();

  const { x: x0, y: y0, width: W, height: H } = dest.getCropBox();
  // pdf-lib rotates counter-clockwise around (x, y); viewers rotate pages clockwise.
  const place = {
    0: { x: x0, y: y0, rotate: 0 },
    90: { x: x0 + W, y: y0, rotate: 90 },
    180: { x: x0 + W, y: y0 + H, rotate: 180 },
    270: { x: x0, y: y0 + H, rotate: 270 },
  }[R];
  const sx = (R % 180 ? H : W) / w; // guards against crop/media box mismatch
  const sy = (R % 180 ? W : H) / h;
  dest.drawImage(png, { x: place.x, y: place.y, width: w * sx, height: h * sy, rotate: degrees(place.rotate) });
}

export function downloadBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const A4 = { w: 595.28, h: 841.89 };
const MAX_IMAGE_PX = 4000;

/**
 * Convert images to a PDF: one A4 page per image, orientation matching the
 * image, image centred and scaled to fit with a small margin.
 * Images go through createImageBitmap so phone-photo EXIF orientation is
 * respected; JPEGs stay JPEG, PNG/WebP become PNG (keeps transparency).
 */
export async function imagesToPdf(files, { margin = 18 } = {}) {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (const file of files) {
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      throw new Error(`cannot read image "${file.name}".`);
    }
    const k = Math.min(1, MAX_IMAGE_PX / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const jpeg = /jpe?g/.test(file.type);
    const blob = await new Promise((r) => c.toBlob(r, jpeg ? 'image/jpeg' : 'image/png', 0.92));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const img = jpeg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);

    const landscape = c.width > c.height;
    const pw = landscape ? A4.h : A4.w;
    const ph = landscape ? A4.w : A4.h;
    const s = Math.min((pw - margin * 2) / c.width, (ph - margin * 2) / c.height);
    const w = c.width * s;
    const h = c.height * s;
    doc.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return doc.save();
}

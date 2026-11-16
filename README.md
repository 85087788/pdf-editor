# Free Online PDF Editor

A free, browser-based PDF editor built with React, Vite, PDF.js, Fabric.js, and pdf-lib.

## Features
- Open and preview PDFs
- Add text, rectangles, lines, freehand drawings (sign by hand), images, and image-based signatures
- Move, resize, recolor, and delete annotations (multi-select supported)
- Undo / redo (Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z), Delete key, PageUp / PageDown
- Page thumbnails, zoom 25–300 % and fit-to-width
- Drag & drop a PDF to open (or merge), or an image to insert
- Rotate, duplicate, delete, and reorder pages
- Convert images (PNG, JPG, WebP) to PDF: one A4 page per image, auto portrait/landscape, phone-photo orientation respected
- Add PDFs or images as extra pages to an open document
- Append another PDF, export the complete document, or export one page
- Local browser processing, no server-side uploads

## Requirements
- Node.js 20.19+ or 22.12+
- npm

## Local development
```bash
npm install
npm run dev
```
Open the URL shown in the terminal (normally http://localhost:5173).

`npm run dev` / `npm run build` first copy pdf.js cMaps and standard fonts into `public/pdfjs/`
(needed for Chinese/Japanese/Korean PDFs and PDFs without embedded fonts). They are served from
your own site, not a CDN.

## Build
```bash
npm run build
npm run preview
```

## Deploy on Vercel
1. Push this project to a GitHub repository.
2. In Vercel, select **Add New → Project** and import the repository.
3. Framework: **Vite**; build command: `npm run build`; output directory: `dist`.
4. Deploy. Each push to the configured branch triggers a new build.

## Limitations
- Existing PDF text is not directly editable. Add new text as an annotation instead.
- Signatures are inserted as image files (PNG recommended with transparency), not cryptographic digital signatures.
- No OCR, password-protected PDF support, form-field editing, or cloud collaboration.
- Undo history keeps the last 40 steps and is cleared when a new PDF is opened.
- Annotations are flattened into the exported PDF and are not separately editable after export.
- Large PDFs can consume significant browser memory.

## Privacy
Files are processed in browser memory. This app has no backend or analytics code. The hosting provider may still collect ordinary site access logs.

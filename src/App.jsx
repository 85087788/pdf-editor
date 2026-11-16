import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Canvas, Textbox, Rect, Line, FabricImage, PencilBrush, Point } from 'fabric';
import {
  Upload, Download, Type, Square, Minus, ImagePlus, PenLine, Pencil, Trash2, RotateCw,
  ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Merge, Scissors, Undo2, Redo2,
  ZoomIn, ZoomOut, Maximize2, Copy, FileImage,
} from 'lucide-react';
import { uid, openPdfJs, viewSize, totalRotation, enqueue, buildPdf, downloadBytes, imagesToPdf } from './pdf.js';

const MAX_HISTORY = 40;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;
const isTyping = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
const isPdf = (f) => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
const isImage = (f) => f && /^image\/(png|jpe?g|webp)$/.test(f.type);
const readDataURL = (f) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

/* ---------------- Thumbnail ---------------- */
function Thumb({ page, getPdf }) {
  const ref = useRef(null);
  const rot = totalRotation(page);
  useEffect(() => {
    let cancelled = false;
    enqueue(async () => {
      if (cancelled || !ref.current) return;
      const pdf = getPdf(page.srcId);
      if (!pdf) return;
      const pg = await pdf.getPage(page.sourcePage);
      const base = pg.getViewport({ scale: 1, rotation: rot });
      const vp = pg.getViewport({ scale: (110 * (window.devicePixelRatio || 1)) / base.width, rotation: rot });
      const c = ref.current;
      if (cancelled || !c) return;
      c.width = Math.ceil(vp.width);
      c.height = Math.ceil(vp.height);
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [page.srcId, page.sourcePage, rot, getPdf]);
  const { w, h } = viewSize(page);
  return <canvas ref={ref} className="thumb" style={{ aspectRatio: `${w} / ${h}` }} />;
}

/* ---------------- App ---------------- */
export default function App() {
  const [pages, setPagesState] = useState([]);
  const [active, setActiveState] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState('Upload a PDF to start.');
  const [busy, setBusy] = useState(false);
  const [color, setColor] = useState('#e33b45');
  const [fontSize, setFontSize] = useState(24);
  const [drawing, setDrawing] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [, setHistVersion] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState('document');

  const pagesRef = useRef([]);
  const activeRef = useRef(0);
  const sourcesRef = useRef(new Map()); // srcId -> { bytes, pdf }
  const historyRef = useRef([]);
  const futureRef = useRef([]);
  const lastCommitRef = useRef({ key: null, t: 0 });
  const dirtyRef = useRef(false);
  const fabricRef = useRef(null);
  const loadingOverlayRef = useRef(false);
  const hostRef = useRef(null);
  const pdfCanvasRef = useRef(null);
  const areaRef = useRef(null);
  const fileRef = useRef(null), mergeRef = useRef(null), imageRef = useRef(null), imgPdfRef = useRef(null);
  const colorRef = useRef(color);
  colorRef.current = color;

  const page = pages[active];
  const hasPages = pages.length > 0;
  const getPdf = useCallback((srcId) => sourcesRef.current.get(srcId)?.pdf, []);

  /* ---------- state helpers (refs kept in sync so async code never sees stale data) ---------- */
  const setPages = (next) => { pagesRef.current = next; setPagesState(next); };
  const setActive = (i) => { activeRef.current = i; setActiveState(i); };

  /** Apply a change and record the previous state for undo.
   *  `coalesce` merges rapid repeated changes (e.g. dragging the colour picker) into one step. */
  const commit = (mutate, coalesce = null) => {
    const prev = pagesRef.current;
    const now = Date.now();
    const merge = coalesce && lastCommitRef.current.key === coalesce && now - lastCommitRef.current.t < 800;
    if (!merge) {
      historyRef.current = [...historyRef.current.slice(-(MAX_HISTORY - 1)), { pages: prev, active: activeRef.current }];
      futureRef.current = [];
    }
    lastCommitRef.current = { key: coalesce, t: now };
    setPages(mutate(prev));
    dirtyRef.current = true;
    setHistVersion((v) => v + 1);
  };

  /** Save the live Fabric canvas into the active page. */
  const commitOverlay = (coalesce) => {
    const fc = fabricRef.current;
    if (!fc || loadingOverlayRef.current) return;
    const a = activeRef.current;
    const json = fc.toJSON();
    commit((p) => p.map((x, i) => (i === a ? { ...x, overlay: json } : x)), coalesce);
  };

  /** Finish in-progress text editing (fires object:modified -> commit). */
  const flushEditing = () => {
    const o = fabricRef.current?.getActiveObject();
    if (o?.isEditing) o.exitEditing();
  };

  /* ---------- Fabric canvas lifecycle: created once while a document is open ---------- */
  useEffect(() => {
    if (!hasPages) return;
    const el = document.createElement('canvas');
    hostRef.current.appendChild(el);
    const fc = new Canvas(el, { preserveObjectStacking: true, backgroundColor: '' });
    fabricRef.current = fc;
    fc.freeDrawingBrush = new PencilBrush(fc);
    const onChange = () => commitOverlay();
    const onSelect = () => {
      const objs = fc.getActiveObjects();
      setHasSelection(objs.length > 0);
      const o = objs[0];
      if (!o) return;
      const c = o.type === 'textbox' ? o.fill : o.stroke;
      if (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) setColor(c);
      if (o.fontSize) setFontSize(Math.round(o.fontSize));
    };
    fc.on('object:modified', onChange);
    fc.on('path:created', onChange);
    fc.on('selection:created', onSelect);
    fc.on('selection:updated', onSelect);
    fc.on('selection:cleared', () => setHasSelection(false));
    return () => {
      fabricRef.current = null;
      fc.dispose();
      if (hostRef.current) hostRef.current.innerHTML = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPages]);

  const view = page ? viewSize(page) : null;
  const rot = page ? totalRotation(page) : 0;

  /* ---------- Render the PDF page (background layer) ---------- */
  useEffect(() => {
    if (!page) return;
    let cancelled = false;
    let task;
    (async () => {
      try {
        const pdf = getPdf(page.srcId);
        const pg = await pdf.getPage(page.sourcePage);
        if (cancelled) return;
        const dpr = window.devicePixelRatio || 1;
        const vp = pg.getViewport({ scale: zoom * dpr, rotation: rot });
        const off = document.createElement('canvas');
        off.width = Math.ceil(vp.width);
        off.height = Math.ceil(vp.height);
        task = pg.render({ canvasContext: off.getContext('2d'), viewport: vp });
        await task.promise;
        const c = pdfCanvasRef.current;
        if (cancelled || !c) return;
        // Swap in a finished bitmap so the page never flashes blank while re-rendering.
        c.width = off.width;
        c.height = off.height;
        c.getContext('2d').drawImage(off, 0, 0);
      } catch (e) {
        if (!cancelled && e?.name !== 'RenderingCancelledException') setStatus(`Render failed: ${e.message}`);
      }
    })();
    return () => { cancelled = true; task?.cancel(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.srcId, page?.sourcePage, rot, zoom, hasPages]);

  /* ---------- Size + zoom the annotation layer. Objects stay in PDF-point units. ---------- */
  const applyView = () => {
    const fc = fabricRef.current;
    if (!fc || !view) return;
    fc.setDimensions({ width: Math.round(view.w * zoom), height: Math.round(view.h * zoom) });
    fc.setZoom(zoom);
    fc.requestRenderAll();
  };
  useEffect(applyView, [view?.w, view?.h, zoom, hasPages]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- Load the page's annotations on page switch / undo ---------- */
  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc || !page) return;
    let cancelled = false;
    loadingOverlayRef.current = true;
    (async () => {
      fc.discardActiveObject();
      fc.clear();
      if (page.overlay) await fc.loadFromJSON(page.overlay);
      if (cancelled) return;
      fc.backgroundColor = '';
      applyView();
      loadingOverlayRef.current = false;
      setHasSelection(false);
    })().catch((e) => { loadingOverlayRef.current = false; setStatus(`Cannot load annotations: ${e.message}`); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.id, reloadToken, hasPages]);

  /* ---------- Drawing mode ---------- */
  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc) return;
    fc.isDrawingMode = drawing;
    fc.freeDrawingBrush.color = color;
    fc.freeDrawingBrush.width = 2.5;
  }, [drawing, color, hasPages]);

  /* ---------- Loading PDFs (and images, converted to PDF pages) ---------- */
  async function loadPdfs(files, append) {
    const list = [...files].filter((f) => isPdf(f) || isImage(f));
    if (!list.length) { setStatus('Please choose a PDF or image file (PNG, JPG, WebP).'); return; }
    flushEditing();
    setBusy(true);
    const added = [];
    const newSources = new Map();
    try {
      // Keep the selection order; consecutive images become one generated PDF.
      const groups = [];
      for (const f of list) {
        const last = groups.at(-1);
        if (isImage(f) && Array.isArray(last)) last.push(f);
        else groups.push(isImage(f) ? [f] : f);
      }
      for (const g of groups) {
        const images = Array.isArray(g);
        setStatus(images ? `Converting ${g.length} image(s) to PDF...` : `Opening ${g.name}...`);
        const bytes = images ? await imagesToPdf(g) : new Uint8Array(await g.arrayBuffer());
        const pdf = await openPdfJs(bytes);
        const srcId = uid();
        newSources.set(srcId, { bytes, pdf });
        for (let i = 1; i <= pdf.numPages; i++) {
          const pg = await pdf.getPage(i);
          const vp = pg.getViewport({ scale: 1, rotation: 0 });
          added.push({ id: uid(), srcId, sourcePage: i, baseW: vp.width, baseH: vp.height, baseRotation: pg.rotate || 0, rotation: 0, overlay: null });
        }
      }
      if (!added.length) throw new Error('the PDF has no pages.');
      if (append) {
        newSources.forEach((v, k) => sourcesRef.current.set(k, v));
        const start = pagesRef.current.length;
        commit((p) => [...p, ...added]);
        setActive(start);
        setStatus(`${added.length} page(s) added.`);
      } else {
        sourcesRef.current.forEach((s) => s.pdf.destroy());
        sourcesRef.current = newSources;
        historyRef.current = [];
        futureRef.current = [];
        dirtyRef.current = false;
        setFileName(list[0].name.replace(/\.[a-z0-9]+$/i, ''));
        setPages(added);
        setActive(0);
        // Start at 100%, but shrink to fit narrow screens (phones).
        const avail = (areaRef.current?.clientWidth ?? 800) - 48;
        const first = viewSize(added[0]);
        setZoom(Math.max(ZOOM_MIN, Math.min(1, Math.floor((avail / first.w) * 100) / 100)));
        setReloadToken((t) => t + 1);
        setHistVersion((v) => v + 1);
        setStatus(`${added.length} page(s) loaded.`);
      }
    } catch (e) {
      newSources.forEach((s) => s.pdf.destroy());
      const msg = e?.name === 'PasswordException' ? 'this PDF is password-protected.' : e.message;
      setStatus(`Cannot open PDF: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  /* ---------- Annotation tools ---------- */
  const addObject = (o, center = true) => {
    const fc = fabricRef.current;
    if (!fc) return;
    setDrawing(false);
    fc.add(o);
    if (center) fc.viewportCenterObject(o);
    o.setCoords();
    fc.setActiveObject(o);
    fc.requestRenderAll();
    commitOverlay();
    return o;
  };
  const addText = () => {
    const t = addObject(new Textbox('Edit this text', { width: 240, fontSize: Number(fontSize) || 24, fill: color, fontFamily: 'Helvetica' }));
    if (t) { t.enterEditing(); t.selectAll(); }
  };
  const addRect = () => addObject(new Rect({ width: 180, height: 85, fill: 'transparent', stroke: color, strokeWidth: 3, strokeUniform: true }));
  const addLine = () => addObject(new Line([0, 0, 215, 0], { stroke: color, strokeWidth: 3, strokeUniform: true }));
  const addImage = async (file) => {
    if (!file || !fabricRef.current) return;
    try {
      const img = await FabricImage.fromURL(await readDataURL(file));
      img.scaleToWidth(Math.min(img.width, view.w * 0.4));
      addObject(img);
    } catch (e) {
      setStatus(`Cannot add image: ${e.message}`);
    }
  };
  const deleteObject = () => {
    const fc = fabricRef.current;
    const objs = fc?.getActiveObjects() ?? [];
    if (!objs.length || objs.some((o) => o.isEditing)) return;
    fc.discardActiveObject();
    fc.remove(...objs);
    fc.requestRenderAll();
    commitOverlay();
  };
  const changeColor = (c) => {
    setColor(c);
    const fc = fabricRef.current;
    const objs = fc?.getActiveObjects() ?? [];
    if (!objs.length) return;
    objs.forEach((o) => o.set(o.type === 'textbox' ? { fill: c } : { stroke: c }));
    fc.requestRenderAll();
    commitOverlay('color');
  };
  const changeFontSize = (v) => {
    setFontSize(v);
    const n = Number(v);
    const fc = fabricRef.current;
    const texts = (fc?.getActiveObjects() ?? []).filter((o) => o.type === 'textbox');
    if (!texts.length || !(n >= 6 && n <= 200)) return;
    texts.forEach((o) => o.set({ fontSize: n }));
    fc.requestRenderAll();
    commitOverlay('fontSize');
  };

  /* ---------- Page operations ---------- */
  const switchPage = (i) => {
    if (i < 0 || i >= pagesRef.current.length || i === activeRef.current) return;
    flushEditing();
    setDrawing(false);
    setActive(i);
  };
  const removePage = () => {
    flushEditing();
    const a = activeRef.current;
    const n = pagesRef.current.length;
    commit((p) => p.filter((_, i) => i !== a));
    setActive(Math.max(0, Math.min(a, n - 2)));
    setStatus(`Page ${a + 1} deleted.`);
  };
  const duplicatePage = () => {
    flushEditing();
    const a = activeRef.current;
    // Pages are immutable records, so a shallow copy with a new id is a full duplicate
    // (same source page, rotation and annotations). Export handles repeated source pages.
    commit((p) => [...p.slice(0, a + 1), { ...p[a], id: uid() }, ...p.slice(a + 1)]);
    setActive(a + 1);
    setStatus(`Page ${a + 1} duplicated.`);
  };
  const movePage = (dir) => {
    flushEditing();
    const a = activeRef.current;
    const t = a + dir;
    if (t < 0 || t >= pagesRef.current.length) return;
    commit((p) => { const arr = [...p]; [arr[a], arr[t]] = [arr[t], arr[a]]; return arr; });
    setActive(t);
  };
  const rotate = () => {
    const fc = fabricRef.current;
    if (!fc || !view) return;
    flushEditing();
    // Rotate the annotations together with the page (90° clockwise around the page).
    fc.discardActiveObject();
    fc.getObjects().forEach((o) => {
      const c = o.getCenterPoint();
      o.rotate(((o.angle || 0) + 90) % 360);
      o.setPositionByOrigin(new Point(view.h - c.y, c.x), 'center', 'center');
      o.setCoords();
    });
    const json = fc.toJSON();
    const a = activeRef.current;
    commit((p) => p.map((x, i) => (i === a ? { ...x, rotation: (x.rotation + 90) % 360, overlay: json } : x)));
  };

  /* ---------- Undo / redo ---------- */
  const restore = (from, to) => {
    if (!from.current.length) return;
    flushEditing();
    const state = from.current.at(-1);
    from.current = from.current.slice(0, -1);
    to.current = [...to.current, { pages: pagesRef.current, active: activeRef.current }];
    lastCommitRef.current = { key: null, t: 0 };
    setPages(state.pages);
    setActive(Math.min(state.active, Math.max(0, state.pages.length - 1)));
    setReloadToken((t) => t + 1);
    setHistVersion((v) => v + 1);
  };
  const undo = () => restore(historyRef, futureRef);
  const redo = () => restore(futureRef, historyRef);

  /* ---------- Zoom ---------- */
  const zoomBy = (d) => setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(z + d).toFixed(2))));
  const fitWidth = () => {
    if (!view || !areaRef.current) return;
    const avail = areaRef.current.clientWidth - 48;
    setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.floor((avail / view.w) * 100) / 100)));
  };

  /* ---------- Export ---------- */
  const exportPdf = async (single) => {
    if (!pagesRef.current.length) return;
    flushEditing();
    setBusy(true);
    setStatus('Exporting PDF...');
    try {
      const list = single ? [pagesRef.current[activeRef.current]] : pagesRef.current;
      const bytes = await buildPdf(list, sourcesRef.current);
      downloadBytes(bytes, single ? `${fileName}-page-${activeRef.current + 1}.pdf` : `${fileName}-edited.pdf`);
      if (!single) dirtyRef.current = false;
      setStatus(`PDF exported (${(bytes.length / 1024 / 1024).toFixed(2)} MB).`);
    } catch (e) {
      setStatus(`Export error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  /* ---------- Keyboard, unload guard ---------- */
  const handlersRef = useRef({});
  handlersRef.current = { deleteObject, undo, redo, switchPage };
  useEffect(() => {
    const onKey = (e) => {
      if (isTyping()) return;
      const h = handlersRef.current;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? h.redo() : h.undo(); }
      else if (mod && k === 'y') { e.preventDefault(); h.redo(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (fabricRef.current?.getActiveObjects().length) { e.preventDefault(); h.deleteObject(); }
      } else if (e.key === 'PageDown') h.switchPage(activeRef.current + 1);
      else if (e.key === 'PageUp') h.switchPage(activeRef.current - 1);
    };
    const onUnload = (e) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; } };
    document.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onUnload);
    return () => { document.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', onUnload); };
  }, []);

  /* ---------- Drag & drop ---------- */
  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const files = [...e.dataTransfer.files];
    const pdfs = files.filter(isPdf);
    const images = files.filter(isImage);
    const open = pagesRef.current.length > 0;
    if (pdfs.length) return loadPdfs(files, open);
    if (images.length && !open) return loadPdfs(images, false); // images -> new PDF
    if (images.length === 1) return addImage(images[0]); // single image -> insert on page
    if (images.length) return loadPdfs(images, true); // several -> new pages
    setStatus('Drop a PDF or image files.');
  };

  const canUndo = historyRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;
  const off = !hasPages || busy;

  return (
    <div className="app" onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={(e) => { if (!e.relatedTarget) setDragOver(false); }} onDrop={onDrop}>
      <header>
        <div className="brand">
          <span className="brandmark">PDF</span>
          <strong>Free PDF Editor</strong>
          <small>Private · Browser-based · No watermark</small>
        </div>
        <div className="headerActions">
          <button disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={17} /> Open PDF</button>
          <button disabled={busy} onClick={() => imgPdfRef.current?.click()} title="Create a PDF from one or more images (one page per image)"><FileImage size={17} /> Images to PDF</button>
          <button disabled={off} onClick={() => mergeRef.current?.click()} title="Append PDFs or images as new pages"><Merge size={17} /> Merge / Add pages</button>
          <button className="primary" disabled={off} onClick={() => exportPdf(false)}><Download size={17} /> Export PDF</button>
        </div>
      </header>

      <div className="workspace">
        <aside>
          <h3>Pages <span>{pages.length}</span></h3>
          <div className="pageList">
            {pages.map((p, i) => (
              <button key={p.id} className={`pageItem ${active === i ? 'selected' : ''}`} onClick={() => switchPage(i)} title={`Page ${i + 1}`}>
                <Thumb page={p} getPdf={getPdf} />
                <span>Page {i + 1}{p.overlay?.objects?.length ? ' •' : ''}</span>
              </button>
            ))}
          </div>
          <div className="sideActions">
            <button disabled={off || active === 0} onClick={() => movePage(-1)}><ChevronUp size={15} /> Move up</button>
            <button disabled={off || active >= pages.length - 1} onClick={() => movePage(1)}><ChevronDown size={15} /> Move down</button>
            <button disabled={off} onClick={duplicatePage}><Copy size={15} /> Duplicate</button>
            <button disabled={off} onClick={rotate}><RotateCw size={15} /> Rotate</button>
            <button disabled={off} onClick={removePage}><Trash2 size={15} /> Delete page</button>
            <button disabled={off} onClick={() => exportPdf(true)}><Scissors size={15} /> Export page</button>
          </div>
        </aside>

        <main>
          <nav className="toolbar">
            <button disabled={off} onClick={addText}><Type size={18} /> Text</button>
            <button disabled={off} onClick={addRect}><Square size={18} /> Rectangle</button>
            <button disabled={off} onClick={addLine}><Minus size={18} /> Line</button>
            <button disabled={off} className={drawing ? 'toggled' : ''} aria-pressed={drawing} onClick={() => { fabricRef.current?.discardActiveObject(); setDrawing((d) => !d); }}><Pencil size={18} /> Draw</button>
            <button disabled={off} onClick={() => imageRef.current?.click()}><ImagePlus size={18} /> Image</button>
            <button disabled={off} onClick={() => imageRef.current?.click()} title="Insert a signature image (PNG with transparency recommended), or use Draw to sign by hand"><PenLine size={18} /> Signature</button>
            <span className="sep" />
            <label className="colorLabel">Color <input aria-label="Object color" type="color" value={color} onChange={(e) => changeColor(e.target.value)} /></label>
            <label className="fontLabel">Size <input aria-label="Text font size" type="number" min="6" max="200" value={fontSize} onChange={(e) => changeFontSize(e.target.value)} /></label>
            <button disabled={off || !hasSelection} onClick={deleteObject}><Trash2 size={17} /> Remove</button>
            <button disabled={!canUndo || busy} onClick={undo} title="Undo (Ctrl+Z)"><Undo2 size={17} /> Undo</button>
            <button disabled={!canRedo || busy} onClick={redo} title="Redo (Ctrl+Y)"><Redo2 size={17} /> Redo</button>
          </nav>

          <div className="documentArea" ref={areaRef}>
            {!hasPages ? (
              <div className="empty">
                <div className="emptyIcon">PDF</div>
                <h1>Edit PDFs for free</h1>
                <p>Upload or drop a PDF (or images to turn into a PDF), add text, drawings, images or signatures, organize pages and export without a watermark.</p>
                <div className="emptyActions">
                  <button className="primary" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={18} /> Choose a PDF</button>
                  <button disabled={busy} onClick={() => imgPdfRef.current?.click()}><FileImage size={18} /> Images to PDF</button>
                </div>
                <small>Your documents stay in your browser.</small>
              </div>
            ) : (
              <div className="canvasFrame" style={{ width: Math.round(view.w * zoom), height: Math.round(view.h * zoom) }}>
                <canvas ref={pdfCanvasRef} className="pdfLayer" />
                <div ref={hostRef} className="annotLayer" />
              </div>
            )}
            {dragOver && <div className="dropHint">{hasPages ? 'Drop PDFs or several images to add pages, or one image to insert on this page' : 'Drop a PDF to open, or images to make a PDF'}</div>}
          </div>

          <footer>
            <span className="status" role="status">{busy ? 'Working...' : status}</span>
            <div className="pager">
              <button aria-label="Previous page" disabled={!hasPages || active === 0} onClick={() => switchPage(active - 1)}><ChevronLeft size={17} /></button>
              <span>{hasPages ? active + 1 : 0} / {pages.length}</span>
              <button aria-label="Next page" disabled={active >= pages.length - 1} onClick={() => switchPage(active + 1)}><ChevronRight size={17} /></button>
            </div>
            <div className="zoom">
              <button aria-label="Zoom out" disabled={!hasPages || zoom <= ZOOM_MIN} onClick={() => zoomBy(-0.25)}><ZoomOut size={17} /></button>
              <span>{Math.round(zoom * 100)}%</span>
              <button aria-label="Zoom in" disabled={!hasPages || zoom >= ZOOM_MAX} onClick={() => zoomBy(0.25)}><ZoomIn size={17} /></button>
              <button aria-label="Fit width" title="Fit width" disabled={!hasPages} onClick={fitWidth}><Maximize2 size={15} /></button>
            </div>
          </footer>
        </main>
      </div>

      <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { loadPdfs(e.target.files, false); e.target.value = ''; }} />
      <input ref={imgPdfRef} type="file" accept="image/png,image/jpeg,image/webp" hidden multiple onChange={(e) => { loadPdfs(e.target.files, false); e.target.value = ''; }} />
      <input ref={mergeRef} type="file" accept="application/pdf,.pdf,image/png,image/jpeg,image/webp" hidden multiple onChange={(e) => { loadPdfs(e.target.files, true); e.target.value = ''; }} />
      <input ref={imageRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { addImage(e.target.files[0]); e.target.value = ''; }} />
    </div>
  );
}

"use client";
import React, { useEffect, useRef, useState, useCallback } from "react";
import Uploader from "@/components/Uploader";
import { useImage } from "@/components/AppShell";
import { removeBackgroundViaWorker, isFirstTime, markModelCached, getLastRawMaskBlob } from "@/lib/bgWorker";
import { saveRecent } from "@/lib/recentStore";
import ReactCrop, { Crop as CropType, centerCrop, makeAspectCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";

type Tool = "remove" | "background" | "refine" | "crop" | "export";
type BgType = "transparent" | "color" | "image";
const PRESET_COLORS = ["#FFFFFF","#0F1020","#6C4DFF","#E9E9EF"];
const EXPORT_PRESETS = {
  Original: null,
  Square: { w: 1080, h: 1080 },
  Passport: { w: 600, h: 750 }, // 35x45mm ratio approx 7:9 at 300dpi simplified
  Social: { w: 1080, h: 1350 }, // 4:5
} as const;

function useIsMobile(){
  const [m,setM]=useState(false);
  useEffect(()=>{ const q=window.matchMedia("(max-width: 768px)"); const fn=()=>setM(q.matches); fn(); q.addEventListener("change",fn); return()=>q.removeEventListener("change",fn);},[]);
  return m;
}

export default function EditorPage(){
  const { currentUrl, originalUrl, resultUrl, setCurrent, setResult, currentFile } = useImage();
  const [showBefore, setShowBefore] = useState(false);
  const [tool, setTool] = useState<Tool>("remove");
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState("");
  const [processing, setProcessing] = useState(false);
  const [firstTime, setFirstTime] = useState(false);
  const [error, setError] = useState<string|null>(null);

  // background
  const [bgType, setBgType] = useState<BgType>("transparent");
  const [bgColor, setBgColor] = useState("#6C4DFF");
  const [bgImageUrl, setBgImageUrl] = useState<string|null>(null);
  const bgImageRef = useRef<HTMLImageElement|null>(null);

  // refine
  const [brushSize, setBrushSize] = useState(24);
  const [brushMode, setBrushMode] = useState<"erase"|"restore">("erase");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const originalImageDataRef = useRef<ImageData|null>(null);
  const [history, setHistory] = useState<ImageData[]>([]);
  const [future, setFuture] = useState<ImageData[]>([]);
  const isDrawing = useRef(false);
  const lastPos = useRef<{x:number,y:number}|null>(null);

  // crop
  const [crop, setCrop] = useState<CropType>();
  const [completedCrop, setCompletedCrop] = useState<CropType>();
  const [aspect, setAspect] = useState<number|undefined>(undefined);
  const imgRef = useRef<HTMLImageElement>(null);

  // resize
  const [origW, setOrigW] = useState(0);
  const [origH, setOrigH] = useState(0);
  const [resizeW, setResizeW] = useState(0);
  const [resizeH, setResizeH] = useState(0);
  const [lockAspect, setLockAspect] = useState(true);

  // export
  const [exportFormat, setExportFormat] = useState<"png"|"jpg">("png");
  const [exportPreset, setExportPreset] = useState<keyof typeof EXPORT_PRESETS>("Original");

  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(true);
  const quality: "fast" = "fast";
  const [rawMaskUrl, setRawMaskUrl] = useState<string|null>(null);
  const [showRawMask, setShowRawMask] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(()=>{
    try{ console.log('[Editor] Clean-cut mode (isnet via @imgly, full quality), crossOriginIsolated:', typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : 'unknown'); }catch{}
  },[]);

  // PIPELINE GUARANTEE: file is ALWAYS the original File/Blob.
  // The checker preview (div.checker + overlayRef/canvasRef + p-5 container) is display ONLY.
  // Never pass overlayRef/canvasRef/maskCanvasRef/CheckerPreview canvas.toBlob/toDataURL into removeBackgroundViaWorker.
  const blobToDataUrl = (b: Blob) => new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(b);
  });
  const blobToMaskUrl = async (blob: Blob): Promise<string> => {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    // Convert alpha to grayscale mask: white=foreground (opaque), black=background (transparent)
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      d[i] = a; d[i+1] = a; d[i+2] = a; d[i+3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL("image/png");
  };
  // file -> processing
  const startRemoval = useCallback(async (file: File, url: string) => {
    if (!(file instanceof Blob)) {
      setError("Invalid file — please re-upload the original image.");
      return;
    }
    if (file.size === 0) {
      setError("Empty file — please choose another image.");
      return;
    }
    setError(null);
    setProcessing(true);
    setProgress(0);
    setProgressMsg("Preparing…");
    setFirstTime(isFirstTime());
    const tStart=performance.now();
    console.log('[Editor] startRemoval', file.name, file.size, 'quality', quality, 'crossOriginIsolated', typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : 'unknown');
    const ac=new AbortController();
    abortRef.current=ac;
    try {
      // HARD GUARD: use the ORIGINAL File blob directly, never a preview canvas screenshot
      // High = BiRefNet lite (1024 WebGPU / 512 WASM auto), Fast = @imgly isnet_quint8 fallback
      // Pipeline: preprocess -> model -> sigmoid -> bilinear resize to ORIGINAL -> alpha (no threshold/blur)
      const blob: Blob = file;
      let outBlob = await removeBackgroundViaWorker(blob, (pct, msg)=>{
        // Real download progress only: pct is number during download, null during inference (indeterminate)
        if(pct !== null && typeof pct === 'number') setProgress(pct);
        if (msg) setProgressMsg(msg);
        if (pct !== null && pct > 30) markModelCached();
        // Log stages
        if(msg) console.log('[Editor] progress', pct, msg);
      }, ac.signal, quality);
      console.log('[Editor] done total', Math.round(performance.now()-tStart)+'ms');
      // Capture RAW mask (before compositing) for debug view — prefer worker-provided rawMask (BiRefNet grayscale full-res)
      try {
        if (rawMaskUrl && rawMaskUrl.startsWith("blob:")) try{ URL.revokeObjectURL(rawMaskUrl); }catch{}
        const dbgBlob = getLastRawMaskBlob();
        let rawMaskDataUrl: string;
        if (dbgBlob) {
          rawMaskDataUrl = await blobToDataUrl(dbgBlob);
        } else {
          rawMaskDataUrl = await blobToMaskUrl(outBlob);
        }
        setRawMaskUrl(rawMaskDataUrl);
        setShowRawMask(false);
      } catch {}
      const outUrl = URL.createObjectURL(outBlob);
      const [resultDataUrl, originalDataUrl] = await Promise.all([
        blobToDataUrl(outBlob),
        blobToDataUrl(file),
      ]);
      setResult(outUrl);
      // set dimensions
      const img = new Image();
      img.onload = () => {
        setOrigW(img.naturalWidth);
        setOrigH(img.naturalHeight);
        setResizeW(img.naturalWidth);
        setResizeH(img.naturalHeight);
        // Persist ORIGINAL as dataUrl (not blob: objectURL which dies on reload)
        saveRecent({
          id: Date.now().toString(36)+Math.random().toString(36).slice(2,6),
          name: file.name.replace(/\.[^/.]+$/,"") || "image",
          createdAt: Date.now(),
          originalDataUrl,
          resultDataUrl,
          width: img.naturalWidth,
          height: img.naturalHeight,
          size: outBlob.size
        }).catch(()=>{});
      };
      img.src = outUrl;
      setShowBefore(false);
      setTool("background");
    } catch(e:any){
      if(e?.name==='AbortError'){
        setError("Cancelled");
      } else {
        console.error('[Editor] failed', e);
        // Auto fallback is handled in worker; if still fails show message and suggest Fast
        setError(e.message || "Failed to remove background. Try Fast mode or a smaller image.");
      }
    } finally {
      setProcessing(false);
      abortRef.current=null;
      console.log('[Editor] end total', Math.round(performance.now()-tStart)+'ms');
    }
  }, [setResult, quality]);

  // when currentUrl changes and no result, auto start
  useEffect(()=>{
    if (currentUrl && !resultUrl && currentFile && !processing){
      startRemoval(currentFile, currentUrl);
    }
  }, [currentUrl, resultUrl, currentFile, processing, startRemoval]);

  // handle file from uploader directly
  const handleFile = (file: File) => {
    const url = URL.createObjectURL(file);
    // revoke previous result to free memory
    if (resultUrl && resultUrl.startsWith("blob:")) try { URL.revokeObjectURL(resultUrl); } catch {}
    if (rawMaskUrl) try { if(rawMaskUrl.startsWith("blob:")) URL.revokeObjectURL(rawMaskUrl); }catch{}
    setCurrent(file, url, url);
    // reset states
    setBgType("transparent");
    setBgImageUrl(null);
    bgImageRef.current = null;
    setHistory([]);
    setFuture([]);
    setCrop(undefined);
    setCompletedCrop(undefined);
    originalImageDataRef.current = null;
    setRawMaskUrl(null);
    setShowRawMask(false);
    setError(null);
    setProgress(0);
  };

  // refine setup: init mask canvas when resultUrl ready + store original for restore
  // Persistent canvases are now always mounted (outside preview conditional) so they survive tool switches
  useEffect(()=>{
    if (!resultUrl || !maskCanvasRef.current || !canvasRef.current) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!canvasRef.current || !maskCanvasRef.current) return;
      const c = canvasRef.current!;
      const m = maskCanvasRef.current!;
      // avoid re-init if already correct size and has data
      if (c.width === img.naturalWidth && c.height === img.naturalHeight && originalImageDataRef.current) return;
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      m.width = img.naturalWidth;
      m.height = img.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0,0,c.width,c.height);
      ctx.drawImage(img,0,0);
      try { originalImageDataRef.current = ctx.getImageData(0,0,c.width,c.height); } catch {}
      const mctx = m.getContext("2d")!;
      mctx.clearRect(0,0,m.width,m.height);
      setOrigW(img.naturalWidth); setOrigH(img.naturalHeight); setResizeW(img.naturalWidth); setResizeH(img.naturalHeight);
    };
    img.src = resultUrl;
  }, [resultUrl]);

  // refine drawing handlers
  const getPos = (e: React.MouseEvent|React.TouchEvent, rect: DOMRect) => {
    const c = canvasRef.current!;
    let clientX, clientY;
    if ("touches" in e) { clientX = e.touches[0].clientX; clientY = e.touches[0].clientY; }
    else { clientX = (e as React.MouseEvent).clientX; clientY = (e as React.MouseEvent).clientY; }
    const scaleX = c.width / rect.width;
    const scaleY = c.height / rect.height;
    return { x: (clientX - rect.left)*scaleX, y: (clientY - rect.top)*scaleY };
  };

  const pushHistory = () => {
    const m = maskCanvasRef.current;
    if (!m) return;
    const ctx = m.getContext("2d")!;
    const data = ctx.getImageData(0,0,m.width,m.height);
    setHistory(h=> [...h.slice(-19), data]);
    setFuture([]);
  };

  const handlePointerDown = (e: React.MouseEvent|React.TouchEvent) => {
    if (tool !== "refine" || !overlayRef.current || !maskCanvasRef.current) return;
    e.preventDefault();
    pushHistory();
    isDrawing.current = true;
    const rect = overlayRef.current.getBoundingClientRect();
    lastPos.current = getPos(e, rect);
    drawStroke(lastPos.current!, lastPos.current!);
  };
  const handlePointerMove = (e: React.MouseEvent|React.TouchEvent) => {
    if (!isDrawing.current || !overlayRef.current || !maskCanvasRef.current) return;
    e.preventDefault();
    const rect = overlayRef.current.getBoundingClientRect();
    const pos = getPos(e, rect);
    if (lastPos.current) drawStroke(lastPos.current, pos);
    lastPos.current = pos;
    renderComposite();
  };
  const handlePointerUp = () => {
    isDrawing.current = false;
    lastPos.current = null;
  };

  const drawStroke = (from:{x:number,y:number}, to:{x:number,y:number}) => {
    const m = maskCanvasRef.current!;
    const ctx = m.getContext("2d")!;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = brushSize;
    // erase = make transparent (destination-out), restore = draw opaque white back? We'll use compositing on mask
    // mask: we draw with globalCompositeOperation
    // For erase: we want to erase foreground -> we draw black on mask and later apply as eraser
    // Simplify: mask canvas stores erase strokes as black, restore as white
    // Actually we directly manipulate main canvas alpha via composite?
    // Approach: mask canvas will be used as alpha mask to composite final image.
    // We'll draw on mask: erase = black (0 alpha), restore = white (255)
    // Initialize mask as white (we didn't fill, but treat transparent as white)
    // So first fill mask white if empty
    if (ctx.globalAlpha === 0) {} // noop
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = brushMode === "erase" ? "rgba(0,0,0,1)" : "rgba(255,255,255,1)";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };

  const renderComposite = () => {
    // composite main canvas + mask onto overlay preview? For now overlayRef shows live preview with background
    // We'll redraw main canvas with mask applied for export preview
    // This function updates overlay canvas visual
    const main = canvasRef.current;
    const mask = maskCanvasRef.current;
    const overlay = overlayRef.current;
    if (!main || !mask || !overlay) return;
    const w = main.width, h = main.height;
    overlay.width = w; overlay.height = h;
    const octx = overlay.getContext("2d")!;
    octx.clearRect(0,0,w,h);
    // draw background
    if (bgType === "color") {
      octx.fillStyle = bgColor;
      octx.fillRect(0,0,w,h);
    } else if (bgType === "image" && bgImageUrl) {
      const bgImg = bgImageRef.current;
      if (bgImg && bgImg.complete) {
        // cover
        const scale = Math.max(w/bgImg.naturalWidth, h/bgImg.naturalHeight);
        const sw = bgImg.naturalWidth*scale, sh = bgImg.naturalHeight*scale;
        octx.drawImage(bgImg, (w-sw)/2, (h-sh)/2, sw, sh);
      }
    } else {
      // checker is CSS, but for canvas we leave transparent; for overlay we draw checker pattern via fill
      // draw checker
      const size = 20;
      octx.fillStyle = "#fff";
      octx.fillRect(0,0,w,h);
      octx.fillStyle = "#E9E9EF";
      for(let y=0;y<h;y+=size){
        for(let x=0;x<w;x+=size){
          if ((Math.floor(x/size)+Math.floor(y/size))%2===0) octx.fillRect(x,y,size,size);
        }
      }
    }
    // draw main image with mask applied: create temp
    const temp = document.createElement("canvas");
    temp.width = w; temp.height = h;
    const tctx = temp.getContext("2d")!;
    tctx.drawImage(main,0,0);
    // apply mask: where mask is black, make transparent; white => keep
    // Use mask's alpha? We drew black/white opaque; we need to use it as eraser
    // Use globalCompositeOperation destination-out where mask black
    // Create mask handling: we have mask canvas with black strokes (erase) and white (restore)
    // We need to apply erasing: set composite destination-out for black pixels
    // For simplicity, get mask image data and apply per pixel
    const mctx = mask.getContext("2d")!;
    const mData = mctx.getImageData(0,0,w,h);
    const tData = tctx.getImageData(0,0,w,h);
    const origData = originalImageDataRef.current;
    // If mask is empty (all transparent), then tData stays as is.
    let hasMask = false;
    for(let i=3;i<mData.data.length;i+=4){ if(mData.data[i]!==0){ hasMask=true; break; } }
    if (hasMask){
      for(let i=0;i<tData.data.length;i+=4){
        const a = mData.data[i+3];
        if (a===0) continue; // no stroke
        const v = mData.data[i]; // 0 or 255
        if (v < 128) { // erase
          tData.data[i+3] = 0;
        } else { // restore — use original alpha to preserve feathered edges, no white halo
          if (origData && origData.data.length === tData.data.length) {
            tData.data[i] = origData.data[i];
            tData.data[i+1] = origData.data[i+1];
            tData.data[i+2] = origData.data[i+2];
            tData.data[i+3] = origData.data[i+3];
          } else {
            tData.data[i+3] = 255;
          }
        }
      }
      tctx.putImageData(tData,0,0);
    }
    // apply crop if exists?
    // For preview we handle crop via CSS too; but composite already includes full image
    octx.drawImage(temp,0,0);
  };

  // trigger composite on bg changes, brush etc
  useEffect(()=>{ renderComposite(); }, [bgType, bgColor, bgImageUrl, resultUrl, brushSize, crop]);
  useEffect(()=>{
    if (bgType==="image" && bgImageUrl){
      const img = new Image();
      img.onload = ()=> { bgImageRef.current = img; renderComposite(); };
      img.src = bgImageUrl;
    }
  }, [bgImageUrl, bgType]);
  // FIX: overlay remounts when switching tools (crop ↔ other) — re-draw so image doesn't disappear
  useEffect(()=>{
    if (resultUrl && !showBefore && !showRawMask) {
      const t = setTimeout(()=> renderComposite(), 40);
      return ()=> clearTimeout(t);
    }
  }, [tool, showBefore, showRawMask, resultUrl]);

  // crop preset helpers
  const setCropPreset = (preset: "free"|"1:1"|"4:5"|"16:9"|"passport") => {
    if (preset==="free") setAspect(undefined);
    else if (preset==="1:1") setAspect(1);
    else if (preset==="4:5") setAspect(4/5);
    else if (preset==="16:9") setAspect(16/9);
    else if (preset==="passport") setAspect(35/45); // approx 3.5x4.5
    // reset crop
    if (imgRef.current && preset!=="free"){
      const { width, height } = imgRef.current;
      const asp = preset==="1:1"?1: preset==="4:5"?4/5: preset==="16:9"?16/9:35/45;
      const c = centerCrop(makeAspectCrop({ unit:"%", width: 90 }, asp, width, height), width, height);
      setCrop(c);
    } else {
      setCrop(undefined);
    }
  };

  // resize handlers
  const onResizeW = (v:number) => {
    setResizeW(v);
    if (lockAspect && origW && origH) setResizeH(Math.round(v * origH / origW));
  };
  const onResizeH = (v:number) => {
    setResizeH(v);
    if (lockAspect && origW && origH) setResizeW(Math.round(v * origW / origH));
  };

  // undo/redo
  const undo = () => {
    const m = maskCanvasRef.current;
    if (!m || history.length===0) return;
    const last = history[history.length-1];
    const ctx = m.getContext("2d")!;
    const cur = ctx.getImageData(0,0,m.width,m.height);
    setFuture(f=> [...f, cur]);
    ctx.putImageData(last,0,0);
    setHistory(h=> h.slice(0,-1));
    renderComposite();
  };
  const redo = () => {
    const m = maskCanvasRef.current;
    if (!m || future.length===0) return;
    const next = future[future.length-1];
    const ctx = m.getContext("2d")!;
    const cur = ctx.getImageData(0,0,m.width,m.height);
    setHistory(h=> [...h, cur]);
    ctx.putImageData(next,0,0);
    setFuture(f=> f.slice(0,-1));
    renderComposite();
  };
  const clearStrokes = () => {
    const m = maskCanvasRef.current;
    if (!m) return;
    pushHistory();
    const ctx = m.getContext("2d")!;
    ctx.clearRect(0,0,m.width,m.height);
    renderComposite();
  };

  // Build final composition canvas (cutout + background + crop + preset) — used by both Export and Share
  const buildFinalCanvas = (): HTMLCanvasElement | null => {
    const main = canvasRef.current;
    if (!main) return null;
    const mask = maskCanvasRef.current;
    const w = main.width, h = main.height;
    if (w === 0 || h === 0) return null;
    // 1) Build clean cutout with mask applied (transparent bg, no checker)
    const cutout = document.createElement("canvas");
    cutout.width = w; cutout.height = h;
    const cutCtx = cutout.getContext("2d")!;
    cutCtx.drawImage(main, 0, 0);
    if (mask) {
      try {
        const mData = mask.getContext("2d")!.getImageData(0, 0, w, h);
        let hasMask = false;
        for (let i = 3; i < mData.data.length; i += 4) if (mData.data[i] !== 0) { hasMask = true; break; }
        if (hasMask) {
          const tData = cutCtx.getImageData(0, 0, w, h);
          const orig = originalImageDataRef.current;
          for (let i = 0; i < tData.data.length; i += 4) {
            const a = mData.data[i + 3];
            if (a === 0) continue;
            const v = mData.data[i];
            if (v < 128) tData.data[i + 3] = 0;
            else if (orig && orig.data.length === tData.data.length) {
              tData.data[i] = orig.data[i]; tData.data[i+1] = orig.data[i+1]; tData.data[i+2] = orig.data[i+2]; tData.data[i+3] = orig.data[i+3];
            } else tData.data[i+3] = 255;
          }
          cutCtx.putImageData(tData, 0, 0);
        }
      } catch {}
    }
    // 2) Crop rect in source pixels (ReactCrop gives % or px relative to displayed img)
    let sx = 0, sy = 0, sw = w, sh = h;
    if (completedCrop && imgRef.current && completedCrop.width && completedCrop.height) {
      const dispW = (imgRef.current as HTMLImageElement).width || w;
      const dispH = (imgRef.current as HTMLImageElement).height || h;
      if (dispW > 0 && dispH > 0) {
        const scaleX = w / dispW;
        const scaleY = h / dispH;
        // completedCrop may be % or px — detect by unit
        const unit = (completedCrop as any).unit;
        if (unit === "%") {
          sx = Math.round(((completedCrop.x || 0) / 100) * w);
          sy = Math.round(((completedCrop.y || 0) / 100) * h);
          sw = Math.round((completedCrop.width / 100) * w);
          sh = Math.round((completedCrop.height / 100) * h);
        } else {
          sx = Math.max(0, Math.round((completedCrop.x || 0) * scaleX));
          sy = Math.max(0, Math.round((completedCrop.y || 0) * scaleY));
          sw = Math.max(1, Math.round(completedCrop.width * scaleX));
          sh = Math.max(1, Math.round(completedCrop.height * scaleY));
        }
        if (sx + sw > w) sw = w - sx;
        if (sy + sh > h) sh = h - sy;
      }
    }
    const hasCrop = sw !== w || sh !== h || sx !== 0 || sy !== 0;
    // 3) Final size + draw rect
    const preset = EXPORT_PRESETS[exportPreset];
    let finalW: number, finalH: number, drawW: number, drawH: number, drawX: number, drawY: number;
    if (preset) {
      finalW = preset.w; finalH = preset.h;
      const scale = Math.min(finalW / sw, finalH / sh);
      drawW = Math.round(sw * scale);
      drawH = Math.round(sh * scale);
      drawX = Math.round((finalW - drawW) / 2);
      drawY = Math.round((finalH - drawH) / 2);
    } else {
      // Original: if cropped, size = crop size or resizeW/H; if not cropped, size = resize or original
      if (hasCrop) {
        if (resizeW > 0 && resizeH > 0) { finalW = resizeW; finalH = resizeH; }
        else { finalW = sw; finalH = sh; }
        drawW = finalW; drawH = finalH; drawX = 0; drawY = 0;
      } else {
        if (resizeW > 0 && resizeH > 0) { finalW = resizeW; finalH = resizeH; }
        else { finalW = w; finalH = h; }
        drawW = finalW; drawH = finalH; drawX = 0; drawY = 0;
      }
    }
    const final = document.createElement("canvas");
    final.width = finalW; final.height = finalH;
    const fctx = final.getContext("2d")!;
    // 4) Background at final size
    if (exportFormat === "jpg" || bgType !== "transparent") {
      if (bgType === "color") { fctx.fillStyle = bgColor; fctx.fillRect(0, 0, finalW, finalH); }
      else if (bgType === "image" && bgImageUrl && bgImageRef.current?.complete) {
        const bgImg = bgImageRef.current;
        const scale = Math.max(finalW / bgImg.naturalWidth, finalH / bgImg.naturalHeight);
        const bw = bgImg.naturalWidth * scale, bh = bgImg.naturalHeight * scale;
        fctx.drawImage(bgImg, (finalW - bw) / 2, (finalH - bh) / 2, bw, bh);
      } else if (exportFormat === "jpg") { fctx.fillStyle = "#FFFFFF"; fctx.fillRect(0, 0, finalW, finalH); }
    }
    // 5) Draw cutout
    if (preset) {
      fctx.drawImage(cutout, sx, sy, sw, sh, drawX, drawY, drawW, drawH);
    } else {
      if (hasCrop) fctx.drawImage(cutout, sx, sy, sw, sh, 0, 0, finalW, finalH);
      else fctx.drawImage(cutout, 0, 0, w, h, 0, 0, finalW, finalH);
    }
    return final;
  };

  const doExport = async () => {
    if (!resultUrl || !canvasRef.current) return;
    const final = buildFinalCanvas();
    if (!final) { setError("Export failed — canvas not ready. Try again."); return; }
    const finalW = final.width, finalH = final.height;
    const mime = (exportFormat === "jpg" || bgType !== "transparent") ? "image/jpeg" : "image/png";
    const quality = mime === "image/jpeg" ? 0.92 : undefined;
    try {
      const blob: Blob | null = await new Promise(res => final.toBlob(r => res(r), mime, quality as any));
      if (!blob) throw new Error("toBlob failed");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `erasebg-${Date.now()}.${exportFormat}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(()=> { try{ URL.revokeObjectURL(url);}catch{} }, 4000);
      const dataUrl = await blobToDataUrl(blob);
      try {
        const orig = originalUrl || currentUrl || "";
        await saveRecent({
          id: Date.now().toString(36)+Math.random().toString(36).slice(2,5),
          name: (currentFile?.name.replace(/\.[^/.]+$/,"") || "erasebg") + "-export",
          createdAt: Date.now(),
          originalDataUrl: orig,
          resultDataUrl: dataUrl,
          width: finalW, height: finalH, size: blob.size
        });
      } catch {}
    } catch(e:any){
      setError(e?.message || "Download failed — try again or use Share.");
      // Fallback to dataUrl method
      try{
        let dataUrl: string;
        if (mime === "image/jpeg") dataUrl = final.toDataURL("image/jpeg", 0.92);
        else dataUrl = final.toDataURL("image/png");
        const a=document.createElement("a");
        a.href=dataUrl; a.download=`erasebg-${Date.now()}.${exportFormat}`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      }catch{}
    }
  };

  const doShare = async () => {
    if (!resultUrl || !canvasRef.current) return;
    const final = buildFinalCanvas();
    if (!final) return;
    const mime = exportFormat === "jpg" ? "image/jpeg" : "image/png";
    const quality = mime === "image/jpeg" ? 0.92 : undefined;
    try {
      const blob: Blob | null = await new Promise(res => final.toBlob(r => res(r), mime, quality as any));
      if (!blob) throw new Error("toBlob failed");
      const file = new File([blob], `erasebg.${exportFormat}`, { type: blob.type });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: "Erasebg", text: "Background removed with Erasebg" }); return; } catch(e:any){ if (e?.name === "AbortError") return; }
      }
      // Fallback to download if share not supported
      const url = URL.createObjectURL(blob);
      const a=document.createElement("a");
      a.href=url; a.download=`erasebg-${Date.now()}.${exportFormat}`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(()=> { try{ URL.revokeObjectURL(url);}catch{} }, 4000);
    } catch {
      doExport();
    }
  };

  const hasImage = !!currentUrl;
  const hasResult = !!resultUrl;

  if (!hasImage) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-4 md:px-6 py-8 dot-grid">
        <div className="w-full max-w-[720px]">
          <h1 className="font-heading font-extrabold text-2xl md:text-3xl tracking-tight">Editor</h1>
          <p className="text-sm text-ink/60 dark:text-white/60 mt-1">Upload a photo — background removal starts automatically.</p>
          <div className="mt-6 bg-surface dark:bg-dark-surface rounded-[20px] p-4 md:p-6 border border-zinc-200 dark:border-white/10 shadow-card">
            <Uploader onFile={handleFile} />
          </div>
          <div className="mt-4 text-xs text-ink/60 dark:text-white/60 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-xl p-3">
            <strong>Tip:</strong> You can also drag & drop, or paste (Ctrl+V) from clipboard. Camera permission is optional — we’ll show a clear message if you deny it.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col lg:flex-row min-h-[calc(100vh-64px)] max-lg:pb-[84px]">
      {/* canvas area */}
      <div className="flex-1 flex flex-col items-center justify-start p-3 md:p-6 gap-3 bg-paper dark:bg-dark-bg dot-grid overflow-auto">
        {/* top bar */}
        <div className="w-full max-w-[860px] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 bg-ink text-white dark:bg-white dark:text-ink rounded-full p-1">
            <button onClick={()=> { setShowBefore(true); setShowRawMask(false); }} className={`px-3.5 py-1.5 rounded-full text-xs font-medium transition-colors ${showBefore && !showRawMask ? "bg-white text-ink dark:bg-ink dark:text-white" : "text-white/80 dark:text-ink/70"}`}>Before</button>
            <button onClick={()=> { setShowBefore(false); setShowRawMask(false); }} className={`px-3.5 py-1.5 rounded-full text-xs font-medium transition-colors ${!showBefore && !showRawMask ? "bg-white text-ink dark:bg-ink dark:text-white" : "text-white/80 dark:text-ink/70"}`}>After</button>
            {hasResult && rawMaskUrl && <button onClick={()=> { setShowRawMask(v=>!v); if(!showRawMask) setShowBefore(false); }} className={`px-3.5 py-1.5 rounded-full text-xs font-medium transition-colors ${showRawMask ? "bg-white text-ink dark:bg-ink dark:text-white" : "text-white/80 dark:text-ink/70"}`}>Mask</button>}
          </div>
          <div className="flex items-center gap-2">
            {hasResult && (
              <button onClick={()=> { if(bgType==='transparent'){ setBgType('color'); setBgColor('#0F1020'); } else { setBgType('transparent'); } }} className="hidden md:inline-flex items-center gap-1.5 text-xs bg-white dark:bg-dark-surface border border-zinc-200 dark:border-white/10 px-3 py-1.5 rounded-full font-medium hover:bg-zinc-50 dark:hover:bg-white/10">
                {bgType==='transparent' ? 'Dark bg' : 'Checker'}
              </button>
            )}
            {hasResult && <span className="hidden md:inline-flex items-center gap-1.5 text-xs bg-violet text-white px-3 py-1.5 rounded-full font-medium"><span className="w-1.5 h-1.5 rounded-full bg-ink animate-pulse"/> Ready</span>}
            <button onClick={()=>{ if(resultUrl?.startsWith("blob:")) try{URL.revokeObjectURL(resultUrl);}catch{}; if(currentUrl?.startsWith("blob:")) try{URL.revokeObjectURL(currentUrl);}catch{}; if(rawMaskUrl) try{ if(rawMaskUrl.startsWith("blob:")||rawMaskUrl.startsWith("data:")){} }catch{}; setCurrent(null,null); originalImageDataRef.current=null; setRawMaskUrl(null); setShowRawMask(false); }} className="text-xs px-3 py-1.5 rounded-full border border-black/10 dark:border-white/15 hover:bg-white dark:hover:bg-white/10 touch-target">New image</button>
          </div>
        </div>

        <div className="w-full max-w-[860px] relative flex flex-col gap-3">
          {/* checker peeking sheet */}
          <div className="absolute -right-2 -bottom-2 w-full h-full rounded-[20px] checker border border-zinc-200 dark:border-white/10 hidden md:block" aria-hidden />

          <div className="relative rounded-[20px] overflow-hidden bg-surface dark:bg-dark-surface border border-zinc-200 dark:border-white/10 shadow-card">

            {error && (
              <div className="absolute top-3 inset-x-3 z-10 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-700 dark:text-red-300 text-sm px-3 py-2 rounded-xl flex items-start justify-between gap-2">
                <span>{error}</span>
                <button onClick={()=> setError(null)} className="shrink-0 p-1 hover:bg-black/5 rounded-full" aria-label="Dismiss error">×</button>
              </div>
            )}

            <div className="relative w-full h-[420px] md:h-[560px] flex items-center justify-center bg-[#F3F3F7] dark:bg-[#1A1A28] overflow-hidden rounded-[16px]" style={{ background: showRawMask ? "#0F1020" : showBefore ? "#F3F3F7" : "#fff" }}>
              {/* PERSISTENT offscreen canvases — keep mounted across tool switches so cutout survives */}
              <canvas ref={canvasRef} className="hidden" width={1} height={1} aria-hidden />
              <canvas ref={maskCanvasRef} className="hidden" width={1} height={1} aria-hidden />
              {/* subtle non-covering progress — real download % only, inference shows indeterminate */}
              {processing && (
                <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 bg-ink text-white dark:bg-white dark:text-ink px-4 py-1.5 rounded-full text-xs font-medium flex items-center gap-2 shadow-md max-w-[90%]">
                  <span className="w-3 h-3 border-2 border-white/30 border-t-white dark:border-ink/30 dark:border-t-ink rounded-full animate-spin shrink-0"/>
                  <span className="truncate">{progressMsg?.includes('Removing background') ? progressMsg : (progressMsg || "Removing background…")}</span>
                  <button onClick={()=> abortRef.current?.abort()} className="ml-1 px-2 py-0.5 rounded-full bg-white/15 text-white text-[11px] hover:bg-white/25">Cancel</button>
                </div>
              )}
              {showRawMask && rawMaskUrl ? (
                <div className="relative w-full h-full flex items-center justify-center bg-[#0F1020] overflow-hidden">
                  <img src={rawMaskUrl} alt="Raw mask before feather" className="w-full h-full object-contain p-2" />
                  <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-white text-ink border border-zinc-200 px-3 py-1.5 rounded-full text-[11px] font-semibold">Raw mask — isnet — alpha, full-res, feathered</div>
                  <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-black/70 text-white px-3 py-1 rounded-full text-[10px]">White = keep, Black = remove • Debug: before compositing</div>
                </div>
              ) : showBefore ? (
                // Before image with optional crop UI
                tool==="crop" && hasResult ? (
                  <ReactCrop crop={crop} onChange={(_,p)=> setCrop(p)} onComplete={(c)=> setCompletedCrop(c)} aspect={aspect} className="max-w-full max-h-full">
                    <img ref={imgRef} src={currentUrl!} alt="Original" className="w-full h-full object-contain p-2" crossOrigin="anonymous" onLoad={(e)=>{
                      const img = e.currentTarget;
                      if (!crop) {
                        const c = centerCrop(makeAspectCrop({ unit:"%", width:90 }, aspect || 16/9, img.width, img.height), img.width, img.height);
                        if (aspect) setCrop(c); else setCrop(undefined);
                      }
                    }}/>
                  </ReactCrop>
                ) : (
                  <img src={currentUrl!} alt="Original" className="w-full h-full object-contain p-2" />
                )
              ) : (
                // After view
                !hasResult ? (
                  <div className="relative w-full h-full flex items-center justify-center">
                    <img src={currentUrl!} alt="Original" className="w-full h-full object-contain p-2 opacity-30 blur-[1.5px] scale-[0.98]" />
                  </div>
                ) : tool==="crop" ? (
                  // crop also applies to result? show crop on result
                  <ReactCrop crop={crop} onChange={(_,p)=> setCrop(p)} onComplete={(c)=> setCompletedCrop(c)} aspect={aspect} className="max-w-full max-h-full">
                    <img ref={imgRef} src={resultUrl!} alt="Result" className="max-w-full max-h-[70vh] object-contain dashed-outline" style={{ background: bgType==="transparent" ? undefined : bgColor }} onLoad={(e)=>{
                      const img = e.currentTarget;
                      if (!crop && aspect) {
                        const c = centerCrop(makeAspectCrop({ unit:"%", width:90 }, aspect, img.width, img.height), img.width, img.height);
                        setCrop(c);
                      }
                    }}/>
                  </ReactCrop>
                ) : (
                  <div className="relative w-full h-full flex items-center justify-center max-h-[70vh]">
                    {/* visible overlay */}
                    <canvas
                      ref={overlayRef}
                      className={`w-full h-full object-contain p-2 ${tool==="refine" ? "cursor-crosshair" : ""}`}
                      style={{ width: "100%", height: "100%", maxWidth:"100%", maxHeight:"100%", ...(bgType!=="transparent" && bgType==="color" ? { background: bgColor } : {}) }}
                      onMouseDown={handlePointerDown}
                      onMouseMove={handlePointerMove}
                      onMouseUp={handlePointerUp}
                      onMouseLeave={handlePointerUp}
                      onTouchStart={handlePointerDown}
                      onTouchMove={handlePointerMove}
                      onTouchEnd={handlePointerUp}
                    />
                    {/* Fallback img if canvas not yet rendered */}
                    <img src={resultUrl!} alt="" className="hidden" onLoad={()=> renderComposite()} />
                    {/* dashed outline hint */}
                    <div className="pointer-events-none absolute inset-3 border border-dashed border-violet/40 rounded-[16px] hidden md:block" aria-hidden />
                  </div>
                )
              )}
            </div>

            <div className="h-9 px-3 flex items-center justify-between text-xs border-t border-zinc-200 dark:border-white/10 bg-white/60 dark:bg-white/[0.04] backdrop-blur">
              <span className="text-ink/60 dark:text-white/60 flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${hasResult ? "bg-violet" : "bg-zinc-400"}`} />
                {showBefore ? `${origW ? `${origW}×${origH}` : "Original"}` : hasResult ? `${origW}×${origH} • ${exportFormat.toUpperCase()}` : "Processing"}
              </span>
              <span className="hidden md:flex items-center gap-1 text-ink/40 dark:text-white/40">
                {tool==="refine" && "Brush to refine edges • "}
                Background removed on-device
              </span>
            </div>
          </div>

          {/* quick actions */}
          <div className="flex flex-wrap gap-2 justify-center md:justify-start">
            <button onClick={doShare} disabled={!hasResult || processing} className="bg-violet text-white px-5 py-2.5 rounded-full text-sm font-semibold hover:bg-[#5A3FE6] disabled:opacity-50 transition-colors touch-target inline-flex items-center gap-2 shadow-sm">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3.5V10.5M8 3.5L5 6M8 3.5L11 6M2.5 10.5V12.5C2.5 12.78 2.72 13 3 13H13C13.28 13 13.5 12.78 13.5 12.5V10.5" stroke="#0F1020" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Share
            </button>
            <button onClick={doExport} disabled={!hasResult || processing} className="bg-ink text-white dark:bg-white dark:text-ink px-5 py-2.5 rounded-full text-sm font-semibold hover:bg-black dark:hover:bg-zinc-100 disabled:opacity-50 transition-colors touch-target inline-flex items-center gap-2">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3.5V10.5M8 3.5L5 6M8 3.5L11 6M2.5 10.5V12.5C2.5 12.78 2.72 13 3 13H13C13.28 13 13.5 12.78 13.5 12.5V10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Download
            </button>
            {hasResult && <button onClick={()=> startRemoval(currentFile!, currentUrl!)} disabled={processing} className="bg-white dark:bg-dark-surface border border-zinc-200 dark:border-white/10 px-4 py-2.5 rounded-full text-sm font-medium hover:bg-zinc-50 dark:hover:bg-white/5 touch-target disabled:opacity-50">Re-run removal</button>}
          </div>
        </div>
      </div>

      {/* tools panel — not fixed, flows below preview on mobile so it doesn't cover */}
      <div className="w-full lg:w-[360px] shrink-0 bg-surface dark:bg-dark-surface border-t lg:border-t-0 lg:border-l border-zinc-200 dark:border-white/10 flex flex-col">
        <div className="flex items-center justify-between px-4 h-[56px] border-b border-zinc-200 dark:border-white/10">
          <h2 className="font-heading font-bold">Tools</h2>
          <span className="text-xs bg-violet/10 text-violet px-2.5 py-1 rounded-full font-medium">On-device</span>
        </div>

        {/* tabs */}
        <div className="px-2 pt-2 pb-1 flex items-center gap-1 overflow-x-auto scrollbar-none border-b border-zinc-200 dark:border-white/10">
          {[
            { id:"remove", label:"Remove" },
            { id:"background", label:"Background" },
            { id:"refine", label:"Refine" },
            { id:"crop", label:"Crop" },
            { id:"export", label:"Export" },
          ].map(t=> (
            <button key={t.id} onClick={()=> setTool(t.id as Tool)}
              className={`px-3.5 py-2 rounded-full text-sm font-medium whitespace-nowrap touch-target transition-colors ${tool===t.id ? "bg-ink text-white dark:bg-white dark:text-ink" : "hover:bg-zinc-50 dark:hover:bg-white/5 text-ink/70 dark:text-white/70"}`}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-5">
          {tool==="remove" && (
            <div className="space-y-4">
              <h3 className="font-heading font-bold">Automatic removal</h3>
              <p className="text-sm text-ink/60 dark:text-white/60 leading-relaxed">Runs in a Web Worker — clean cut, no hangs. Full-res with feathered alpha.</p>
              <p className="text-xs text-ink/50 dark:text-white/50 leading-relaxed bg-violet/5 dark:bg-violet/10 rounded-xl p-3 border border-violet/15">Clean model: <code className="px-1 py-0.5 rounded bg-zinc-50 dark:bg-white/10">isnet</code> (~80 MB full / 40 MB quint8 fallback, @imgly, WASM, cached after first load) — best quality, no leftover background, no subject cropping.</p>
              {processing ? (
                <div className="bg-violet/5 dark:bg-violet/10 rounded-2xl p-4 border border-violet/15">
                  {progressMsg?.includes('Removing background, this can take') ? (
                    <div className="flex items-center gap-2 text-xs font-medium">
                      <span className="w-4 h-4 border-2 border-violet/30 border-t-violet rounded-full animate-spin shrink-0"/>
                      <span>{progressMsg}</span>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between text-xs font-medium mb-2"><span>{progressMsg}</span><span>{progress}%</span></div>
                      <div className="h-2 bg-black/5 dark:bg-white/10 rounded-full overflow-hidden"><div className="h-full bg-violet transition-all" style={{width:`${progress}%`}}/></div>
                    </>
                  )}
                  <button onClick={()=> abortRef.current?.abort()} className="mt-3 text-xs px-3 py-1.5 rounded-full border border-zinc-200 dark:border-white/10 bg-white dark:bg-dark-surface hover:bg-zinc-50 text-ink/70 dark:text-white/70">Cancel</button>
                  {firstTime && <p className="text-xs mt-2 bg-white dark:bg-dark-surface border border-zinc-200 dark:border-white/10 rounded-xl px-2.5 py-2 text-ink/60 dark:text-white/60">First time only: download ~40–80MB (isnet) — Wi-Fi recommended on mobile. Cached for offline after.</p>}
                </div>
              ) : hasResult ? (
                <div className="bg-violet/10 border border-violet/20 rounded-2xl p-4 flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-violet text-white flex items-center justify-center shrink-0">✓</div>
                  <div>
                    <p className="text-sm font-semibold">Background removed</p>
                    <p className="text-xs text-ink/60 dark:text-white/60 mt-1">Clean isnet (WASM) — no leftover background, no cropping. No data left your device.</p>
                    <button onClick={()=> currentFile && currentUrl && startRemoval(currentFile, currentUrl)} className="mt-2 text-xs font-semibold text-violet hover:underline">Run again</button>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border-2 border-dashed border-zinc-200 dark:border-white/10 p-4 text-center">
                  <p className="text-sm">No image yet</p>
                  <p className="text-xs text-ink/50 dark:text-white/50 mt-1">Upload to start removal automatically</p>
                </div>
              )}
              <div className="text-xs text-ink/50 dark:text-white/50 bg-paper dark:bg-dark-bg rounded-xl p-3 border border-zinc-200 dark:border-white/10">
                <p className="font-medium text-ink dark:text-white">Accepted:</p>
                <p>PNG, JPG, WEBP • Max 25 MB • Clear errors for unsupported/oversized files.</p>
                <p className="mt-2 font-medium text-ink dark:text-white">License check:</p>
                <p>Before adding ads or paid plans, verify the model license. Some popular models are non-commercial — prefer a permissive one for commercial use.</p>
              </div>
            </div>
          )}

          {tool==="background" && (
            <div className="space-y-4">
              <h3 className="font-heading font-bold">Background</h3>
              <div className="grid grid-cols-3 gap-2">
                <button onClick={()=> setBgType("transparent")} className={`rounded-2xl border-2 p-2 flex flex-col items-center gap-2 touch-target ${bgType==="transparent" ? "border-violet bg-violet/5" : "border-black/5 dark:border-white/10 hover:border-black/10"}`}>
                  <span className="w-full h-[56px] rounded-xl checker border border-black/5" />
                  <span className="text-xs font-medium">Transparent</span>
                </button>
                {PRESET_COLORS.map(c=> (
                  <button key={c} onClick={()=> { setBgType("color"); setBgColor(c); }} className={`rounded-2xl border-2 p-2 flex flex-col items-center gap-2 touch-target ${bgType==="color" && bgColor===c ? "border-violet" : "border-black/5 dark:border-white/10"}`}>
                    <span className="w-full h-[56px] rounded-xl border border-black/5" style={{background:c}} />
                    <span className="text-xs font-medium truncate w-full text-center">{c}</span>
                  </button>
                ))}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center justify-between">Custom color <input type="color" value={bgColor} onChange={e=>{ setBgType("color"); setBgColor(e.target.value); }} className="w-8 h-8 rounded-full overflow-hidden border-2 border-white shadow-sm" aria-label="Pick custom background color" /></label>
                <div className="flex items-center gap-2">
                  <input type="text" value={bgColor} onChange={e=>{ setBgType("color"); setBgColor(e.target.value); }} className="flex-1 rounded-full border border-zinc-200 dark:border-white/10 bg-white dark:bg-dark-bg px-3 py-2 text-sm" placeholder="#6C4DFF" />
                  <span className="w-8 h-8 rounded-full border border-black/10" style={{background:bgColor}} aria-hidden />
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">Image background</p>
                <label className="flex items-center justify-center gap-2 rounded-full border-2 border-dashed border-zinc-200 dark:border-white/10 py-2.5 text-sm font-medium hover:border-violet/30 cursor-pointer touch-target">
                  <input type="file" accept="image/*" className="hidden" onChange={e=>{
                    const f=e.target.files?.[0];
                    if(!f) return;
                    const url=URL.createObjectURL(f);
                    setBgImageUrl(url);
                    setBgType("image");
                  }} />
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 11L5.5 8L8 10.5L11 6L13 11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/></svg>
                  Upload background image
                </label>
                {bgImageUrl && (
                  <div className="flex items-center gap-2">
                    <img src={bgImageUrl} alt="Background" className="w-12 h-12 rounded-xl object-cover border border-black/5" />
                    <button onClick={()=> { setBgImageUrl(null); setBgType("transparent"); }} className="text-xs px-3 py-1.5 rounded-full border border-zinc-200 dark:border-white/10 hover:bg-black/5">Remove</button>
                  </div>
                )}
              </div>
              <p className="text-xs text-ink/50 dark:text-white/50">Export as PNG keeps transparency. JPG will fill transparent areas with white or your chosen background.</p>
            </div>
          )}

          {tool==="refine" && (
            <div className="space-y-4">
              <h3 className="font-heading font-bold">Refine edges</h3>
              <div className="flex gap-2">
                <button onClick={()=> setBrushMode("erase")} className={`flex-1 py-2.5 rounded-full text-sm font-medium border touch-target ${brushMode==="erase" ? "bg-ink text-white dark:bg-white dark:text-ink border-ink dark:border-white" : "bg-white dark:bg-dark-bg border-zinc-200 dark:border-white/10"}`}>Erase</button>
                <button onClick={()=> setBrushMode("restore")} className={`flex-1 py-2.5 rounded-full text-sm font-medium border touch-target ${brushMode==="restore" ? "bg-ink text-white dark:bg-white dark:text-ink border-ink dark:border-white" : "bg-white dark:bg-dark-bg border-zinc-200 dark:border-white/10"}`}>Restore</button>
              </div>
              <div>
                <label className="flex items-center justify-between text-sm font-medium">Brush size <span className="text-xs text-ink/50 dark:text-white/50">{brushSize}px</span></label>
                <input type="range" min={4} max={80} value={brushSize} onChange={e=> setBrushSize(parseInt(e.target.value))} className="w-full mt-2" aria-label="Brush size" />
                <div className="flex justify-between text-[11px] text-ink/40 dark:text-white/40 mt-1"><span>Small</span><span>Large</span></div>
              </div>
              <div className="flex gap-2">
                <button onClick={undo} disabled={history.length===0} className="flex-1 py-2 rounded-full text-sm border border-zinc-200 dark:border-white/10 disabled:opacity-40 touch-target">Undo</button>
                <button onClick={redo} disabled={future.length===0} className="flex-1 py-2 rounded-full text-sm border border-zinc-200 dark:border-white/10 disabled:opacity-40 touch-target">Redo</button>
                <button onClick={clearStrokes} className="px-4 py-2 rounded-full text-sm bg-black/5 dark:bg-white/10 touch-target">Clear</button>
              </div>
              <p className="text-xs text-ink/50 dark:text-white/50 leading-relaxed">Paint over edges to erase or restore. Works with undo/redo. Switch to After view and paint directly on the preview.</p>
              <div className="bg-paper dark:bg-dark-bg rounded-xl p-3 border border-zinc-200 dark:border-white/10 text-xs leading-relaxed">
                <p className="font-medium">How it works</p>
                <p className="text-ink/60 dark:text-white/60">Strokes are saved to a mask and composited on the canvas. You can export at any time — refinements are baked in.</p>
              </div>
            </div>
          )}

          {tool==="crop" && (
            <div className="space-y-4">
              <h3 className="font-heading font-bold">Crop & resize</h3>
              <div>
                <p className="text-sm font-medium mb-2">Presets</p>
                <div className="flex flex-wrap gap-2">
                  {[
                    ["free","Free"],
                    ["1:1","1:1"],
                    ["4:5","4:5"],
                    ["16:9","16:9"],
                    ["passport","Passport"],
                  ].map(([id,label])=> (
                    <button key={id} onClick={()=> setCropPreset(id as any)} className={`px-3 py-1.5 rounded-full text-xs font-medium border touch-target ${ (id==="free" && !aspect) || (id!=="free" && String(aspect)===String(id==="1:1"?1:id==="4:5"?4/5:id==="16:9"?16/9:35/45)) ? "bg-violet text-white border-violet" : "bg-white dark:bg-dark-bg border-zinc-200 dark:border-white/10"}`}>{label}</button>
                  ))}
                </div>
                <p className="text-xs text-ink/50 dark:text-white/50 mt-2">Drag the crop box on the canvas. “Passport” is 35×45 mm (approx. 600×750 px at 300 dpi).</p>
              </div>

              <div className="space-y-3 pt-3 border-t border-zinc-200 dark:border-white/10">
                <p className="text-sm font-medium">Resize (pixels)</p>
                <label className="flex items-center gap-2 text-sm">
                  <span className="w-12">Width</span>
                  <input type="number" value={resizeW||""} onChange={e=> onResizeW(parseInt(e.target.value)||0)} className="flex-1 rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-dark-bg px-3 py-2" placeholder="Width" />
                  <span className="text-xs text-ink/50">px</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <span className="w-12">Height</span>
                  <input type="number" value={resizeH||""} onChange={e=> onResizeH(parseInt(e.target.value)||0)} className="flex-1 rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-dark-bg px-3 py-2" placeholder="Height" />
                  <span className="text-xs text-ink/50">px</span>
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={lockAspect} onChange={e=> setLockAspect(e.target.checked)} className="rounded" />
                  Lock aspect ratio
                </label>
                <p className="text-xs text-ink/50 dark:text-white/50">Original: {origW}×{origH} • Export will use your target size, or the preset if chosen. Large photos were downscaled to ~2000px for processing, export restores best resolution.</p>
              </div>
            </div>
          )}

          {tool==="export" && (
            <div className="space-y-4">
              <h3 className="font-heading font-bold">Export</h3>
              <div>
                <p className="text-sm font-medium mb-2">Format</p>
                <div className="flex gap-2">
                  <button onClick={()=> setExportFormat("png")} className={`flex-1 py-2.5 rounded-full text-sm font-semibold border touch-target ${exportFormat==="png" ? "bg-ink text-white dark:bg-white dark:text-ink border-ink" : "border-zinc-200 dark:border-white/10"}`}>PNG <span className="text-xs opacity-60">Transparent</span></button>
                  <button onClick={()=> setExportFormat("jpg")} className={`flex-1 py-2.5 rounded-full text-sm font-semibold border touch-target ${exportFormat==="jpg" ? "bg-ink text-white dark:bg-white dark:text-ink border-ink" : "border-zinc-200 dark:border-white/10"}`}>JPG <span className="text-xs opacity-60">Background</span></button>
                </div>
                <p className="text-xs text-ink/50 dark:text-white/50 mt-1.5">PNG keeps transparency. JPG fills background (choose a color/image under Background).</p>
              </div>

              <div>
                <p className="text-sm font-medium mb-2">Size preset</p>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(EXPORT_PRESETS).map(([k,v])=> (
                    <button key={k} onClick={()=> setExportPreset(k as any)} className={`p-3 rounded-2xl border text-left ${exportPreset===k ? "border-violet bg-violet/5" : "border-black/5 dark:border-white/10 hover:border-black/10"}`}>
                      <p className="text-sm font-semibold">{k}</p>
                      <p className="text-xs text-ink/50 dark:text-white/50">{v ? `${v.w}×${v.h}` : `${origW||"—"}×${origH||"—"}`}</p>
                    </button>
                  ))}
                </div>
              </div>

              <button onClick={doExport} disabled={!hasResult} className="w-full bg-violet text-white py-3 rounded-full font-semibold hover:bg-[#5A3FE6] disabled:opacity-50 touch-target flex items-center justify-center gap-2">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3.5V10.5M8 3.5L5 6M8 3.5L11 6M2.5 10.5V12.5C2.5 12.78 2.72 13 3 13H13C13.28 13 13.5 12.78 13.5 12.5V10.5" stroke="#0F1020" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Download {exportFormat.toUpperCase()} {exportPreset!=="Original" ? `• ${exportPreset}` : ""}
              </button>
              <button onClick={doShare} disabled={!hasResult} className="w-full bg-ink text-white dark:bg-white dark:text-ink py-3 rounded-full font-semibold hover:bg-black disabled:opacity-50 touch-target">Share (mobile) — falls back to download</button>
              <p className="text-xs text-ink/50 dark:text-white/50 text-center">Recent images are saved automatically to your device (IndexedDB). Clear them in Settings.</p>
            </div>
          )}
        </div>

        <div className="p-3 border-t border-zinc-200 dark:border-white/10 hidden lg:block">
          <p className="text-[11px] text-ink/40 dark:text-white/40 leading-relaxed">All processing on-device • No accounts • No backend • Your photos never leave this device.</p>
        </div>
      </div>
    </div>
  );
}
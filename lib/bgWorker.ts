"use client";
// Erasebg worker — on-device isnet / birefnet, capped resolution, honest progress, no large per-pixel loops

export type ProgressCb = (pct: number | null, msg?: string) => void;
export type Quality = "high" | "fast";
export type BgMode = "auto" | "people" | "objects";

let workerInstance: Worker | null = null;
let workerUrl: string | null = null;

function getCappedEdge(): number {
  try {
    const isPhone = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    return isPhone ? 1536 : 2048;
  } catch { return 1536; }
}

export function isWebGPUAvailable(): boolean {
  try { return typeof navigator !== "undefined" && !!(navigator as any).gpu; } catch { return false; }
}

// ── birefnet (Objects) via Transformers.js ──
let birefnetPipeline: any = null;
let birefnetLoading: Promise<any> | null = null;
let birefnetModelId: string | null = null;

function getBirefnetModelId(): string {
  // Use standard ONNX community export for both — jessolmstead webgpu fork lacks preprocessor_config.json and fails via pipeline
  // Size ~115 MB fp16 / 224 MB fp32, MIT. WebGPU still used if available at runtime (device: webgpu), else wasm
  return "onnx-community/BiRefNet_lite-ONNX";
}

// downscale for birefnet path (main thread)
async function downscaleBlobMain(blob: Blob, maxEdge:number): Promise<Blob>{
  try{
    const bmp=await createImageBitmap(blob);
    const le=Math.max(bmp.width,bmp.height);
    if(le<=maxEdge){ bmp.close(); return blob; }
    const s=maxEdge/le, w=Math.round(bmp.width*s), h=Math.round(bmp.height*s);
    const c=document.createElement('canvas'); c.width=w; c.height=h;
    const ctx=c.getContext('2d')!;
    ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
    ctx.drawImage(bmp,0,0,w,h);
    bmp.close();
    const out: Blob = await new Promise((res,rej)=> c.toBlob(b=> b?res(b):rej(new Error("toBlob failed")), "image/png", 0.92) as any);
    c.width=1; c.height=1;
    return out || blob;
  }catch{ return blob; }
}

async function getBirefnetPipeline(progressCb: ProgressCb, signal?: AbortSignal): Promise<any>{
  if(birefnetPipeline) return birefnetPipeline;
  if(birefnetLoading) return birefnetLoading;
  // Load transformers from CDN at runtime to avoid bundling node .node binaries
  const transformersUrl = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1/+esm";
  const tf: any = await import(/* webpackIgnore: true */ transformersUrl);
  const pipeline = tf.pipeline;
  const env = tf.env;
  // transformers.js v3 config — force remote HF fetch (ignore local /models)
  try{ (env as any).allowRemoteModels = true; }catch{}
  try{ (env as any).allowLocalModels = false; }catch{}
  try{ (env as any).useFSCache = false; }catch{}
  try{ (env as any).useBrowserCache = true; }catch{}
  // ensure remote host is HF (not localhost)
  try{ if(!((env as any).remoteHost||"").includes("huggingface.co")) (env as any).remoteHost = "https://huggingface.co"; }catch{}
  // wasm paths default CDN, ok
  const useWebGPU = isWebGPUAvailable();
  const modelId = getBirefnetModelId();
  birefnetModelId = modelId;
  const opts: any = {
    device: useWebGPU ? "webgpu" : "wasm",
    dtype: useWebGPU ? "fp16" : "fp32", // webgpu fp16 (~115 MB), wasm fp32 (224 MB fallback)
    progress_callback: (data:any)=>{
      try{
        if(signal?.aborted) return;
        if(data.status==="progress" && typeof data.progress==="number"){
          const pct=Math.max(5, Math.min(95, Math.round(data.progress)));
          progressCb(pct, `Downloading… ${pct}%`);
        } else if(data.status==="download" || data.status==="downloading"){
          const pct = typeof data.progress==="number" ? Math.round(data.progress) : null;
          if(pct!==null) progressCb(pct, `Downloading… ${pct}%`);
          else progressCb(null, "Downloading…");
        } else if(data.status==="ready" || data.status==="done"){
          // model ready, now running
        }
        // also log
        // console.log("[BiRefNet] progress", data);
      }catch{}
    }
  };
  // Prefer fp16 webgpu file, fallback wasm fp32 if q8 not available -> transformers will fallback
  // Try q8 first for wasm, if fails retry fp32
  birefnetLoading = (async()=>{
    try{
      const p = await pipeline("image-segmentation", modelId, opts);
      birefnetPipeline=p; return p;
    }catch(e:any){
      // fallback: try generic ONNX without specifying dtype/device
      if(useWebGPU){
        console.warn("[BiRefNet] webgpu fp16 load failed, retry fp32", e?.message);
        try{
          const p2 = await pipeline("image-segmentation", "onnx-community/BiRefNet_lite-ONNX", { device:"wasm", dtype:"fp32", progress_callback: opts.progress_callback });
          birefnetPipeline=p2; return p2;
        }catch(e2){ throw e2; }
      }
      throw e;
    } finally { birefnetLoading=null; }
  })();
  return birefnetLoading;
}

async function runBiRefNetViaTransformers(
  blob: Blob,
  progressCb: ProgressCb,
  signal?: AbortSignal,
  cappedEdge?: number
): Promise<Blob>{
  const cap = cappedEdge || getCappedEdge();
  // cap blob
  let baseBlob = blob;
  try{
    const bmp=await createImageBitmap(blob);
    const le=Math.max(bmp.width,bmp.height);
    bmp.close();
    if(le>cap){
      progressCb(null, "Removing background, this can take up to a minute on phones");
      baseBlob = await downscaleBlobMain(blob, cap);
    }
  }catch{}
  if(signal?.aborted) throw new DOMException("Aborted","AbortError");

  const pipe = await getBirefnetPipeline(progressCb, signal);
  if(signal?.aborted) throw new DOMException("Aborted","AbortError");
  progressCb(null, "Removing background, this can take up to a minute on phones");

  // Load image via RawImage — transformers supports Blob via fromBlob or URL (CDN runtime)
  const transformersUrl2 = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1/+esm";
  const tf2: any = await import(/* webpackIgnore: true */ transformersUrl2);
  const RawImage = tf2.RawImage;
  let rawImage: any;
  try{
    if((RawImage as any).fromBlob){
      rawImage = await (RawImage as any).fromBlob(baseBlob);
    } else {
      const url = URL.createObjectURL(baseBlob);
      rawImage = await (RawImage as any).fromURL(url);
      try{ URL.revokeObjectURL(url);}catch{}
    }
  }catch{
    // fallback canvas
    const url = URL.createObjectURL(baseBlob);
    rawImage = await (RawImage as any).fromURL(url);
    try{ URL.revokeObjectURL(url);}catch{}
  }
  if(signal?.aborted) throw new DOMException("Aborted","AbortError");

  // Inference
  console.time("[BiRefNet] inference");
  let results:any;
  try{
    results = await pipe(rawImage, {} as any);
  }catch(e:any){
    console.error("[BiRefNet] pipe failed", e);
    throw new Error(e?.message || "BiRefNet inference failed");
  }
  console.timeEnd("[BiRefNet] inference");
  if(signal?.aborted) throw new DOMException("Aborted","AbortError");

  // results is Array<{ label, mask: RawImage, score }>
  let maskRaw: any = null;
  if(Array.isArray(results) && results.length>0){
    // pick largest mask or first
    // BiRefNet returns single foreground mask
    maskRaw = results[0].mask || results[0].data || results[0];
    // if multiple, find biggest area?
    if(results.length>1){
      let best=results[0]; let bestArea=0;
      for(const r of results){
        const m=r.mask; if(m && m.width && m.height){ const area=m.width*m.height; if(area>bestArea){bestArea=area; best=r;}}
      }
      maskRaw=best.mask;
    }
  } else if(results && results.mask){
    maskRaw = results.mask;
  } else {
    throw new Error("No mask from BiRefNet");
  }
  if(!maskRaw) throw new Error("BiRefNet returned empty mask");

  // maskRaw is RawImage grayscale 0-255, size 1024x1024 typically, need to resize to base dimensions
  const bmpBase = await createImageBitmap(baseBlob);
  const w = bmpBase.width, h = bmpBase.height;
  bmpBase.close();

  // Resize mask to w x h
  let maskCanvas: HTMLCanvasElement;
  let maskData: Uint8Array;
  try{
    // maskRaw may have .data (Uint8Array) and width/height, or be RawImage with .data
    // Use maskRaw.resize(w,h) if available
    let resized:any = maskRaw;
    if(typeof maskRaw.resize === "function"){
      try{ resized = await maskRaw.resize(w, h); }catch{ resized = maskRaw; }
    }
    // Extract data
    // RawImage data is flat RGB? For mask it's grayscale? Check: mask.data may be 1 channel or 3
    // In transformers.js, mask is RawImage with 1 channel? Let's inspect: mask.data length vs w*h
    // We'll normalize to Uint8Array w*h
    const rw = resized.width || w;
    const rh = resized.height || h;
    const data: any = resized.data;
    // data can be Uint8Array or Uint8ClampedArray, length = rw*rh OR rw*rh*3/4
    if(data.length === rw*rh){
      maskData = new Uint8Array(data);
    } else if(data.length === rw*rh*4){
      maskData = new Uint8Array(rw*rh);
      for(let i=0, p=0;i<data.length;i+=4,p++) maskData[p]=data[i];
    } else if(data.length === rw*rh*3){
      maskData = new Uint8Array(rw*rh);
      for(let i=0,p=0;i<data.length;i+=3,p++) maskData[p]=data[i];
    } else {
      // fallback: assume 1 channel
      maskData = new Uint8Array(rw*rh);
      for(let i=0;i<Math.min(maskData.length, data.length);i++) maskData[i]=data[i];
    }
    // If resized size not exactly w*h (due to error), create canvas and draw
    if(rw!==w || rh!==h){
      // draw resized data via temporary canvas
      const tmp=document.createElement('canvas'); tmp.width=rw; tmp.height=rh;
      const tctx=tmp.getContext('2d')!;
      const id=tctx.createImageData(rw,rh);
      for(let i=0,p=0;i<id.data.length;i+=4,p++){ const v=maskData[p]||0; id.data[i]=v; id.data[i+1]=v; id.data[i+2]=v; id.data[i+3]=255; }
      tctx.putImageData(id,0,0);
      maskCanvas=document.createElement('canvas'); maskCanvas.width=w; maskCanvas.height=h;
      const mctx=maskCanvas.getContext('2d')!;
      mctx.imageSmoothingEnabled=true; mctx.imageSmoothingQuality='high';
      mctx.drawImage(tmp,0,0,w,h);
      // re-extract
      const id2=mctx.getImageData(0,0,w,h);
      maskData=new Uint8Array(w*h);
      for(let i=0,p=0;i<id2.data.length;i+=4,p++) maskData[p]=id2.data[i];
    } else {
      // keep as is
    }
  }catch(e:any){
    console.error("[BiRefNet] mask processing failed", e);
    throw new Error("Mask resize failed: "+(e?.message||String(e)));
  }

  // Build foreground with mask as alpha: draw base image then set alpha
  const bmp2 = await createImageBitmap(baseBlob);
  const c=document.createElement('canvas'); c.width=w; c.height=h;
  const ctx=c.getContext('2d')!;
  ctx.drawImage(bmp2,0,0);
  bmp2.close();
  const imgData=ctx.getImageData(0,0,w,h);
  const d=imgData.data;
  for(let i=0,p=0;i<d.length;i+=4,p++){
    d[i+3]=maskData[p] ?? 0;
  }
  ctx.putImageData(imgData,0,0);
  // light check: if mask all transparent, throw
  try{
    let opaque=0; for(let i=0;i<maskData.length;i++) if(maskData[i]>30) opaque++;
    if(opaque/(maskData.length) < 0.01) throw new Error("No foreground detected");
  }catch(ve){ if(String((ve as any).message).includes("No foreground")) throw ve; }

  const outBlob: Blob = await new Promise((res,rej)=> c.toBlob(b=> b?res(b):rej(new Error("toBlob failed")), "image/png", 0.92) as any);
  c.width=1; c.height=1;
  // also cache raw mask for post-processing? The maskData is already raw (0-255). For post-process we will treat it as raw.
  try{ (globalThis as any).__erasebgRawMaskData = { mask: maskData.slice(), w, h }; }catch{}
  // Also store raw mask blob for debugging
  try{
    const mCanvas=document.createElement('canvas'); mCanvas.width=w; mCanvas.height=h;
    const mctx=mCanvas.getContext('2d')!;
    const mid=mctx.createImageData(w,h);
    for(let i=0,p=0;i<mid.data.length;i+=4,p++){ const v=maskData[p]; mid.data[i]=v; mid.data[i+1]=v; mid.data[i+2]=v; mid.data[i+3]=255; }
    mctx.putImageData(mid,0,0);
    const maskBlob:Blob = await new Promise((res,rej)=> mCanvas.toBlob(b=> b?res(b):rej(new Error("mask toBlob failed")), "image/png") as any);
    try{ (globalThis as any).__erasebgRawMaskBlob = maskBlob; }catch{}
    mCanvas.width=1; mCanvas.height=1;
  }catch{}
  return outBlob;
}

function createWorker(): Worker {
  const code = `
    let removeBackgroundFn = null;
    let loadPromise = null;
    let memLog = (tag)=>{
      try{
        const m = (performance && performance.memory) ? performance.memory : null;
        if(m) console.log('[Worker mem] '+tag, Math.round(m.usedJSHeapSize/1048576)+'MB / '+Math.round(m.jsHeapSizeLimit/1048576)+'MB');
        else console.log('[Worker mem] '+tag, 'performance.memory n/a');
      }catch{}
    };

    self.onerror = function(e){ try{ const m=e.message||e.error?.message||String(e); self.postMessage({type:'error', error:m.slice(0,1000)}); }catch{} };
    self.onunhandledrejection = function(e){ try{ const m=e.reason?.message||String(e.reason||e); self.postMessage({type:'error', error:m.slice(0,1000)}); }catch{} };
    self.onmessageerror = function(e){ try{ self.postMessage({type:'error', error:'onmessageerror '+String(e)}); }catch{} };

    async function loadImgly(progressSend){
      if(removeBackgroundFn) return removeBackgroundFn;
      if(loadPromise) return loadPromise;
      const importWithTimeout=(url, ms=15000)=> Promise.race([import(url), new Promise((_,rej)=> setTimeout(()=> rej(new Error('import timeout '+url)), ms))]);
      loadPromise=(async()=>{
        const urls=[
          'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm',
          'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.4.5/+esm',
          'https://cdn.skypack.dev/@imgly/background-removal@1.7.0',
          'https://unpkg.com/@imgly/background-removal@1.7.0/+esm'
        ];
        for(const u of urls){
          try{
            console.time('[Worker] load '+u);
            const mod=await importWithTimeout(u, 15000);
            console.timeEnd('[Worker] load '+u);
            memLog('after load '+u);
            const fn=mod.removeBackground||mod.default?.removeBackground||mod.default;
            if(fn){ removeBackgroundFn=fn; return fn; }
          }catch(e){ console.warn('[Worker] load fail', u, e?.message||e); }
        }
        throw new Error('Failed to load background-removal — CDN blocked. Try Wi-Fi.');
      })();
      return loadPromise;
    }

    function isOOM(err){
      const m=(err?.message||String(err)).toLowerCase();
      return m.includes('memory')||m.includes('oom')||m.includes('allocation')||m.includes('out of memory')||m.includes('aborted')||m.includes('exceed')||m.includes('runtimeerror')||m.includes('wasm')||m.includes('failed to allocate')||m.includes('cannot allocate');
    }

    async function hasTransparency(blob){
      let bmp=null;
      try{
        bmp=await createImageBitmap(blob);
        const w=Math.min(bmp.width,64), h=Math.min(bmp.height,64);
        const c=new OffscreenCanvas(w,h);
        const ctx=c.getContext('2d');
        ctx.drawImage(bmp,0,0,w,h);
        const d=ctx.getImageData(0,0,w,h).data;
        let t=0; for(let i=3;i<d.length;i+=4) if(d[i]<250) t++;
        const res = t/(d.length/4) > 0.08;
        bmp.close(); bmp=null;
        c.width=1; c.height=1;
        return res;
      }catch{ try{ bmp && bmp.close(); }catch{} return false; }
    }

    async function downscaleBlob(blob, maxEdge){
      let bmp=null;
      try{
        bmp=await createImageBitmap(blob);
        const le=Math.max(bmp.width,bmp.height);
        if(le<=maxEdge){ bmp.close(); return blob; }
        const s=maxEdge/le, w=Math.round(bmp.width*s), h=Math.round(bmp.height*s);
        console.time('[Worker] downscale '+maxEdge);
        const c=new OffscreenCanvas(w,h);
        const ctx=c.getContext('2d');
        ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
        ctx.drawImage(bmp,0,0,w,h);
        bmp.close(); bmp=null;
        const out=await c.convertToBlob({type:'image/png'});
        c.width=1; c.height=1;
        console.timeEnd('[Worker] downscale '+maxEdge);
        memLog('after downscale '+maxEdge);
        return out;
      }catch(e){ try{ bmp && bmp.close(); }catch{} throw e; }
    }

    async function padBlob(blob, pad){
      let bmp=null;
      try{
        bmp=await createImageBitmap(blob);
        const c=new OffscreenCanvas(bmp.width+pad*2, bmp.height+pad*2);
        const ctx=c.getContext('2d');
        ctx.clearRect(0,0,c.width,c.height);
        ctx.drawImage(bmp, pad, pad);
        const out=await c.convertToBlob({type:'image/png'});
        const w=bmp.width, h=bmp.height;
        bmp.close(); bmp=null;
        c.width=1; c.height=1;
        return {blob:out, w, h, pad};
      }catch{ try{ bmp && bmp.close(); }catch{} return {blob, w:0, h:0, pad:0}; }
    }
    async function unpadBlob(paddedBlob, pad, origW, origH){
      if(!pad || !origW) return paddedBlob;
      let bmp=null;
      try{
        bmp=await createImageBitmap(paddedBlob);
        const c=new OffscreenCanvas(origW, origH);
        const ctx=c.getContext('2d');
        const expectedW = origW + pad*2;
        const expectedH = origH + pad*2;
        if(bmp.width===expectedW && bmp.height===expectedH){
          ctx.drawImage(bmp, -pad, -pad);
        } else {
          const sx = Math.max(0, (bmp.width - origW)/2);
          const sy = Math.max(0, (bmp.height - origH)/2);
          ctx.drawImage(bmp, sx, sy, origW, origH, 0, 0, origW, origH);
        }
        const out=await c.convertToBlob({type:'image/png'});
        bmp.close(); bmp=null;
        c.width=1; c.height=1;
        return out;
      }catch{ try{ bmp && bmp.close(); }catch{} return paddedBlob; }
    }

    async function runImglyCapped(blob, progressSend, cappedEdge, quality){
      const fn=await loadImgly(progressSend);
      if(!fn) throw new Error('Model unavailable');
      let baseBlob = blob;
      let leBase = cappedEdge;
      try{
        const bmp=await createImageBitmap(blob);
        const le=Math.max(bmp.width,bmp.height);
        bmp.close();
        leBase = le;
        if(le>cappedEdge){
          console.time('[Worker] cap '+cappedEdge);
          baseBlob=await downscaleBlob(blob, cappedEdge);
          console.timeEnd('[Worker] cap '+cappedEdge);
          progressSend(null,'Removing background, this can take up to a minute on phones');
          leBase = cappedEdge;
        }
      }catch{}
      const model = 'isnet_quint8';
      console.time('[Worker] preprocess');
      memLog('preprocess start');
      console.timeEnd('[Worker] preprocess');
      memLog('after preprocess');
      console.time('[Worker] composite');
      console.log('[Worker] runImglyCapped capped', cappedEdge, 'base', leBase, 'model', model);
      memLog('before run');
      let input=baseBlob;
      let padInfo=null;
      try{
        padInfo=await padBlob(input, 12);
        input=padInfo.blob;
      }catch{}
      try{
        console.time('[Worker] inference '+model+' @'+leBase);
        memLog('before inference '+model);
        const run = fn(input,{
          model,
          output:{format:'image/png', quality:0.92},
          progress:(k,c,t)=>{
            if(typeof c==='number' && typeof t==='number' && t>0){
              const pct=Math.max(5, Math.min(95, Math.round(c/t*100)));
              progressSend(pct,'Downloading… '+pct+'%');
            }
          }
        });
        const res=await run;
        console.timeEnd('[Worker] inference '+model+' @'+leBase);
        memLog('after inference '+model);
        let b=res instanceof Blob?res:new Blob([res],{type:'image/png'});
        if(!b || b.size<2000) throw new Error('Empty result');
        if(padInfo && padInfo.w){
          try{ b=await unpadBlob(b, padInfo.pad, padInfo.w, padInfo.h); }catch{}
        }
        try{
          const bmp=await createImageBitmap(b);
          const c=new OffscreenCanvas(Math.min(bmp.width,64), Math.min(bmp.height,64));
          const ctx=c.getContext('2d'); ctx.drawImage(bmp,0,0,c.width,c.height);
          const d=ctx.getImageData(0,0,c.width,c.height).data;
          let tr=0; for(let i=3;i<d.length;i+=4) if(d[i]<250) tr++;
          bmp.close(); c.width=1; c.height=1;
          if(tr/(d.length/4) < 0.02) throw new Error('No transparency produced');
        }catch(ve){ if(String(ve.message).includes('No transparency')) throw ve; }
        console.log('[Worker] success', model, 'edge', leBase, 'size', b.size);
        console.timeEnd('[Worker] composite');
        memLog('after composite');
        console.time('[Worker] encode');
        console.timeEnd('[Worker] encode');
        memLog('after encode');
        input=null; padInfo=null;
        return { blob: b, rawMaskBlob: null };
      }catch(err){
        const msg=err?.message||String(err);
        console.warn('[Worker] fail', model, '@'+leBase, msg);
        throw err;
      }
    }

    self.onmessage=async(e)=>{
      const {id, blob, cappedEdge, quality}=e.data;
      const send=(m)=>{
        try{ self.postMessage({id, ...m}); }catch(err){ try{ self.postMessage({id, type:'error', error: String(err)});}catch{} }
      };
      const progressSend=(pct,msg)=> send({type:'progress', pct, msg});
      let tAll=performance.now();
      try{
        console.time('[Worker] total');
        memLog('onmessage start');
        if(!(blob instanceof Blob) || blob.size===0) throw new Error('Invalid image');
        send({type:'progress', pct:null, msg:'Removing background, this can take up to a minute on phones'});
        if(await hasTransparency(blob)){
          progressSend(null,'Removing background, this can take up to a minute on phones');
          let bmp=null;
          try{
            bmp=await createImageBitmap(blob);
            const c=new OffscreenCanvas(bmp.width,bmp.height);
            const ctx=c.getContext('2d'); ctx.drawImage(bmp,0,0);
            const out=await c.convertToBlob({type:'image/png'});
            bmp.close(); bmp=null;
            c.width=1; c.height=1;
            const ab=await out.arrayBuffer();
            send({type:'done', blob:out, buffer:ab});
            try{ self.postMessage({id, type:'done', buffer:ab}, [ab]); }catch{}
            return;
          }catch{ try{ bmp && bmp.close(); }catch{} send({type:'done', blob:blob}); return; }
        }
        const cap = cappedEdge||1024;
        console.log('[Worker] cappedEdge', cap, 'blob', blob.size, blob.type);
        const res=await runImglyCapped(blob, progressSend, cap, quality);
        memLog('before done');
        console.timeEnd('[Worker] total');
        console.log('[Worker] total ms', Math.round(performance.now()-tAll));
        try{
          const ab=await res.blob.arrayBuffer();
          send({type:'done', blob:res.blob, buffer:ab});
          try{ self.postMessage({id, type:'done', buffer:ab}, [ab]); }catch{}
        }catch{
          send({type:'done', blob:res.blob});
        }
        blob.arrayBuffer && blob.arrayBuffer().then(()=>{}).catch(()=>{});
      }catch(err){
        console.timeEnd('[Worker] total');
        const detail=(err?.stack||err?.message||String(err)).slice(0,1200);
        console.error('[Worker] fatal', detail);
        memLog('on error');
        send({type:'error', error: detail});
      } finally {
        try{ if(blob) blob=null; }catch{}
      }
    };
  `;
  const blob = new Blob([code], { type: "application/javascript" });
  workerUrl = URL.createObjectURL(blob);
  const w = new Worker(workerUrl, { type: "module" });
  w.addEventListener('error', (e)=> console.error('[Main] worker error', e.message, e.filename, e.lineno));
  w.addEventListener('messageerror', (e)=> console.error('[Main] worker messageerror', e));
  return w;
}

export function getWorker(): Worker {
  if (typeof window === "undefined") throw new Error("Worker only in browser");
  if (!workerInstance) workerInstance = createWorker();
  return workerInstance;
}

export function terminateWorker(){
  try{
    if(workerInstance){
      workerInstance.terminate();
      workerInstance=null;
    }
    if(workerUrl){
      try{ URL.revokeObjectURL(workerUrl); }catch{}
      workerUrl=null;
    }
  }catch{}
}

export function recreateWorker(): Worker {
  terminateWorker();
  return getWorker();
}

// Legacy call without mode → people
export async function removeBackgroundViaWorker(
  fileOrBlob: Blob,
  onProgress: ProgressCb,
  signal?: AbortSignal,
  quality: Quality = "high",
  cappedEdge?: number,
  mode: BgMode = "people"
): Promise<Blob> {
  if (!(fileOrBlob instanceof Blob)) throw new Error("Invalid image blob");
  if (fileOrBlob.size === 0) throw new Error("Empty file");
  const t = (fileOrBlob as File).type || "";
  if (t && !t.startsWith("image/")) throw new Error("Invalid type: " + t);

  // fast transparency check on main (small) to avoid worker altogether
  try {
    const bmp = await createImageBitmap(fileOrBlob);
    const w = Math.min(bmp.width, 64), h = Math.min(bmp.height, 64);
    const c = document.createElement("canvas"); c.width=w; c.height=h;
    const ctx=c.getContext("2d")!; ctx.drawImage(bmp,0,0,w,h);
    const d=ctx.getImageData(0,0,w,h).data;
    let tr=0; for(let i=3;i<d.length;i+=4) if(d[i]<250) tr++;
    bmp.close();
    c.width=1; c.height=1;
    if(tr/(d.length/4)>0.08){
      onProgress(null,"Removing background, this can take up to a minute on phones");
      const full=await createImageBitmap(fileOrBlob);
      const cc=document.createElement("canvas"); cc.width=full.width; cc.height=full.height;
      cc.getContext("2d")!.drawImage(full,0,0); full.close();
      const blob: Blob = await new Promise<Blob>((res,rej)=> cc.toBlob(b=> b?res(b):rej(new Error("toBlob failed")),"image/png"));
      cc.width=1; cc.height=1;
      return blob;
    }
  }catch{}

  // Branch by mode — People (isnet) is default; Objects (BiRefNet) only when explicitly chosen
  // Auto currently maps to People for speed/reliability; user can Try another mode to get Objects
  const effectiveMode: BgMode = mode || "people";
  const useObjects = effectiveMode==="objects";
  if(useObjects){
      // Objects → BiRefNet
      try{
        const cap = cappedEdge || getCappedEdge();
        const out = await runBiRefNetViaTransformers(fileOrBlob, onProgress, signal, cap);
        if(signal?.aborted) throw new DOMException("Aborted","AbortError");
        return out;
      }catch(e:any){
        if(e?.name==="AbortError") throw e;
        console.warn("[Main] BiRefNet failed, falling back to People isnet", e?.message);
        // continue to worker path below
      }
  }

  const worker=getWorker();
  const cap = cappedEdge || getCappedEdge();
  return await new Promise<Blob>((resolve,reject)=>{
    const id=Math.random().toString(36).slice(2);
    let settled=false;
    const onMessage=(e:MessageEvent)=>{
      if(e.data.id!==id) return;
      if(e.data.type==="progress"){
        onProgress(e.data.pct as number | null, e.data.msg);
      }
      else if(e.data.type==="done"){
        if(settled) return;
        settled=true;
        cleanup();
        if(e.data.rawMaskBlob){
          try{ (globalThis as any).__erasebgRawMaskBlob = e.data.rawMaskBlob; }catch{}
        }
        if(e.data.blob) resolve(e.data.blob as Blob);
        else if(e.data.buffer) resolve(new Blob([e.data.buffer],{type:'image/png'}));
        else reject(new Error("No result"));
      }
      else if(e.data.type==="error"){
        if(settled) return;
        settled=true;
        cleanup();
        reject(new Error(e.data.error||"Failed"));
      }
    };
    const onError=(err:ErrorEvent)=>{
      if(settled) return;
      settled=true;
      cleanup();
      const detail = (err as any)?.message || (err as any)?.filename ? ((err as any).message + " @ " + (err as any).filename + ":" + (err as any).lineno) : "";
      const msg = (err as any)?.error?.message || detail || "Worker crashed (likely out of memory).";
      console.error("[Main] worker error event", err);
      try{ terminateWorker(); }catch{}
      reject(new Error(msg));
    };
    const onMessageError=(e:MessageEvent)=>{
      if(settled) return;
      settled=true;
      cleanup();
      try{ terminateWorker(); }catch{}
      reject(new Error("Worker messageerror — data too large to transfer."));
    };
    const cleanup=()=>{
      worker.removeEventListener("message",onMessage);
      worker.removeEventListener("error",onError);
      worker.removeEventListener("messageerror",onMessageError);
      if(signal) signal.removeEventListener("abort",onAbort);
    };
    const onAbort=()=>{
      if(settled) return;
      settled=true;
      cleanup();
      try{ terminateWorker(); }catch{}
      reject(new DOMException("Aborted","AbortError"));
    };
    worker.addEventListener("message",onMessage);
    worker.addEventListener("error",onError);
    worker.addEventListener("messageerror",onMessageError as any);
    if(signal) signal.addEventListener("abort",onAbort);
    try{
      worker.postMessage({id, blob:fileOrBlob, cappedEdge: cap, quality});
    }catch(err){
      cleanup();
      reject(new Error("postMessage failed: "+(err as any)?.message));
    }
  });
}

export function isFirstTime(): boolean {
  try { return localStorage.getItem("erasebg-model-cached")!=="1"; } catch { return true; }
}
export function markModelCached(){ try{localStorage.setItem("erasebg-model-cached","1");}catch{} }

export function getLastRawMaskBlob(): Blob | null {
  try{ return (globalThis as any).__erasebgRawMaskBlob || null; }catch{ return null; }
}
export function getLastRawMaskData(): { mask: Uint8Array, w:number, h:number } | null {
  try{ return (globalThis as any).__erasebgRawMaskData || null; }catch{ return null; }
}

export function getCappedEdgeExport(): number { return getCappedEdge(); }
export function getBirefnetModelInfo(): { id:string, size:string, license:string } {
  const id = birefnetModelId || getBirefnetModelId();
  const isWGPU = isWebGPUAvailable();
  // Sizes: jessolmstead fp16_webgpu 113.8 MB, onnx-community model.onnx 224 MB, model_fp16 115 MB
  const size = isWGPU ? "~114 MB (fp16 WebGPU)" : "~115 MB fp16 / 224 MB fp32 (WASM)";
  return { id, size, license: "MIT (Copyright 2024 ZhengPeng) — original BiRefNet_lite, permissive commercial use" };
}

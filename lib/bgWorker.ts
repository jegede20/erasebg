"use client";
// Erasebg worker — on-device isnet, capped resolution, honest progress, no large per-pixel loops

export type ProgressCb = (pct: number | null, msg?: string) => void;
export type Quality = "high" | "fast";

let workerInstance: Worker | null = null;
let workerUrl: string | null = null;

function getCappedEdge(): number {
  try {
    const isPhone = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    return isPhone ? 1536 : 2048;
  } catch { return 1536; }
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

    // BiRefNet for Objects mode — general purpose, MIT, ~94 MB fp16 / 224 MB fp32 (lite)
    let transformersMod=null, birefProcessor=null, birefModel=null, birefDevice=null, birefDtype=null, currentModelId=null;
    async function loadTransformers(){
      if(transformersMod) return transformersMod;
      const importWithTimeout=(url, ms=15000)=> Promise.race([import(url), new Promise((_,rej)=> setTimeout(()=> rej(new Error('import timeout '+url)), ms))]);
      const urls=[
        'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1/+esm',
        'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.0/+esm',
        'https://unpkg.com/@huggingface/transformers@3.7.1/+esm'
      ];
      for(const u of urls){
        try{
          const mod=await importWithTimeout(u, 15000);
          if(mod.env && mod.AutoModel && mod.AutoProcessor && mod.RawImage){
            try{
              mod.env.allowRemoteModels=true; mod.env.allowLocalModels=false; mod.env.useBrowserCache=true;
              const isIsolated = typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false;
              if(mod.env.backends?.onnx?.wasm){
                if(isIsolated){ mod.env.backends.onnx.wasm.numThreads=Math.min(4, (navigator.hardwareConcurrency||4)); mod.env.backends.onnx.wasm.simd=true; } else mod.env.backends.onnx.wasm.numThreads=1;
                mod.env.backends.onnx.wasm.wasmPaths='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/';
              }
            }catch{}
            transformersMod=mod; return mod;
          }
        }catch(e){}
      }
      throw new Error('Failed to load transformers for Objects mode');
    }
    function hasWebGPU(){ try{ if(typeof navigator!=='undefined' && (navigator as any).gpu) return true; if(typeof self!=='undefined' && (self as any).navigator?.gpu) return true; }catch{} return false; }
    async function ensureBiRefNet(progressSend){
      if(birefModel && birefProcessor) return {processor:birefProcessor, model:birefModel};
      const mod=await loadTransformers();
      const {AutoModel, AutoProcessor}=mod;
      const useWebGPU=hasWebGPU();
      const modelId = useWebGPU ? 'onnx-community/BiRefNet_lite' : 'onnx-community/BiRefNet_lite-ONNX';
      const attempts = useWebGPU ? [{device:'webgpu', dtype:'fp32', label:'WebGPU fp32 1024'}, {device:'webgpu', dtype:'fp16', label:'WebGPU fp16 1024'}] : [{device:'wasm', dtype:'fp32', label:'WASM fp32 1024'}, {device:'wasm', dtype:'fp16', label:'WASM fp16 1024'}, {device:'wasm', dtype:'q8', label:'WASM q8 1024'}];
      let lastErr=null;
      for(const att of attempts){
        try{
          console.time('[BiRefNet] load '+modelId+' '+att.label);
          progressSend(null,'Removing background, this can take up to a minute on phones');
          const progress_callback=(data)=>{ try{ if(data.status==='progress' && data.file){ const pct=Math.round(data.progress||0); progressSend(pct,'Downloading… '+pct+'%'); } }catch{} };
          const processor=await AutoProcessor.from_pretrained(modelId, {progress_callback});
          const model=await AutoModel.from_pretrained(modelId, {device:att.device, dtype:att.dtype, progress_callback});
          console.timeEnd('[BiRefNet] load '+modelId+' '+att.label);
          birefProcessor=processor; birefModel=model; birefDevice=att.device; birefDtype=att.dtype; currentModelId=modelId;
          return {processor, model};
        }catch(e){ lastErr=e; console.warn('[BiRefNet] fail', att.label, e?.message||e); continue; }
      }
      throw lastErr||new Error('BiRefNet lite failed to load');
    }
    async function runBiRefNet(blob, progressSend, cappedEdge){
      const mod=await loadTransformers();
      const {RawImage}=mod;
      const {processor, model}=await ensureBiRefNet(progressSend);
      if(await hasTransparency(blob)){
        progressSend(null,'Removing background, this can take up to a minute on phones');
        let bmp=null;
        try{
          bmp=await createImageBitmap(blob);
          const c=new OffscreenCanvas(bmp.width,bmp.height);
          const ctx=c.getContext('2d'); ctx.drawImage(bmp,0,0);
          const out=await c.convertToBlob({type:'image/png'});
          bmp.close(); c.width=1; c.height=1;
          return {blob:out, rawMaskBlob:null};
        }catch{ try{ bmp&&bmp.close(); }catch{} return {blob, rawMaskBlob:null}; }
      }
      console.time('[BiRefNet] preprocess');
      progressSend(null,'Removing background, this can take up to a minute on phones');
      const image=await RawImage.fromBlob(blob);
      const fullBmp=await createImageBitmap(blob);
      const fullW=fullBmp.width, fullH=fullBmp.height;
      let pixel_values;
      try{ const out=await processor(image); pixel_values=out.pixel_values||out.input_image||out[Object.keys(out)[0]]; }catch(e){ throw new Error('Preprocess failed: '+(e?.message||e)); }
      if(!pixel_values) throw new Error('Processor returned no pixel_values');
      console.timeEnd('[BiRefNet] preprocess');
      console.time('[BiRefNet] inference');
      progressSend(null,'Removing background, this can take up to a minute on phones');
      let outputs;
      try{ outputs=await model({input_image:pixel_values}); }catch{ try{ outputs=await model({pixel_values}); }catch{ outputs=await model(pixel_values); } }
      console.timeEnd('[BiRefNet] inference');
      console.time('[BiRefNet] postprocess');
      progressSend(null,'Removing background, this can take up to a minute on phones');
      let tensor=outputs?.output_image||outputs?.logits||outputs?.pred_masks||outputs?.output||outputs?.[0];
      if(!tensor){ for(const k of Object.keys(outputs||{})){ const v=outputs[k]; if(v&&v.data&&v.dims){tensor=v;break;} } }
      if(!tensor) throw new Error('No output tensor');
      if(Array.isArray(tensor)) tensor=tensor[0];
      const dims=tensor.dims||tensor.shape;
      const data=tensor.data;
      let h=dims[dims.length-2], w=dims[dims.length-1];
      let flat=data;
      if(flat.length>h*w) flat=flat.slice(flat.length-h*w);
      const maskU8=new Uint8Array(h*w);
      for(let i=0;i<h*w;i++){ const v=flat[i]; const sig=1/(1+Math.exp(-v)); maskU8[i]=Math.round(sig*255); }
      // Build small alpha mask then bilinear up to capped
      const smallAlpha=new OffscreenCanvas(w,h);
      const sctx=smallAlpha.getContext('2d');
      const sImg=sctx.createImageData(w,h);
      for(let i=0;i<h*w;i++){ sImg.data[i*4]=255; sImg.data[i*4+1]=255; sImg.data[i*4+2]=255; sImg.data[i*4+3]=maskU8[i]; }
      sctx.putImageData(sImg,0,0);
      const fullMask=new OffscreenCanvas(fullW,fullH);
      const fctx=fullMask.getContext('2d');
      fctx.imageSmoothingEnabled=true; fctx.imageSmoothingQuality='high';
      fctx.drawImage(smallAlpha,0,0,w,h,0,0,fullW,fullH);
      smallAlpha.width=1; smallAlpha.height=1;
      // Composite original with mask via destination-in (no large loops)
      const outCanvas=new OffscreenCanvas(fullW,fullH);
      const octx=outCanvas.getContext('2d');
      octx.drawImage(fullBmp,0,0);
      fullBmp.close();
      octx.globalCompositeOperation='destination-in';
      octx.drawImage(fullMask,0,0);
      fullMask.width=1; fullMask.height=1;
      const outBlob=await outCanvas.convertToBlob({type:'image/png'});
      outCanvas.width=1; outCanvas.height=1;
      // raw mask for post-processing: at full size grayscale
      const rawMaskCanvas=new OffscreenCanvas(fullW,fullH);
      const rctx=rawMaskCanvas.getContext('2d');
      rctx.imageSmoothingEnabled=true; rctx.imageSmoothingQuality='high';
      // need grayscale raw: create from maskU8 small then scale
      const smallGray=new OffscreenCanvas(w,h);
      const gctx=smallGray.getContext('2d');
      const gImg=gctx.createImageData(w,h);
      for(let i=0;i<h*w;i++){ const v=maskU8[i]; gImg.data[i*4]=v; gImg.data[i*4+1]=v; gImg.data[i*4+2]=v; gImg.data[i*4+3]=255; }
      gctx.putImageData(gImg,0,0);
      rctx.drawImage(smallGray,0,0,w,h,0,0,fullW,fullH);
      smallGray.width=1; smallGray.height=1;
      const rawMaskBlob=await rawMaskCanvas.convertToBlob({type:'image/png'});
      rawMaskCanvas.width=1; rawMaskCanvas.height=1;
      console.timeEnd('[BiRefNet] postprocess');
      return {blob:outBlob, rawMaskBlob};
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

    async function runImglyCapped(blob, progressSend, cappedEdge){
      const fn=await loadImgly(progressSend);
      if(!fn) throw new Error('Model unavailable');
      const modelOrder = ['isnet_quint8','isnet_fp16','isnet'];
      let lastErr=null;
      // Ensure input is capped before model (capped already in main thread, but enforce)
      let baseBlob = blob;
      try{
        const bmp=await createImageBitmap(blob);
        const le=Math.max(bmp.width,bmp.height);
        bmp.close();
        if(le>cappedEdge){
          console.time('[Worker] cap '+cappedEdge);
          baseBlob=await downscaleBlob(blob, cappedEdge);
          console.timeEnd('[Worker] cap '+cappedEdge);
          progressSend(null,'Removing background, this can take up to a minute on phones');
        }
      }catch{}
      // Model native is 1024 — isnet input is 1024, so 1024 is enough; larger is waste
      const modelNative = 1024;
      // Retry sizes: capped -> 1024 -> 768 -> 512
      const candidates = [];
      const leBase = await (async()=>{ try{ const b=await createImageBitmap(baseBlob); const v=Math.max(b.width,b.height); b.close(); return v;}catch{return cappedEdge;}})();
      if(leBase>modelNative) candidates.push(modelNative);
      candidates.push(768,512);
      // unique and sorted descending, keep capped if different
      const sizeSteps = [null, ...candidates.filter((v,i,a)=> a.indexOf(v)===i)];
      console.log('[Worker] runImglyCapped capped', cappedEdge, 'base', leBase, 'steps', sizeSteps, 'models', modelOrder);
      memLog('before run loop');
      for(const maxEdge of sizeSteps){
        let input=baseBlob;
        let padInfo=null;
        if(maxEdge!==null){
          try{
            console.time('[Worker] downscale step '+maxEdge);
            input=await downscaleBlob(baseBlob, maxEdge);
            console.timeEnd('[Worker] downscale step '+maxEdge);
          }catch(e){ lastErr=e; continue; }
        }
        try{
          padInfo=await padBlob(input, 12);
          input=padInfo.blob;
        }catch{}
        for(const model of modelOrder){
          let tLoad=0, tInf=0;
          try{
            console.time('[Worker] inference '+model+' @'+(maxEdge||leBase));
            memLog('before inference '+model);
            const timeout = new Promise((_,rej)=> setTimeout(()=> rej(new Error('Model timeout after 60s')), 60000));
            const run = fn(input,{
              model,
              output:{format:'image/png', quality:0.92},
              progress:(k,c,t)=>{
                if(typeof c==='number' && typeof t==='number' && t>0){
                  const pct=Math.max(5, Math.min(95, Math.round(c/t*100)));
                  progressSend(pct,'Downloading… '+pct+'%');
                } else {
                  // do not send fake pct — honest spinner
                }
              }
            });
            const res=await Promise.race([run, timeout]);
            console.timeEnd('[Worker] inference '+model+' @'+(maxEdge||leBase));
            memLog('after inference '+model);
            let b=res instanceof Blob?res:new Blob([res],{type:'image/png'});
            if(!b || b.size<2000) throw new Error('Empty result');
            if(padInfo && padInfo.w){
              try{ b=await unpadBlob(b, padInfo.pad, padInfo.w, padInfo.h); }catch{}
            }
            // quick transparency check on small thumb (no large loops)
            try{
              const bmp=await createImageBitmap(b);
              const c=new OffscreenCanvas(Math.min(bmp.width,64), Math.min(bmp.height,64));
              const ctx=c.getContext('2d'); ctx.drawImage(bmp,0,0,c.width,c.height);
              const d=ctx.getImageData(0,0,c.width,c.height).data;
              let tr=0; for(let i=3;i<d.length;i+=4) if(d[i]<250) tr++;
              bmp.close(); c.width=1; c.height=1;
              if(tr/(d.length/4) < 0.02) throw new Error('No transparency produced');
            }catch(ve){ if(String(ve.message).includes('No transparency')) throw ve; }
            // Success — return without large per-pixel loops (mask already applied by imgly)
            console.log('[Worker] success', model, 'edge', maxEdge||leBase, 'size', b.size);
            // drop refs
            input=null; padInfo=null;
            return { blob: b, rawMaskBlob: null };
          }catch(err){
            const msg=err?.message||String(err);
            console.warn('[Worker] fail', model, '@'+(maxEdge||leBase), msg);
            if(isOOM(err)){ lastErr=err; break; } // retry smaller size
            if(String(msg).includes('timeout')){ lastErr=err; continue; }
            if(String(msg).includes('No transparency')){ lastErr=err; break; }
            lastErr=err; continue;
          } finally {
            // release per-iteration
            try{ if(input && input!==baseBlob) { /* blob GC */ } }catch{}
          }
        }
        if(lastErr && isOOM(lastErr)) continue; // try next smaller size
      }
      throw lastErr||new Error('All models failed at capped size');
    }

    self.onmessage=async(e)=>{
      const {id, blob, cappedEdge, mode}=e.data;
      const useObjects = mode==='objects';
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
            // transfer buffer
            send({type:'done', blob:out, buffer:ab});
            // also send via transfer
            try{ self.postMessage({id, type:'done', buffer:ab}, [ab]); }catch{}
            return;
          }catch{ try{ bmp && bmp.close(); }catch{} send({type:'done', blob:blob}); return; }
        }
        // Cap is enforced in main thread, but also here
        const cap = cappedEdge||1024;
        console.log('[Worker] cappedEdge', cap, 'blob', blob.size, blob.type);
        let res;
        if(useObjects){
          console.log('[Worker] mode objects — BiRefNet lite');
          res=await runBiRefNet(blob, progressSend, cap);
        } else {
          console.log('[Worker] mode', mode||'people', '— isnet');
          res=await runImglyCapped(blob, progressSend, cap);
        }
        memLog('before done');
        console.timeEnd('[Worker] total');
        console.log('[Worker] total ms', Math.round(performance.now()-tAll));
        // Use transfer for buffer when possible
        try{
          const ab=await res.blob.arrayBuffer();
          send({type:'done', blob:res.blob, buffer:ab});
          // attempt transfer
          try{ self.postMessage({id, type:'done', buffer:ab}, [ab]); }catch{}
        }catch{
          send({type:'done', blob:res.blob});
        }
        // drop
        blob.arrayBuffer && blob.arrayBuffer().then(()=>{}).catch(()=>{});
      }catch(err){
        console.timeEnd('[Worker] total');
        const detail=(err?.stack||err?.message||String(err)).slice(0,1200);
        console.error('[Worker] fatal', detail);
        memLog('on error');
        send({type:'error', error: detail});
      } finally {
        // encourage GC
        try{ if(blob) blob=null; }catch{}
      }
    };
  `;
  const blob = new Blob([code], { type: "application/javascript" });
  workerUrl = URL.createObjectURL(blob);
  const w = new Worker(workerUrl, { type: "module" });
  // surface worker errors to console
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

export async function removeBackgroundViaWorker(
  fileOrBlob: Blob,
  onProgress: ProgressCb,
  signal?: AbortSignal,
  quality: Quality = "high",
  cappedEdge?: number,
  mode: "auto"|"people"|"objects" = "auto"
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
      // use toBlob via Offscreen if possible, but keep simple
      const blob: Blob = await new Promise<Blob>((res,rej)=> cc.toBlob(b=> b?res(b):rej(new Error("toBlob failed")),"image/png"));
      cc.width=1; cc.height=1;
      return blob;
    }
  }catch{}

  const worker=getWorker();
  const cap = cappedEdge || getCappedEdge();
  const effMode = mode==="auto" ? "people" : mode; // auto defaults to people for now
  return await new Promise<Blob>((resolve,reject)=>{
    const id=Math.random().toString(36).slice(2);
    let settled=false;
    const onMessage=(e:MessageEvent)=>{
      if(e.data.id!==id) return;
      if(e.data.type==="progress"){
        // honest: only download has pct, otherwise indeterminate
        onProgress(e.data.pct as number | null, e.data.msg);
      }
      else if(e.data.type==="done"){
        if(settled) return;
        settled=true;
        cleanup();
        if(e.data.rawMaskBlob){
          try{ (globalThis as any).__erasebgRawMaskBlob = e.data.rawMaskBlob; }catch{}
        }
        // prefer blob, fallback to buffer
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
      reject(new Error(msg));
    };
    const onMessageError=(e:MessageEvent)=>{
      if(settled) return;
      settled=true;
      cleanup();
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
      reject(new DOMException("Aborted","AbortError"));
    };
    worker.addEventListener("message",onMessage);
    worker.addEventListener("error",onError);
    worker.addEventListener("messageerror",onMessageError as any);
    if(signal) signal.addEventListener("abort",onAbort);
    // Transfer the blob's buffer if possible? Blob is not transferable, but we can send blob directly (structured clone)
    // For capped size, blob is at most ~2-3MB, clone is fine.
    try{
      worker.postMessage({id, blob:fileOrBlob, cappedEdge: cap, quality, mode: effMode});
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

export function getCappedEdgeExport(): number { return getCappedEdge(); }

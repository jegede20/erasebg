"use client";
// Unified background removal: BiRefNet lite (High) + @imgly (Fast fallback)
// - High default = onnx-community/BiRefNet_lite via @huggingface/transformers (AutoModel+AutoProcessor) inside Web Worker
// - Fast = @imgly/background-removal isnet_quint8
// - WebGPU first (fp32 to avoid fp16 corruption), fallback wasm, auto-fallback to Fast on failure
// - Pipeline: processor -> model({input_image: pixel_values}) -> output_image.sigmoid -> resize bilinear to ORIGINAL -> alpha on full-res

export type ProgressCb = (pct: number, msg?: string) => void;
export type Quality = "high" | "fast";

let workerInstance: Worker | null = null;

function createWorker(): Worker {
  const code = `
    // BiRefNet state
    let transformersMod = null;
    let birefProcessor = null;
    let birefModel = null;
    let birefDevice = null;
    let birefDtype = null;
    // imgly state
    let removeBackgroundFn = null;
    let loadPromise = null;

    async function loadImgly(){
      if(removeBackgroundFn) return removeBackgroundFn;
      if(loadPromise) return loadPromise;
      loadPromise=(async()=>{
        const urls=[
          'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm',
          'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.4.5/+esm',
          'https://cdn.skypack.dev/@imgly/background-removal@1.7.0',
          'https://unpkg.com/@imgly/background-removal@1.7.0/+esm'
        ];
        for(const u of urls){
          try{
            const mod=await import(u);
            const fn=mod.removeBackground||mod.default?.removeBackground||mod.default;
            if(fn){ removeBackgroundFn=fn; return fn; }
          }catch(e){}
        }
        return null;
      })();
      return loadPromise;
    }

    async function loadTransformers(){
      if(transformersMod) return transformersMod;
      // transformers 3.7.1 ESM via jsDelivr
      const urls=[
        'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1/+esm',
        'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.0/+esm',
        'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1/+esm',
        'https://unpkg.com/@huggingface/transformers@3.7.1/+esm'
      ];
      for(const u of urls){
        try{
          const mod=await import(u);
          if(mod.env && mod.AutoModel && mod.AutoProcessor && mod.RawImage){
            // configure cache
            try{
              mod.env.allowRemoteModels = true;
              mod.env.allowLocalModels = false;
              mod.env.useBrowserCache = true;
              if(mod.env.backends && mod.env.backends.onnx && mod.env.backends.onnx.wasm){
                mod.env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/';
                mod.env.backends.onnx.wasm.numThreads = 1;
              }
            }catch{}
            transformersMod=mod;
            return mod;
          }
        }catch(e){}
      }
      throw new Error('Failed to load transformers');
    }

    async function ensureBiRefNet(progressSend){
      if(birefModel && birefProcessor) return {processor:birefProcessor, model:birefModel, device:birefDevice, dtype:birefDtype};
      const mod=await loadTransformers();
      const { env, AutoModel, AutoProcessor } = mod;
      const modelId='onnx-community/BiRefNet_lite';
      // onnx-community/BiRefNet_lite is the transformers.js id (without -ONNX suffix)
      // Alternative valid id: 'onnx-community/BiRefNet_lite-ONNX' - try both
      const ids=['onnx-community/BiRefNet_lite','onnx-community/BiRefNet_lite-ONNX'];
      let lastErr=null;
      // Try WebGPU fp32 first (avoid fp16 corruption), then wasm
      const attempts=[
        {device:'webgpu', dtype:'fp32', label:'WebGPU fp32'},
        {device:'webgpu', dtype:'fp16', label:'WebGPU fp16'},
        {device:'wasm', dtype:'fp32', label:'WASM fp32'},
        {device:'wasm', dtype:'fp16', label:'WASM fp16'},
        {device:'wasm', dtype:'q8', label:'WASM q8'},
      ];
      const progress_callback = (data)=>{
        // data: {status, file, progress, loaded, total}
        try{
          if(data.status==='progress' && data.file){
            const pct=Math.round(data.progress||0);
            progressSend(10+Math.round(pct*0.4), 'Downloading BiRefNet '+data.file+'… '+pct+'%');
          }else if(String(data.status).includes('downloading')||String(data.status).includes('download')){
            progressSend(15, 'Downloading BiRefNet model…');
          }else if(data.status==='ready' || data.status==='done'){
            progressSend(50, 'BiRefNet cached');
          }
        }catch{}
      };
      for(const id of ids){
        for(const att of attempts){
          try{
            progressSend(12, 'Loading BiRefNet lite ('+att.label+')…');
            // Some runtimes don't support dtype device combo, so catch
            let opts={ dtype: att.dtype, device: att.device, progress_callback };
            // For wasm, some versions ignore dtype
            const processor=await AutoProcessor.from_pretrained(id, { progress_callback });
            const model=await AutoModel.from_pretrained(id, opts);
            birefProcessor=processor;
            birefModel=model;
            birefDevice=att.device;
            birefDtype=att.dtype;
            progressSend(55, 'BiRefNet ready ('+att.label+')');
            return {processor, model, device:att.device, dtype:att.dtype};
          }catch(e){
            lastErr=e;
            // continue to next attempt
            progressSend(20, att.label+' not available, trying fallback…');
          }
        }
      }
      throw lastErr||new Error('BiRefNet lite failed to load — no WebGPU/WASM support');
    }

    function isOOM(err){
      const m=(err?.message||String(err)).toLowerCase();
      return m.includes('memory')||m.includes('oom')||m.includes('allocation')||m.includes('out of memory')||m.includes('aborted')||m.includes('exceed');
    }
    async function hasTransparency(blob){
      try{
        const bmp=await createImageBitmap(blob);
        const w=Math.min(bmp.width,64), h=Math.min(bmp.height,64);
        const c=new OffscreenCanvas(w,h);
        const ctx=c.getContext('2d');
        ctx.drawImage(bmp,0,0,w,h);
        const d=ctx.getImageData(0,0,w,h).data;
        let t=0; for(let i=3;i<d.length;i+=4) if(d[i]<250) t++;
        bmp.close();
        return t/(d.length/4) > 0.08;
      }catch{ return false; }
    }
    async function downscaleBlob(blob, maxEdge){
      const bmp=await createImageBitmap(blob);
      const le=Math.max(bmp.width,bmp.height);
      if(le<=maxEdge){ bmp.close(); return blob; }
      const s=maxEdge/le, w=Math.round(bmp.width*s), h=Math.round(bmp.height*s);
      const c=new OffscreenCanvas(w,h);
      const ctx=c.getContext('2d');
      ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
      ctx.drawImage(bmp,0,0,w,h);
      const out=await c.convertToBlob({type:'image/png'});
      bmp.close();
      return out;
    }

    async function runBiRefNet(blob, progressSend){
      const mod=await loadTransformers();
      const { RawImage } = mod;
      const { processor, model } = await ensureBiRefNet(progressSend);
      // Preserve already transparent
      if(await hasTransparency(blob)){
        progressSend(92,'Preserving transparency…');
        const bmp=await createImageBitmap(blob);
        const c=new OffscreenCanvas(bmp.width,bmp.height);
        const ctx=c.getContext('2d'); ctx.drawImage(bmp,0,0);
        const out=await c.convertToBlob({type:'image/png'});
        bmp.close();
        return { blob: out, rawMaskBlob: null, device: birefDevice };
      }
      progressSend(60,'Preprocessing…');
      // Load image via RawImage and via bitmap for final composite dimensions
      let image;
      try{
        image=await RawImage.fromBlob(blob);
      }catch(e){
        // Fallback: create via canvas then RawImage.read?
        const bmp2=await createImageBitmap(blob);
        const c2=new OffscreenCanvas(bmp2.width,bmp2.height);
        const ctx2=c2.getContext('2d'); ctx2.drawImage(bmp2,0,0);
        const blob2=await c2.convertToBlob({type:'image/png'});
        bmp2.close();
        image=await RawImage.fromBlob(blob2);
      }
      const origW=image.width, origH=image.height;
      // Also get full res via bitmap (should match origW/origH, but be safe)
      const fullBmp=await createImageBitmap(blob);
      const fullW=fullBmp.width, fullH=fullBmp.height;

      // Preprocess
      let pixel_values;
      try{
        const out=await processor(image);
        pixel_values=out.pixel_values || out.input_image || out[Object.keys(out)[0]];
        // Some processors return { pixel_values } directly
        if(!pixel_values && out instanceof Object && out.data) pixel_values=out;
      }catch(e){
        throw new Error('Preprocess failed: '+(e?.message||e));
      }
      if(!pixel_values) throw new Error('Processor returned no pixel_values');

      progressSend(72,'Running BiRefNet…');
      let outputs;
      try{
        // BiRefNet expects input_image key
        try{
          outputs=await model({ input_image: pixel_values });
        }catch(e1){
          // fallback to pixel_values key or direct
          try{ outputs=await model({ pixel_values }); }catch(e2){
            outputs=await model(pixel_values);
          }
        }
      }catch(e){
        throw new Error('Model inference failed: '+(e?.message||e));
      }
      progressSend(82,'Processing mask…');
      // Extract tensor: output_image or logits
      let tensor=outputs?.output_image || outputs?.logits || outputs?.pred_masks || outputs?.output || outputs?.[0];
      if(!tensor){
        // Find first tensor-like value
        for(const k of Object.keys(outputs||{})){
          const v=outputs[k];
          if(v && v.data && v.dims){ tensor=v; break; }
          if(v && Array.isArray(v) && v[0] && v[0].data) { tensor=v[0]; break; }
        }
      }
      if(!tensor) throw new Error('No output tensor');
      // Handle batched: tensor may be [1,1,H,W] or [1,H,W]
      // Some outputs are array of tensors
      if(Array.isArray(tensor)) tensor=tensor[0];
      // Tensor shape dims
      const dims=tensor.dims || tensor.shape;
      if(!dims) throw new Error('Tensor dims missing');
      const data=tensor.data;
      // Determine H,W: last two dims
      let h=dims[dims.length-2], w=dims[dims.length-1];
      // If dims like [1,1,1024,1024], h=1024,w=1024. data length should be h*w or 1*h*w
      let flat=data;
      // If data length > h*w, it might be batched (e.g., 1*1*1024*1024 = 1048576)
      // Take last h*w elements if batched
      if(flat.length > h*w){
        flat=flat.slice(flat.length - h*w);
      }
      // Sigmoid
      const maskU8=new Uint8Array(h*w);
      for(let i=0;i<h*w;i++){
        const v=flat[i];
        const sig=1/(1+Math.exp(-v));
        // No threshold: keep soft alpha
        maskU8[i]=Math.round(sig*255);
      }
      // Create mask canvas at model res
      const maskCanvas=new OffscreenCanvas(w,h);
      const mctx=maskCanvas.getContext('2d');
      const imgData=mctx.createImageData(w,h);
      for(let i=0;i<h*w;i++){
        const v=maskU8[i];
        imgData.data[i*4]=v;
        imgData.data[i*4+1]=v;
        imgData.data[i*4+2]=v;
        imgData.data[i*4+3]=255;
      }
      mctx.putImageData(imgData,0,0);
      // Resize to ORIGINAL full-res with bilinear (smooth)
      const fullMaskCanvas=new OffscreenCanvas(fullW, fullH);
      const fctx=fullMaskCanvas.getContext('2d');
      fctx.imageSmoothingEnabled=true;
      fctx.imageSmoothingQuality='high';
      fctx.drawImage(maskCanvas,0,0,w,h,0,0,fullW,fullH);
      const fullMaskData=fctx.getImageData(0,0,fullW,fullH);
      // Create output: original RGB + mask alpha
      const outCanvas=new OffscreenCanvas(fullW, fullH);
      const octx=outCanvas.getContext('2d');
      octx.drawImage(fullBmp,0,0);
      fullBmp.close();
      const outData=octx.getImageData(0,0,fullW,fullH);
      // Use mask's R channel as alpha, keep RGB premultiplied correctly (canvas stores unpremultiplied, browser composites)
      for(let i=0;i<fullW*fullH;i++){
        const maskVal=fullMaskData.data[i*4]; // R
        outData.data[i*4+3]=maskVal;
      }
      octx.putImageData(outData,0,0);
      const outBlob=await outCanvas.convertToBlob({type:'image/png'});
      // Raw mask blob for debug (full-res grayscale)
      const rawMaskBlob=await fullMaskCanvas.convertToBlob({type:'image/png'});
      return { blob: outBlob, rawMaskBlob, device: birefDevice };
    }

    async function runImglyFast(blob, progressSend, quality){
      const fn=await loadImgly();
      if(!fn) throw new Error('Fast model unavailable — check internet for first download (isnet_quint8 ~40 MB, cached offline).');
      const modelOrder = quality==='high' ? ['isnet','isnet_fp16','isnet_quint8'] : ['isnet_quint8','isnet_fp16','isnet'];
      let lastErr=null, outBlob=null;
      const sizeSteps=[null,2048,1536,1024];
      for(const maxEdge of sizeSteps){
        let input=blob;
        if(maxEdge!==null){
          try{ input=await downscaleBlob(blob, maxEdge); progressSend(18,'Retrying at '+maxEdge+'px…'); }catch{}
        }
        for(const model of modelOrder){
          let progInterval;
          try{
            let lastPct=18;
            progInterval=setInterval(()=>{ lastPct=Math.min(85,lastPct+1.2); progressSend(lastPct,'Segmenting ('+model+')…'); },600);
            const res=await fn(input,{
              model,
              output:{format:'image/png', quality:0.92},
              progress:(k,c,t)=>{
                const pct=20+Math.round(c/t*60);
                const msg=String(k).toLowerCase().includes('model')||String(k).toLowerCase().includes('fetch')||String(k).toLowerCase().includes('download')
                  ? 'Downloading '+model+'…'
                  : 'Segmenting foreground ('+model+')…';
                progressSend(pct, msg);
              }
            });
            clearInterval(progInterval);
            let b=res instanceof Blob?res:new Blob([res],{type:'image/png'});
            if(!b || b.size<2000) throw new Error('Empty result');
            try{
              const bmp=await createImageBitmap(b);
              const c=new OffscreenCanvas(Math.min(bmp.width,64), Math.min(bmp.height,64));
              const ctx=c.getContext('2d'); ctx.drawImage(bmp,0,0,c.width,c.height);
              const d=ctx.getImageData(0,0,c.width,c.height).data;
              let tr=0; for(let i=3;i<d.length;i+=4) if(d[i]<250) tr++;
              bmp.close();
              if(tr/(d.length/4) < 0.02) throw new Error('No transparency produced');
            }catch(ve){ if(String(ve.message).includes('No transparency')) throw ve; }
            outBlob=b; lastErr=null; break;
          }catch(err){
            if(progInterval) clearInterval(progInterval);
            const msg=err?.message||String(err);
            if(isOOM(err)){ progressSend(55,'Out of memory at '+(maxEdge||'full-res')+', retrying smaller…'); lastErr=err; break; }
            if(String(msg).includes('No transparency')){ lastErr=err; break; }
            lastErr=err; progressSend(60,model+' failed, trying next…'); continue;
          }
        }
        if(outBlob) break;
      }
      if(!outBlob) throw lastErr||new Error('All Fast models failed');
      progressSend(92,'Finalizing…');
      return { blob: outBlob, rawMaskBlob: null };
    }

    self.onmessage=async(e)=>{
      const {id, blob, quality}=e.data;
      const q=quality==='fast' ? 'fast' : 'high';
      const send=(m)=>self.postMessage({id, ...m});
      try{
        if(!(blob instanceof Blob) || blob.size===0) throw new Error('Invalid image');
        send({type:'progress', pct:5, msg:'Preparing image…'});
        if(await hasTransparency(blob)){
          send({type:'progress', pct:92, msg:'Preserving transparency…'});
          try{
            const bmp=await createImageBitmap(blob);
            const c=new OffscreenCanvas(bmp.width,bmp.height);
            const ctx=c.getContext('2d'); ctx.drawImage(bmp,0,0);
            const out=await c.convertToBlob({type:'image/png'});
            bmp.close(); send({type:'done', blob:out, rawMaskBlob:null}); return;
          }catch{ send({type:'done', blob:blob, rawMaskBlob:null}); return; }
        }
        if(q==='high'){
          // Try BiRefNet first
          try{
            send({type:'progress', pct:10, msg:'Loading BiRefNet lite…'});
            const res=await runBiRefNet(blob, (pct,msg)=> send({type:'progress', pct, msg}));
            send({type:'progress', pct:94, msg:'Finalizing…'});
            send({type:'done', blob:res.blob, rawMaskBlob:res.rawMaskBlob, device: res.device});
            return;
          }catch(err){
            const msg=err?.message||String(err);
            // If OOM or load failure, fallback to Fast with clear message
            if(isOOM(err)){
              send({type:'progress', pct:50, msg:'BiRefNet out of memory, falling back to Fast…'});
            }else{
              send({type:'progress', pct:50, msg:'BiRefNet failed ('+msg.slice(0,60)+'), fallback to Fast…'});
            }
            try{
              const res2=await runImglyFast(blob, (pct,m)=> send({type:'progress', pct, msg:m}), 'fast');
              send({type:'progress', pct:94, msg:'Fallback done (Fast)'});
              send({type:'done', blob:res2.blob, rawMaskBlob:null, fallback:true, fallbackReason: msg});
              return;
            }catch(e2){
              throw new Error('High (BiRefNet) failed: '+msg+' | Fast fallback also failed: '+(e2?.message||e2));
            }
          }
        }else{
          // Fast only
          send({type:'progress', pct:15, msg:'Loading Fast model…'});
          const res=await runImglyFast(blob, (pct,m)=> send({type:'progress', pct, msg:m}), 'fast');
          send({type:'done', blob:res.blob, rawMaskBlob:null});
          return;
        }
      }catch(err){
        send({type:'error', error: err?.message||String(err)});
      }
    };
  `;
  const blob = new Blob([code], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  return new Worker(url, { type: "module" });
}

export function getWorker(): Worker {
  if (typeof window === "undefined") throw new Error("Worker only in browser");
  if (!workerInstance) workerInstance = createWorker();
  return workerInstance;
}

export async function removeBackgroundViaWorker(
  fileOrBlob: Blob,
  onProgress: ProgressCb,
  signal?: AbortSignal,
  quality: Quality = "high"
): Promise<Blob> {
  if (!(fileOrBlob instanceof Blob)) throw new Error("Invalid image blob");
  if (fileOrBlob.size === 0) throw new Error("Empty file");
  const t = (fileOrBlob as File).type || "";
  if (t && !t.startsWith("image/")) throw new Error("Invalid type: " + t);

  // Preserve already-transparent (no ML needed)
  try {
    const bmp = await createImageBitmap(fileOrBlob);
    const w = Math.min(bmp.width, 64), h = Math.min(bmp.height, 64);
    const c = document.createElement("canvas"); c.width=w; c.height=h;
    const ctx=c.getContext("2d")!; ctx.drawImage(bmp,0,0,w,h);
    const d=ctx.getImageData(0,0,w,h).data;
    let tr=0; for(let i=3;i<d.length;i+=4) if(d[i]<250) tr++;
    bmp.close();
    if(tr/(d.length/4)>0.08){
      onProgress(95,"Preserving transparency…");
      const full=await createImageBitmap(fileOrBlob);
      const cc=document.createElement("canvas"); cc.width=full.width; cc.height=full.height;
      cc.getContext("2d")!.drawImage(full,0,0); full.close();
      return await new Promise<Blob>((res,rej)=> cc.toBlob(b=> b?res(b):rej(new Error("toBlob failed")),"image/png"));
    }
  }catch{}

  const worker=getWorker();
  return await new Promise<Blob>((resolve,reject)=>{
    const id=Math.random().toString(36).slice(2);
    let rawMaskBlobForDebug: Blob | null = null;
    const onMessage=(e:MessageEvent)=>{
      if(e.data.id!==id) return;
      if(e.data.type==="progress") onProgress(Math.round(e.data.pct), e.data.msg);
      else if(e.data.type==="done"){
        cleanup();
        // Store raw mask blob globally for debug view if present
        if(e.data.rawMaskBlob){
          try{ (globalThis as any).__erasebgRawMaskBlob = e.data.rawMaskBlob; }catch{}
          // Also dispatch event so UI can pick it up
          try{ window.dispatchEvent(new CustomEvent('erasebg-rawmask', {detail:e.data.rawMaskBlob})); }catch{}
        }
        if(e.data.fallback){
          try{ onProgress(88, "Used Fast fallback — High failed on this device"); }catch{}
        }
        resolve(e.data.blob as Blob);
      }
      else if(e.data.type==="error"){ cleanup(); reject(new Error(e.data.error||"Failed")); }
    };
    const onError=(err:ErrorEvent)=>{ cleanup(); reject(err.error||new Error("Worker error")); };
    const cleanup=()=>{
      worker.removeEventListener("message",onMessage);
      worker.removeEventListener("error",onError);
      if(signal) signal.removeEventListener("abort",onAbort);
    };
    const onAbort=()=>{ cleanup(); reject(new DOMException("Aborted","AbortError")); };
    worker.addEventListener("message",onMessage);
    worker.addEventListener("error",onError);
    if(signal) signal.addEventListener("abort",onAbort);
    worker.postMessage({id, blob:fileOrBlob, quality});
  });
}

export function isFirstTime(): boolean {
  try { return localStorage.getItem("erasebg-model-cached")!=="1"; } catch { return true; }
}
export function markModelCached(){ try{localStorage.setItem("erasebg-model-cached","1");}catch{} }

// For debug view: retrieve last raw mask blob if worker provided it
export function getLastRawMaskBlob(): Blob | null {
  try{ return (globalThis as any).__erasebgRawMaskBlob || null; }catch{ return null; }
}

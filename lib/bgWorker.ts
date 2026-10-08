"use client";
// Unified: BiRefNet lite (High) + @imgly isnet_quint8 (Fast fallback)
// - High = onnx-community/BiRefNet_lite (AutoModel+AutoProcessor), 1024px on WebGPU, 512px on WASM
// - Backend auto: WebGPU fp32 first (avoid fp16 corruption), else WASM 512px
// - Pipeline: RawImage -> processor -> model({input_image: pixel_values}) -> output_image.sigmoid -> bilinear resize to ORIGINAL -> alpha
// - No threshold/erosion/blur

export type ProgressCb = (pct: number, msg?: string) => void;
export type Quality = "high" | "fast";

let workerInstance: Worker | null = null;

function createWorker(): Worker {
  const code = `
    let transformersMod = null;
    let birefProcessor = null;
    let birefModel = null;
    let birefDevice = null;
    let birefDtype = null;
    let currentModelId = null;
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

    function hasWebGPU(){
      try{
        // WorkerNavigator.gpu or navigator.gpu
        if(typeof navigator !== 'undefined' && navigator.gpu) return true;
        if(typeof self !== 'undefined' && self.navigator && self.navigator.gpu) return true;
        // Also check env
        if(transformersMod && transformersMod.env && transformersMod.env.backends && transformersMod.env.backends.onnx && transformersMod.env.backends.onnx.webgpu) return true;
      }catch{}
      return false;
    }

    async function ensureBiRefNet(progressSend){
      if(birefModel && birefProcessor) return {processor:birefProcessor, model:birefModel, device:birefDevice, dtype:birefDtype, modelId: currentModelId};
      const mod=await loadTransformers();
      const { env, AutoModel, AutoProcessor } = mod;
      // Decide modelId based on backend
      const useWebGPU = hasWebGPU();
      // Available ONNX files per model page: onnx-community/BiRefNet_lite-ONNX has onnx/model.onnx (~172MB q8 ~90MB) + onnx/model_fp16.onnx
      // 512 build is onnx-community/BiRefNet_512x512-ONNX (smaller, WASM-friendly)
      const candidates = useWebGPU
        ? [{id:'onnx-community/BiRefNet_lite', label:'BiRefNet_lite 1024 WebGPU'}, {id:'onnx-community/BiRefNet_lite-ONNX', label:'BiRefNet_lite-ONNX 1024 WebGPU'}]
        : [{id:'onnx-community/BiRefNet_512x512-ONNX', label:'BiRefNet 512 WASM'}, {id:'onnx-community/BiRefNet_lite', label:'BiRefNet_lite 1024 WASM fallback'}];
      // dtype/device attempts
      const attempts = useWebGPU
        ? [{device:'webgpu', dtype:'fp32', label:'WebGPU fp32'}, {device:'webgpu', dtype:'fp16', label:'WebGPU fp16 (check corruption)'}]
        : [{device:'wasm', dtype:'fp32', label:'WASM fp32 512'}, {device:'wasm', dtype:'q8', label:'WASM q8 512'}, {device:'wasm', dtype:'fp16', label:'WASM fp16'}];
      let lastErr=null;
      for(const cand of candidates){
        for(const att of attempts){
          try{
            progressSend(12, 'Loading BiRefNet lite ('+att.label+')…');
            const progress_callback = (data)=>{
              try{
                if(data.status==='progress' && data.file){
                  const pct=Math.round(data.progress||0);
                  // single progress number 10-60
                  const single=10+Math.round(pct*0.5);
                  progressSend(single, 'Downloading BiRefNet… '+pct+'%');
                } else if(String(data.status).includes('download')){
                  progressSend(15, 'Downloading BiRefNet…');
                }
              }catch{}
            };
            const processor=await AutoProcessor.from_pretrained(cand.id, { progress_callback });
            const model=await AutoModel.from_pretrained(cand.id, {
              device: att.device,
              dtype: att.dtype,
              progress_callback,
            });
            birefProcessor=processor;
            birefModel=model;
            birefDevice=att.device;
            birefDtype=att.dtype;
            currentModelId=cand.id;
            progressSend(60, 'BiRefNet ready ('+att.label+')');
            return {processor, model, device: att.device, dtype: att.dtype, modelId: cand.id};
          }catch(e){
            lastErr=e;
            // if fp16 corrupted, next attempt is fp32 already tried first, so continue
            continue;
          }
        }
      }
      throw lastErr||new Error('BiRefNet lite failed to load');
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
      const { processor, model, device } = await ensureBiRefNet(progressSend);
      if(await hasTransparency(blob)){
        progressSend(92,'Preserving transparency…');
        const bmp=await createImageBitmap(blob);
        const c=new OffscreenCanvas(bmp.width,bmp.height);
        const ctx=c.getContext('2d'); ctx.drawImage(bmp,0,0);
        const out=await c.convertToBlob({type:'image/png'});
        bmp.close();
        return { blob: out, rawMaskBlob: null, device };
      }
      progressSend(65,'Preprocessing…');
      const image=await RawImage.fromBlob(blob);
      const origW=image.width, origH=image.height;
      const fullBmp=await createImageBitmap(blob);
      const fullW=fullBmp.width, fullH=fullBmp.height;
      let pixel_values;
      try{
        const out=await processor(image);
        pixel_values=out.pixel_values || out.input_image || out[Object.keys(out)[0]];
        if(!pixel_values && out && out.data) pixel_values=out;
      }catch(e){ throw new Error('Preprocess failed: '+(e?.message||e)); }
      if(!pixel_values) throw new Error('Processor returned no pixel_values');
      progressSend(74,'Running BiRefNet…');
      let outputs;
      try{
        try{
          outputs=await model({ input_image: pixel_values });
        }catch(e1){
          try{ outputs=await model({ pixel_values }); }catch(e2){
            outputs=await model(pixel_values);
          }
        }
      }catch(e){ throw new Error('Inference failed: '+(e?.message||e)); }
      progressSend(86,'Processing mask…');
      let tensor=outputs?.output_image || outputs?.logits || outputs?.pred_masks || outputs?.output || outputs?.[0];
      if(!tensor){
        for(const k of Object.keys(outputs||{})){
          const v=outputs[k];
          if(v && v.data && v.dims){ tensor=v; break; }
          if(v && Array.isArray(v) && v[0] && v[0].data) { tensor=v[0]; break; }
        }
      }
      if(!tensor) throw new Error('No output tensor');
      if(Array.isArray(tensor)) tensor=tensor[0];
      const dims=tensor.dims || tensor.shape;
      if(!dims) throw new Error('Tensor dims missing');
      const data=tensor.data;
      let h=dims[dims.length-2], w=dims[dims.length-1];
      let flat=data;
      if(flat.length > h*w){
        flat=flat.slice(flat.length - h*w);
      }
      // Check for fp16 corruption: if many NaN or all same, treat as corrupted and retry with fp32 (handled by outer fallback)
      let corrupted=false;
      if(device==='webgpu'){
        let nanCount=0;
        for(let i=0;i<Math.min(1000, flat.length); i++) if(isNaN(flat[i])) nanCount++;
        if(nanCount>10) corrupted=true;
      }
      if(corrupted) throw new Error('WebGPU fp16 output corrupted, need fp32');
      const maskU8=new Uint8Array(h*w);
      for(let i=0;i<h*w;i++){
        const v=flat[i];
        const sig=1/(1+Math.exp(-v));
        maskU8[i]=Math.round(sig*255);
      }
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
      const fullMaskCanvas=new OffscreenCanvas(fullW, fullH);
      const fctx=fullMaskCanvas.getContext('2d');
      fctx.imageSmoothingEnabled=true;
      fctx.imageSmoothingQuality='high';
      fctx.drawImage(maskCanvas,0,0,w,h,0,0,fullW,fullH);
      const fullMaskData=fctx.getImageData(0,0,fullW,fullH);
      const outCanvas=new OffscreenCanvas(fullW, fullH);
      const octx=outCanvas.getContext('2d');
      octx.drawImage(fullBmp,0,0);
      fullBmp.close();
      const outData=octx.getImageData(0,0,fullW,fullH);
      for(let i=0;i<fullW*fullH;i++){
        const maskVal=fullMaskData.data[i*4];
        outData.data[i*4+3]=maskVal;
      }
      octx.putImageData(outData,0,0);
      const outBlob=await outCanvas.convertToBlob({type:'image/png'});
      const rawMaskBlob=await fullMaskCanvas.convertToBlob({type:'image/png'});
      return { blob: outBlob, rawMaskBlob, device, modelId: currentModelId };
    }

    async function runImglyFast(blob, progressSend, quality){
      const fn=await loadImgly();
      if(!fn) throw new Error('Fast model unavailable');
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
                  : 'Segmenting ('+model+')…';
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
          try{
            send({type:'progress', pct:10, msg:'Loading BiRefNet lite…'});
            const res=await runBiRefNet(blob, (pct,msg)=> send({type:'progress', pct, msg}));
            send({type:'progress', pct:94, msg:'Finalizing…'});
            send({type:'done', blob:res.blob, rawMaskBlob:res.rawMaskBlob, device: res.device, modelId: res.modelId});
            return;
          }catch(err){
            const msg=err?.message||String(err);
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
              throw new Error('High (BiRefNet) failed: '+msg+' | Fast also failed: '+(e2?.message||e2));
            }
          }
        }else{
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
    const onMessage=(e:MessageEvent)=>{
      if(e.data.id!==id) return;
      if(e.data.type==="progress") onProgress(Math.round(e.data.pct), e.data.msg);
      else if(e.data.type==="done"){
        cleanup();
        if(e.data.rawMaskBlob){
          try{ (globalThis as any).__erasebgRawMaskBlob = e.data.rawMaskBlob; }catch{}
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

export function getLastRawMaskBlob(): Blob | null {
  try{ return (globalThis as any).__erasebgRawMaskBlob || null; }catch{ return null; }
}

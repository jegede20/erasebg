"use client";
// Unified background removal: ormbg (High, Apache-2.0, CNN, reliable) + @imgly (Fast fallback)
// - High default = onnx-community/ormbg-ONNX via @huggingface/transformers pipeline('background-removal') inside Web Worker
// - Fast = @imgly/background-removal isnet_quint8
// - WASM first (reliable), WebGPU fallback, auto-fallback to Fast on failure
// - Pipeline: RawImage.fromBlob -> segmenter(image) -> RGBA with alpha (no threshold/blur)

export type ProgressCb = (pct: number, msg?: string) => void;
export type Quality = "high" | "fast";

let workerInstance: Worker | null = null;

function createWorker(): Worker {
  const code = `
    let transformersMod = null;
    let segmenter = null;
    let segmenterDevice = null;
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
          if(mod.env && mod.pipeline && mod.RawImage){
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

    async function ensureOrmbg(progressSend){
      if(segmenter) return segmenter;
      const mod=await loadTransformers();
      const { pipeline } = mod;
      const modelId='onnx-community/ormbg-ONNX';
      const progress_callback = (data)=>{
        try{
          if(data.status==='progress' && data.file){
            const pct=Math.round(data.progress||0);
            progressSend(10+Math.round(pct*0.5), 'Downloading ormbg '+data.file+'… '+pct+'%');
          } else if(String(data.status).includes('download')){
            progressSend(15, 'Downloading ormbg…');
          } else if(data.status==='ready' || data.status==='done'){
            progressSend(55, 'ormbg cached');
          }
        }catch{}
      };
      // Try WASM first (most reliable for CNN), then WebGPU
      const attempts=[
        {device:'wasm', dtype:'fp32', label:'WASM fp32'},
        {device:'wasm', dtype:'q8', label:'WASM q8'},
        {device:'webgpu', dtype:'fp32', label:'WebGPU fp32'},
        {device:'webgpu', dtype:'fp16', label:'WebGPU fp16'},
      ];
      let lastErr=null;
      for(const att of attempts){
        try{
          progressSend(12, 'Loading ormbg ('+att.label+')…');
          const seg=await pipeline('background-removal', modelId, {
            device: att.device,
            dtype: att.dtype,
            progress_callback,
          });
          segmenter=seg;
          segmenterDevice=att.device;
          progressSend(60, 'ormbg ready ('+att.label+')');
          return seg;
        }catch(e){
          lastErr=e;
          progressSend(20, att.label+' not available, trying fallback…');
        }
      }
      throw lastErr||new Error('ormbg failed to load');
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

    async function runOrmbg(blob, progressSend){
      const mod=await loadTransformers();
      const { RawImage } = mod;
      const seg=await ensureOrmbg(progressSend);
      if(await hasTransparency(blob)){
        progressSend(92,'Preserving transparency…');
        const bmp=await createImageBitmap(blob);
        const c=new OffscreenCanvas(bmp.width,bmp.height);
        const ctx=c.getContext('2d'); ctx.drawImage(bmp,0,0);
        const out=await c.convertToBlob({type:'image/png'});
        bmp.close();
        return { blob: out, rawMaskBlob: null, device: segmenterDevice };
      }
      progressSend(65,'Preprocessing…');
      const image=await RawImage.fromBlob(blob);
      progressSend(72,'Running ormbg…');
      let outputs;
      try{
        outputs=await seg(image);
      }catch(e){
        throw new Error('Model inference failed: '+(e?.message||e));
      }
      progressSend(84,'Processing mask…');
      // outputs is RawImage or array
      let outImage = Array.isArray(outputs) ? outputs[0] : outputs;
      // Some pipeline returns {image} wrapper?
      if(outImage && outImage.image) outImage = outImage.image;
      if(!outImage || !outImage.data || !outImage.width){
        // Try to handle different return shapes
        if(outputs && outputs.data && outputs.width) outImage = outputs;
        else throw new Error('No output image');
      }
      // outImage is RawImage with RGBA, already at original size with alpha
      // Convert to blob via OffscreenCanvas
      const w=outImage.width, h=outImage.height;
      const canvas=new OffscreenCanvas(w,h);
      const ctx=canvas.getContext('2d');
      const imgData=ctx.createImageData(w,h);
      // outImage.data is Uint8Array RGBA
      imgData.data.set(outImage.data);
      ctx.putImageData(imgData,0,0);
      const outBlob=await canvas.convertToBlob({type:'image/png'});
      // Build raw mask for debug (grayscale from alpha)
      const maskCanvas=new OffscreenCanvas(w,h);
      const mctx=maskCanvas.getContext('2d');
      const maskData=mctx.createImageData(w,h);
      for(let i=0;i<w*h;i++){
        const a=outImage.data[i*4+3];
        maskData.data[i*4]=a;
        maskData.data[i*4+1]=a;
        maskData.data[i*4+2]=a;
        maskData.data[i*4+3]=255;
      }
      mctx.putImageData(maskData,0,0);
      const rawMaskBlob=await maskCanvas.convertToBlob({type:'image/png'});
      return { blob: outBlob, rawMaskBlob, device: segmenterDevice };
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
          try{
            send({type:'progress', pct:10, msg:'Loading ormbg…'});
            const res=await runOrmbg(blob, (pct,msg)=> send({type:'progress', pct, msg}));
            send({type:'progress', pct:94, msg:'Finalizing…'});
            send({type:'done', blob:res.blob, rawMaskBlob:res.rawMaskBlob, device: res.device});
            return;
          }catch(err){
            const msg=err?.message||String(err);
            if(isOOM(err)){
              send({type:'progress', pct:50, msg:'ormbg out of memory, falling back to Fast…'});
            }else{
              send({type:'progress', pct:50, msg:'ormbg failed ('+msg.slice(0,60)+'), fallback to Fast…'});
            }
            try{
              const res2=await runImglyFast(blob, (pct,m)=> send({type:'progress', pct, msg:m}), 'fast');
              send({type:'progress', pct:94, msg:'Fallback done (Fast)'});
              send({type:'done', blob:res2.blob, rawMaskBlob:null, fallback:true, fallbackReason: msg});
              return;
            }catch(e2){
              throw new Error('High (ormbg) failed: '+msg+' | Fast fallback also failed: '+(e2?.message||e2));
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

"use client";
// Unified: isnet (clean cut) primary — no leftover bg, no subject cropping
// - Fast/Clean = @imgly/background-removal isnet (full) > isnet_fp16 > isnet_quint8 fallback
// - BiRefNet lite kept as optional High (WebGPU 1024 / WASM 512) but default is isnet for reliability
// - Real download progress only, inference shows indeterminate spinner
// - Multi-threaded WASM via COOP/COEP headers, timeout 90s fallback

export type ProgressCb = (pct: number | null, msg?: string) => void;
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
              const isIsolated = typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false;
              console.log('[BiRefNet] crossOriginIsolated:', isIsolated, 'hardwareConcurrency:', (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 'unknown'));
              if(mod.env.backends && mod.env.backends.onnx && mod.env.backends.onnx.wasm){
                // Enable multi-thread + SIMD when isolated
                if(isIsolated){
                  mod.env.backends.onnx.wasm.numThreads = Math.min(4, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4));
                  mod.env.backends.onnx.wasm.simd = true;
                } else {
                  mod.env.backends.onnx.wasm.numThreads = 1;
                }
                mod.env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/';
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
        if(typeof navigator !== 'undefined' && navigator.gpu) return true;
        if(typeof self !== 'undefined' && self.navigator && self.navigator.gpu) return true;
      }catch{}
      return false;
    }

    async function ensureBiRefNet(progressSend){
      if(birefModel && birefProcessor) return {processor:birefProcessor, model:birefModel, device:birefDevice, dtype:birefDtype, modelId: currentModelId};
      const mod=await loadTransformers();
      const { AutoModel, AutoProcessor } = mod;
      const useWebGPU = hasWebGPU();
      console.log('[BiRefNet] hasWebGPU:', useWebGPU);
      // NEVER use 1024 on WASM — only 512 on WASM
      const modelId = useWebGPU ? 'onnx-community/BiRefNet_lite' : 'onnx-community/BiRefNet_512x512-ONNX';
      const fallbackId = useWebGPU ? 'onnx-community/BiRefNet_lite-ONNX' : null;
      const attempts = useWebGPU
        ? [{device:'webgpu', dtype:'fp32', label:'WebGPU fp32 1024'}, {device:'webgpu', dtype:'fp16', label:'WebGPU fp16 1024'}]
        : [{device:'wasm', dtype:'q8', label:'WASM q8 512'}, {device:'wasm', dtype:'fp32', label:'WASM fp32 512'}, {device:'wasm', dtype:'fp16', label:'WASM fp16 512'}];
      let lastErr=null;
      for(const att of attempts){
        const tryIds = fallbackId ? [modelId, fallbackId] : [modelId];
        for(const id of tryIds){
          try{
            console.time('[BiRefNet] load '+id+' '+att.label);
            progressSend(12, 'Loading BiRefNet lite ('+att.label+')…');
            const progress_callback = (data)=>{
              try{
                if(data.status==='progress' && data.file){
                  const pct=Math.round(data.progress||0);
                  const single=10+Math.round(pct*0.5);
                  // Real download progress only
                  progressSend(single, 'Downloading BiRefNet… '+pct+'%');
                  console.log('[BiRefNet] download', data.file, pct+'%');
                }
              }catch{}
            };
            const processor=await AutoProcessor.from_pretrained(id, { progress_callback });
            const model=await AutoModel.from_pretrained(id, {
              device: att.device,
              dtype: att.dtype,
              progress_callback,
            });
            console.timeEnd('[BiRefNet] load '+id+' '+att.label);
            birefProcessor=processor;
            birefModel=model;
            birefDevice=att.device;
            birefDtype=att.dtype;
            currentModelId=id;
            // During inference we will show indeterminate spinner, not fake %
            progressSend(null, 'Removing background, this can take up to a minute on phones');
            return {processor, model, device: att.device, dtype: att.dtype, modelId: id};
          }catch(e){
            lastErr=e;
            console.warn('[BiRefNet] failed', id, att.label, e?.message||e);
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

    async function runBiRefNet(blob, progressSend){
      const t0=performance.now();
      const mod=await loadTransformers();
      const { RawImage } = mod;
      console.time('[BiRefNet] ensure');
      const { processor, model, device } = await ensureBiRefNet(progressSend);
      console.timeEnd('[BiRefNet] ensure');
      console.log('[BiRefNet] device', device, 'crossOriginIsolated', typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : 'unknown');
      if(await hasTransparency(blob)){
        progressSend(95,'Preserving transparency…');
        const bmp=await createImageBitmap(blob);
        const c=new OffscreenCanvas(bmp.width,bmp.height);
        const ctx=c.getContext('2d'); ctx.drawImage(bmp,0,0);
        const out=await c.convertToBlob({type:'image/png'});
        bmp.close();
        return { blob: out, rawMaskBlob: null, device };
      }
      const tp0=performance.now();
      console.time('[BiRefNet] preprocess');
      progressSend(null,'Removing background, this can take up to a minute on phones');
      const image=await RawImage.fromBlob(blob);
      const origW=image.width, origH=image.height;
      const fullBmp=await createImageBitmap(blob);
      const fullW=fullBmp.width, fullH=fullBmp.height;
      // On WASM we already use 512 model, so input is limited to 512 naturally via processor
      let pixel_values;
      try{
        const out=await processor(image);
        pixel_values=out.pixel_values || out.input_image || out[Object.keys(out)[0]];
        if(!pixel_values && out && out.data) pixel_values=out;
      }catch(e){ throw new Error('Preprocess failed: '+(e?.message||e)); }
      if(!pixel_values) throw new Error('Processor returned no pixel_values');
      console.timeEnd('[BiRefNet] preprocess');
      console.log('[BiRefNet] preprocess', Math.round(performance.now()-tp0)+'ms', 'input', pixel_values.dims || pixel_values.shape, 'orig', origW+'x'+origH);

      const ti0=performance.now();
      console.time('[BiRefNet] inference');
      // Indeterminate spinner during inference
      progressSend(null,'Removing background, this can take up to a minute on phones');
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
      console.timeEnd('[BiRefNet] inference');
      console.log('[BiRefNet] inference', Math.round(performance.now()-ti0)+'ms');

      const tp1=performance.now();
      console.time('[BiRefNet] postprocess');
      progressSend(null,'Removing background, this can take up to a minute on phones');
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
      console.timeEnd('[BiRefNet] postprocess');
      console.log('[BiRefNet] postprocess', Math.round(performance.now()-tp1)+'ms', 'total', Math.round(performance.now()-t0)+'ms');
      return { blob: outBlob, rawMaskBlob, device, modelId: currentModelId };
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
    // Edge preservation: add transparent padding so subjects at image border aren't clipped, then feather-expand 1-2px to fix flat wrist/bottom cuts
    async function padBlob(blob, pad){
      const bmp=await createImageBitmap(blob);
      const c=new OffscreenCanvas(bmp.width+pad*2, bmp.height+pad*2);
      const ctx=c.getContext('2d');
      ctx.clearRect(0,0,c.width,c.height);
      ctx.drawImage(bmp, pad, pad);
      const out=await c.convertToBlob({type:'image/png'});
      const w=bmp.width, h=bmp.height;
      bmp.close();
      return {blob:out, w, h, pad};
    }
    async function unpadBlob(paddedBlob, pad, origW, origH){
      const bmp=await createImageBitmap(paddedBlob);
      const c=new OffscreenCanvas(origW, origH);
      const ctx=c.getContext('2d');
      // Handle case where model resized output (should be padded size). Scale then crop.
      const expectedW = origW + pad*2;
      const expectedH = origH + pad*2;
      if(bmp.width===expectedW && bmp.height===expectedH){
        ctx.drawImage(bmp, -pad, -pad);
      } else {
        // Scale to expected padded size then crop
        const scale = Math.min(bmp.width/expectedW, bmp.height/expectedH);
        // Draw scaled padded image and offset by pad
        const drawW = expectedW * scale;
        const drawH = expectedH * scale;
        const offX = (bmp.width - drawW)/2;
        const offY = (bmp.height - drawH)/2;
        // Extract central orig region
        ctx.drawImage(bmp, offX + pad*scale, offY + pad*scale, origW*scale, origH*scale, 0, 0, origW, origH);
      }
      const out=await c.convertToBlob({type:'image/png'});
      bmp.close();
      return out;
    }
    async function featherExpandEdge(blob){
      // Soft 2px dilation to restore flat bottom/wrist cuts — feathered, not hard halo
      try{
        const bmp=await createImageBitmap(blob);
        const c=new OffscreenCanvas(bmp.width, bmp.height);
        const ctx=c.getContext('2d');
        ctx.drawImage(bmp,0,0);
        const img=ctx.getImageData(0,0,c.width,c.height);
        const d=img.data, w=c.width, h=c.height;
        const copy=new Uint8Array(d);
        // 2px radius soft expand: for transparent pixels near opaque, add feathered alpha
        for(let y=0;y<h;y++){
          for(let x=0;x<w;x++){
            const i=(y*w+x)*4;
            if(d[i+3] > 20) continue; // already opaque/feathered
            let maxA=0;
            for(let dy=-2; dy<=2; dy++){
              for(let dx=-2; dx<=2; dx++){
                if(dx===0&&dy===0) continue;
                const nx=x+dx, ny=y+dy;
                if(nx<0||ny<0||nx>=w||ny>=h) continue;
                const ni=(ny*w+nx)*4;
                const a=copy[ni+3];
                if(a>150){
                  const dist=Math.sqrt(dx*dx+dy*dy);
                  const feather = dist<=1 ? 90 : dist<=1.5 ? 55 : 30;
                  if(feather>maxA) maxA=feather;
                } else if(a>80){
                  if(35>maxA) maxA=35;
                }
              }
            }
            if(maxA>0){
              // copy color from nearest opaque neighbor
              let best=null, bestDist=99;
              for(let dy=-2; dy<=2; dy++){
                for(let dx=-2; dx<=2; dx++){
                  const nx=x+dx, ny=y+dy;
                  if(nx<0||ny<0||nx>=w||ny>=h) continue;
                  const ni=(ny*w+nx)*4;
                  if(copy[ni+3]>150){
                    const dist=Math.abs(dx)+Math.abs(dy);
                    if(dist<bestDist){ bestDist=dist; best=ni; }
                  }
                }
              }
              if(best!==null){
                d[i]=copy[best];
                d[i+1]=copy[best+1];
                d[i+2]=copy[best+2];
                d[i+3]=maxA;
              }
            }
          }
        }
        ctx.putImageData(img,0,0);
        const out=await c.convertToBlob({type:'image/png'});
        bmp.close();
        return out;
      }catch{ return blob; }
    }

    async function runImglyFast(blob, progressSend, quality){
      const fn=await loadImgly();
      if(!fn) throw new Error('Fast model unavailable');
      // QUALITY: always try best first — isnet (full) preserves hair/edges without cutting, quint8 is fallback for low RAM
      const modelOrder = ['isnet','isnet_fp16','isnet_quint8'];
      let lastErr=null, outBlob=null;
      const sizeSteps=[null,2048,1536,1024];
      for(const maxEdge of sizeSteps){
        let input=blob;
        let padInfo=null;
        if(maxEdge!==null){
          try{ input=await downscaleBlob(blob, maxEdge); progressSend(18,'Retrying at '+maxEdge+'px…'); }catch{}
        }
        // Pad 16px transparent border to prevent edge clipping (hand at image border)
        try{
          const bmpTmp=await createImageBitmap(input);
          const iw=bmpTmp.width, ih=bmpTmp.height;
          bmpTmp.close();
          padInfo=await padBlob(input, 16);
          input=padInfo.blob;
        }catch{}
        for(const model of modelOrder){
          try{
            const res=await fn(input,{
              model,
              output:{format:'image/png', quality:0.92},
              progress:(k,c,t)=>{
                const pct=20+Math.round(c/t*60);
                const msg=String(k).toLowerCase().includes('model')
                  ? 'Downloading '+model+'…'
                  : 'Segmenting…';
                progressSend(pct, msg);
              }
            });
            let b=res instanceof Blob?res:new Blob([res],{type:'image/png'});
            if(!b || b.size<2000) throw new Error('Empty result');
            // Unpad to original size before checks
            if(padInfo){
              try{ b=await unpadBlob(b, padInfo.pad, padInfo.w, padInfo.h); }catch{}
            }
            // Feather expand 1-2px to fix flat cuts (wrist bottom)
            try{ b=await featherExpandEdge(b); }catch{}
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
            const msg=err?.message||String(err);
            if(isOOM(err)){ progressSend(55,'Out of memory at '+(maxEdge||'full-res')+', retrying smaller…'); lastErr=err; break; }
            if(String(msg).includes('No transparency')){ lastErr=err; break; }
            lastErr=err; continue;
          }
        }
        if(outBlob) break;
      }
      if(!outBlob) throw lastErr||new Error('All Fast models failed');
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
          send({type:'progress', pct:95, msg:'Preserving transparency…'});
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
            // Add 90s timeout for whole BiRefNet path
            const timeoutPromise=new Promise((_,rej)=> setTimeout(()=> rej(new Error('Timeout after 90s')), 90000));
            const res=await Promise.race([runBiRefNet(blob, (pct,msg)=> send({type:'progress', pct, msg})), timeoutPromise]);
            send({type:'progress', pct:95, msg:'Finalizing…'});
            send({type:'done', blob:res.blob, rawMaskBlob:res.rawMaskBlob, device: res.device, modelId: res.modelId});
            return;
          }catch(err){
            const msg=err?.message||String(err);
            const isTimeout=msg.includes('Timeout');
            if(isOOM(err) || isTimeout){
              send({type:'progress', pct:50, msg: (isTimeout?'Timed out after 90s, ':'') + 'Falling back to Fast…'});
            }else{
              send({type:'progress', pct:50, msg:'BiRefNet failed, fallback to Fast…'});
            }
            console.warn('[BiRefNet] fallback to Fast due to', msg);
            try{
              const res2=await runImglyFast(blob, (pct,m)=> send({type:'progress', pct, msg:m}), 'fast');
              send({type:'progress', pct:95, msg:'Fallback done (Fast)'});
              send({type:'done', blob:res2.blob, rawMaskBlob:null, fallback:true, fallbackReason: msg});
              return;
            }catch(e2){
              throw new Error('High failed: '+msg+' | Fast also failed: '+(e2?.message||e2));
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
      if(e.data.type==="progress") onProgress(e.data.pct as number | null, e.data.msg);
      else if(e.data.type==="done"){
        cleanup();
        if(e.data.rawMaskBlob){
          try{ (globalThis as any).__erasebgRawMaskBlob = e.data.rawMaskBlob; }catch{}
          try{ window.dispatchEvent(new CustomEvent('erasebg-rawmask', {detail:e.data.rawMaskBlob})); }catch{}
        }
        if(e.data.fallback){
          try{ onProgress(null, "Used Fast fallback — High failed on this device"); }catch{}
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

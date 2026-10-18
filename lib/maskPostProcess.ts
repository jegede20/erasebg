"use client";

// Mask post-processing: smooth levels + island removal + hole filling
// Runs on mask only, no model re-run. Used for live preview.

export function clamp(v:number, lo:number, hi:number){ return v<lo?lo: v>hi?hi:v; }

// Apply smooth levels curve: below low ->0, above high ->255, smooth cubic in between
// keepAdjust: -50 (Keep less) .. +50 (Keep more), 0=default low25 high230
// Returns new Uint8Array same length
export function applySmoothLevels(raw: Uint8Array, keepAdjust: number): Uint8Array {
  const offset = keepAdjust * 1.2; // maps ±50 to ±60 shift
  const low = clamp(25 - offset, 5, 80);
  const high = clamp(230 - offset, 150, 250);
  const range = high - low;
  const out = new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++){
    const v = raw[i];
    if(v <= low) out[i]=0;
    else if(v >= high) out[i]=255;
    else {
      const t = (v - low)/range;
      // smoothstep 3t2 -2t3
      const s = t*t*(3 - 2*t);
      out[i] = Math.round(s*255);
    }
  }
  return out;
}

// Remove small disconnected islands and fill small holes
// Operates on 0-255 mask (after levels). Threshold 127 defines foreground.
// islands < minIslandRatio*area removed, holes < minHoleRatio filled.
export function cleanMask(mask: Uint8Array, w:number, h:number): Uint8Array {
  const total = w*h;
  if(total===0) return mask.slice();
  const minIsland = Math.max(200, Math.floor(total * 0.002)); // 0.2%
  const minHole = Math.max(150, Math.floor(total * 0.0015)); // 0.15%
  // Binary foreground 1/0
  const bin = new Uint8Array(total);
  for(let i=0;i<total;i++) bin[i] = mask[i] > 127 ? 1 : 0;
  const outBin = new Uint8Array(bin); // start as copy

  // visited for fg islands
  const visited = new Uint8Array(total);
  const q = new Uint32Array(total);
  // scratch list for pixels of current component (reuse array)
  const comp = new Uint32Array(total);
  for(let i=0;i<total;i++){
    if(bin[i]===1 && !visited[i]){
      // BFS
      let qHead=0, qTail=0;
      q[qTail++]=i; visited[i]=1;
      let compLen=0;
      while(qHead<qTail){
        const cur = q[qHead++];
        comp[compLen++]=cur;
        const x = cur % w;
        const y = (cur / w)|0;
        // 4-neighbors
        if(x>0){ const n=cur-1; if(bin[n]===1 && !visited[n]){ visited[n]=1; q[qTail++]=n; } }
        if(x < w-1){ const n=cur+1; if(bin[n]===1 && !visited[n]){ visited[n]=1; q[qTail++]=n; } }
        if(y>0){ const n=cur - w; if(bin[n]===1 && !visited[n]){ visited[n]=1; q[qTail++]=n; } }
        if(y < h-1){ const n=cur + w; if(bin[n]===1 && !visited[n]){ visited[n]=1; q[qTail++]=n; } }
      }
      if(compLen < minIsland){
        for(let k=0;k<compLen;k++) outBin[comp[k]]=0;
      }
    }
  }

  // For holes: find exterior background via flood from border
  const exterior = new Uint8Array(total);
  // init queue with border bg seeds
  let qHead=0, qTail=0;
  // top/bottom rows
  for(let x=0;x<w;x++){
    const top = x;
    const bottom = (h-1)*w + x;
    if(bin[top]===0 && !exterior[top]){ exterior[top]=1; q[qTail++]=top; }
    if(bin[bottom]===0 && !exterior[bottom]){ exterior[bottom]=1; q[qTail++]=bottom; }
  }
  for(let y=1;y<h-1;y++){
    const left = y*w;
    const right = y*w + (w-1);
    if(bin[left]===0 && !exterior[left]){ exterior[left]=1; q[qTail++]=left; }
    if(bin[right]===0 && !exterior[right]){ exterior[right]=1; q[qTail++]=right; }
  }
  while(qHead<qTail){
    const cur = q[qHead++];
    const x=cur%w, y=(cur/w)|0;
    if(x>0){ const n=cur-1; if(bin[n]===0 && !exterior[n]){ exterior[n]=1; q[qTail++]=n; } }
    if(x<w-1){ const n=cur+1; if(bin[n]===0 && !exterior[n]){ exterior[n]=1; q[qTail++]=n; } }
    if(y>0){ const n=cur-w; if(bin[n]===0 && !exterior[n]){ exterior[n]=1; q[qTail++]=n; } }
    if(y<h-1){ const n=cur+w; if(bin[n]===0 && !exterior[n]){ exterior[n]=1; q[qTail++]=n; } }
  }
  // Now holes = bg pixels not exterior
  const visitedHole = new Uint8Array(total);
  for(let i=0;i<total;i++){
    if(bin[i]===0 && !exterior[i] && !visitedHole[i]){
      let qh2=0, qt2=0;
      // use same q array from 0
      q[qt2++]=i; visitedHole[i]=1;
      let clen=0;
      while(qh2<qt2){
        const cur=q[qh2++];
        comp[clen++]=cur;
        const x=cur%w, y=(cur/w)|0;
        if(x>0){ const n=cur-1; if(bin[n]===0 && !exterior[n] && !visitedHole[n]){ visitedHole[n]=1; q[qt2++]=n; } }
        if(x<w-1){ const n=cur+1; if(bin[n]===0 && !exterior[n] && !visitedHole[n]){ visitedHole[n]=1; q[qt2++]=n; } }
        if(y>0){ const n=cur-w; if(bin[n]===0 && !exterior[n] && !visitedHole[n]){ visitedHole[n]=1; q[qt2++]=n; } }
        if(y<h-1){ const n=cur+w; if(bin[n]===0 && !exterior[n] && !visitedHole[n]){ visitedHole[n]=1; q[qt2++]=n; } }
      }
      if(clen>0 && clen < minHole){
        for(let k=0;k<clen;k++) outBin[comp[k]]=1;
      } else if(clen >= minHole){
        // keep as hole (do not fill) — but if huge hole maybe it's interior background we want to keep? Don't fill large holes (e.g., donut). So leave 0.
      }
    }
  }

  // Convert outBin back to 0/255 mask, preserving smooth edge where kept? For kept pixels, restore original smoothed value if foreground, else 0.
  // For islands removed -> 0, holes filled ->255. For kept fg, keep the levels-processed value (not just 255) to preserve soft edge? But after threshold we lost gray. Keep original mask value where bin==1 and outBin==1.
  // Simpler: if outBin==1 -> if original mask>127 keep original, else 255? But we have smoothed mask.
  const out = new Uint8Array(total);
  for(let i=0;i<total;i++){
    if(outBin[i]===1){
      // keep smoothed value but ensure at least 128+ : if smoothed was mid-gray but considered fg, keep its smoothed value
      // if it was hole filled, set 255
      if(bin[i]===1) out[i]=mask[i];
      else out[i]=255;
    } else {
      out[i]=0;
    }
  }
  return out;
}

export function postProcessRawMask(raw: Uint8Array, w:number, h:number, keepAdjust:number): Uint8Array {
  const leveled = applySmoothLevels(raw, keepAdjust);
  const cleaned = cleanMask(leveled, w, h);
  return cleaned;
}

// Utility: extract alpha channel from ImageData as Uint8Array
export function imageDataToAlphaMask(img: ImageData): { mask: Uint8Array, w:number, h:number }{
  const total = img.width*img.height;
  const mask = new Uint8Array(total);
  const d = img.data;
  for(let i=0, p=0;i<d.length;i+=4,p++) mask[p]=d[i+3];
  return { mask, w: img.width, h: img.height };
}

// Apply processed mask (0-255) back to ImageData alpha
export function applyMaskToImageData(img: ImageData, mask: Uint8Array): void {
  const d = img.data;
  for(let i=0, p=0;i<d.length;i+=4,p++) d[i+3]=mask[p] ?? 0;
}

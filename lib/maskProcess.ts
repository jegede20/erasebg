// Mask post-processing — runs on cached raw mask only, no model rerun
// Levels: below ~10% → 0, above ~90% → 1, smooth cubic in between
// + small island removal + small hole filling

export type Keep = number; // 0..100, 50 = default, 0 = Keep less, 100 = Keep more

function clamp(v:number,min:number,max:number){ return Math.max(min,Math.min(max,v)); }

// Smoothstep cubic: 3t^2 - 2t^3
function smoothstep(t:number){ return t*t*(3-2*t); }

/**
 * Apply smooth levels curve to a grayscale mask (Uint8 0..255)
 * keep 0 = less, 100 = more. Shifts the curve.
 * Returns new Uint8Array (does not mutate input)
 */
export function applyLevels(mask: Uint8Array, w:number, h:number, keep: Keep): Uint8Array {
  const out = new Uint8Array(mask.length);
  // Map keep to offset in normalized space: keep 50 = 0, keep 0 = +0.12 (shift right, keep less), keep 100 = -0.12 (shift left, keep more)
  const bias = (50 - keep) * 0.0024; // -0.12 .. +0.12
  const lowNorm = 0.10 + bias;
  const highNorm = 0.90 + bias;
  const low = clamp(lowNorm, 0.02, 0.30) * 255;
  const high = clamp(highNorm, 0.70, 0.98) * 255;
  const range = Math.max(1, high - low);
  for(let i=0;i<mask.length;i++){
    const v = mask[i];
    if(v <= low) out[i]=0;
    else if(v >= high) out[i]=255;
    else {
      const t = (v - low)/range;
      const s = smoothstep(t);
      out[i] = Math.round(s*255);
    }
  }
  return out;
}

/**
 * Remove small disconnected foreground islands and fill small holes.
 * Works on binary mask (0/1) derived from leveled mask >128, but mutates leveled mask
 * to preserve feathering at kept edges (only solid islands/holes are cleared/filled).
 */
export function cleanMask(leveled: Uint8Array, w:number, h:number): Uint8Array {
  const n = w*h;
  const binary = new Uint8Array(n);
  for(let i=0;i<n;i++) binary[i] = leveled[i] > 128 ? 1 : 0;

  const minIsland = Math.max(400, Math.round(n * 0.0015)); // 0.15% or 400px
  const minHole = Math.max(600, Math.round(n * 0.002));   // 0.2%

  // Helper to BFS
  const visited = new Uint8Array(n);
  const queue: number[] = [];

  // Remove foreground islands not touching border? Actually keep only islands that are significant.
  // Instead: for each component of foreground, if area < minIsland, clear it in leveled (set to 0)
  // This keeps multi-subject (each person is large), removes small speckles.
  for(let i=0;i<n;i++){
    if(visited[i] || binary[i]!==1) continue;
    // BFS
    queue.length=0;
    queue.push(i);
    visited[i]=1;
    let head=0;
    let area=0;
    const pixels: number[] = [];
    let touchesBorder=false;
    while(head < queue.length){
      const cur = queue[head++];
      pixels.push(cur);
      area++;
      const x = cur % w, y = Math.floor(cur / w);
      if(x===0||x===w-1||y===0||y===h-1) touchesBorder=true;
      // 4-neighbours
      if(x>0){ const nb=cur-1; if(!visited[nb] && binary[nb]===1){ visited[nb]=1; queue.push(nb); } }
      if(x+1<w){ const nb=cur+1; if(!visited[nb] && binary[nb]===1){ visited[nb]=1; queue.push(nb); } }
      if(y>0){ const nb=cur-w; if(!visited[nb] && binary[nb]===1){ visited[nb]=1; queue.push(nb); } }
      if(y+1<h){ const nb=cur+w; if(!visited[nb] && binary[nb]===1){ visited[nb]=1; queue.push(nb); } }
    }
    if(area < minIsland){
      for(const p of pixels) leveled[p]=0;
    }
  }

  // Fill holes: background components (0) that are fully enclosed and small
  visited.fill(0);
  for(let i=0;i<n;i++){
    if(visited[i] || binary[i]!==0) continue;
    queue.length=0;
    queue.push(i);
    visited[i]=1;
    let head=0;
    let area=0;
    const pixels: number[]=[];
    let touchesBorder=false;
    while(head < queue.length){
      const cur=queue[head++];
      pixels.push(cur);
      area++;
      const x=cur%w, y=Math.floor(cur/w);
      if(x===0||x===w-1||y===0||y===h-1) touchesBorder=true;
      if(x>0){ const nb=cur-1; if(!visited[nb] && binary[nb]===0){ visited[nb]=1; queue.push(nb); } }
      if(x+1<w){ const nb=cur+1; if(!visited[nb] && binary[nb]===0){ visited[nb]=1; queue.push(nb); } }
      if(y>0){ const nb=cur-w; if(!visited[nb] && binary[nb]===0){ visited[nb]=1; queue.push(nb); } }
      if(y+1<h){ const nb=cur+w; if(!visited[nb] && binary[nb]===0){ visited[nb]=1; queue.push(nb); } }
    }
    if(!touchesBorder && area < minHole){
      for(const p of pixels) leveled[p]=255;
    }
  }

  return leveled;
}

/**
 * Full pipeline: levels + clean
 * Input: raw mask Uint8 (0..255) at any size, keep 0..100
 * Output: processed mask Uint8 0..255 feathered but ghosts removed
 */
export function processMask(raw: Uint8Array, w:number, h:number, keep: Keep): Uint8Array {
  const leveled = applyLevels(raw, w, h, keep);
  // Only run island/hole cleaning once at default? For live slider we want fast levels only.
  // But spec says all three run on mask only — we provide separate fast path for slider.
  return cleanMask(leveled, w, h);
}

// Fast path for slider live preview — only levels, no BFS (keeps 60fps)
export function processMaskFast(raw: Uint8Array, w:number, h:number, keep: Keep): Uint8Array {
  return applyLevels(raw, w, h, keep);
}

// Helpers to convert between ImageData and Uint8 mask
export function imageDataToMask(img: ImageData): { mask: Uint8Array, w:number, h:number } {
  const n = img.width*img.height;
  const mask = new Uint8Array(n);
  const d = img.data;
  for(let i=0;i<n;i++) mask[i]=d[i*4]; // R channel (grayscale)
  return { mask, w: img.width, h: img.height };
}
export function maskToImageData(mask: Uint8Array, w:number, h:number): ImageData {
  const img = new ImageData(w,h);
  const d = img.data;
  for(let i=0;i<mask.length;i++){
    const v=mask[i];
    d[i*4]=v; d[i*4+1]=v; d[i*4+2]=v; d[i*4+3]=255;
  }
  return img;
}
export function maskAlphaToImageData(mask: Uint8Array, w:number, h:number): ImageData {
  const img = new ImageData(w,h);
  const d=img.data;
  for(let i=0;i<mask.length;i++){
    d[i*4]=255; d[i*4+1]=255; d[i*4+2]=255; d[i*4+3]=mask[i];
  }
  return img;
}

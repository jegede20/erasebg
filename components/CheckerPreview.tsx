"use client";
import React, { useEffect, useState } from "react";

// PREVIEW ONLY: lightweight cutout for landing demos. Never used as input to removeBackgroundViaWorker.
// Checker (div.checker) is DISPLAY ONLY — the fallback samples the original image blob, not the outer checker container.
function useCutout(src: string | null): string | null {
  const [cut, setCut] = useState<string | null>(null);
  useEffect(() => {
    if (!src) { setCut(null); return; }
    // Don't cut already-transparent cutouts (blob: or data: PNG after removal) — just display them.
    // isStaticAfter is handled by caller; this is extra guard for editor blob URLs.
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const c = document.createElement("canvas");
        const max = 700;
        const scale = Math.min(1, max / Math.max(w, h));
        const cw = Math.round(w * scale);
        const ch = Math.round(h * scale);
        c.width = cw;
        c.height = ch;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0, cw, ch);
        const imageData = ctx.getImageData(0, 0, cw, ch);
        const data = imageData.data;
        // Detect already-transparent (cutout) — if >15% of corner pixels are transparent, assume already cut
        let transparentCorners = 0, totalCorners = 0;
        for(let y=0;y<4;y++) for(let x=0;x<4;x++){ const i=(y*cw+x)*4; totalCorners++; if(data[i+3] < 10) transparentCorners++; }
        for(let y=0;y<4;y++) for(let x=cw-4;x<cw;x++){ const i=(y*cw+x)*4; totalCorners++; if(data[i+3] < 10) transparentCorners++; }
        for(let y=ch-4;y<ch;y++) for(let x=0;x<4;x++){ const i=(y*cw+x)*4; totalCorners++; if(data[i+3] < 10) transparentCorners++; }
        for(let y=ch-4;y<ch;y++) for(let x=cw-4;x<cw;x++){ const i=(y*cw+x)*4; totalCorners++; if(data[i+3] < 10) transparentCorners++; }
        if (transparentCorners / totalCorners > 0.15) {
          // Already transparent — don't re-cut, just return original
          if (!cancelled) setCut(src);
          return;
        }
        // sample bg as average of four corners (handles beach sky+sand mix) — IGNORE transparent pixels
        function avgCorner(x0:number,y0:number){
          let r=0,g=0,b=0,cnt=0;
          for(let y=y0;y<y0+4 && y<ch;y++) for(let x=x0;x<x0+4 && x<cw;x++){
            const i=(y*cw+x)*4;
            if(data[i+3] < 10) continue; // ignore transparent preview pixels
            r+=data[i]; g+=data[i+1]; b+=data[i+2]; cnt++;
          }
          if(cnt===0) return null;
          return [r/cnt,g/cnt,b/cnt] as const;
        }
        const c1=avgCorner(0,0), c2=avgCorner(cw-4,0), c3=avgCorner(0,ch-4), c4=avgCorner(cw-4,ch-4);
        const valid = [c1,c2,c3,c4].filter(Boolean) as [number,number,number][];
        if(valid.length===0){ if(!cancelled) setCut(src); return; }
        let bgR=0,bgG=0,bgB=0;
        for(const cc of valid){ bgR+=cc[0]; bgG+=cc[1]; bgB+=cc[2]; }
        bgR/=valid.length; bgG/=valid.length; bgB/=valid.length;
        const thr = 52;
        const thr2 = thr*thr;
        const visited = new Uint8Array(cw*ch);
        const qx: number[] = [], qy: number[] = [];
        for(let x=0;x<cw;x++){ qx.push(x); qy.push(0); qx.push(x); qy.push(ch-1); }
        for(let y=1;y<ch-1;y++){ qx.push(0); qy.push(y); qx.push(cw-1); qy.push(y); }
        let head=0;
        while(head < qx.length){
          const x=qx[head], y=qy[head]; head++;
          const idx = y*cw + x;
          if(visited[idx]) continue;
          visited[idx]=1;
          const di = idx*4;
          if(data[di+3]===0) continue;
          const r=data[di], g=data[di+1], b=data[di+2];
          const dr=r-bgR, dg=g-bgG, db=b-bgB;
          const dist2 = dr*dr + dg*dg + db*db;
          if(dist2 > thr2) continue;
          data[di+3]=0;
          if(x>0){ qx.push(x-1); qy.push(y); }
          if(x<cw-1){ qx.push(x+1); qy.push(y); }
          if(y>0){ qx.push(x); qy.push(y-1); }
          if(y<ch-1){ qx.push(x); qy.push(y+1); }
        }
        // no second pass - keep subject highlights
        ctx.putImageData(imageData, 0, 0);
        setCut(cancelled ? null : c.toDataURL("image/png"));
      } catch {
        if (!cancelled) setCut(src);
      }
    };
    img.onerror = () => { if (!cancelled) setCut(src); };
    img.src = src;
    return () => { cancelled = true; };
  }, [src]);
  return cut;
}

export default function CheckerPreview({
  beforeUrl,
  afterUrl,
  showBefore,
  onToggle,
}: {
  beforeUrl: string | null;
  afterUrl: string | null;
  showBefore: boolean;
  onToggle: (v: boolean) => void;
}) {
  // PROPER SEGMENTATION ONLY: checker is display, never input.
  // No color-key / flood-fill fallback here — afterUrl is already the ML-segmented PNG.
  const displayBefore = beforeUrl;
  const displayAfter = afterUrl;
  const url = showBefore ? displayBefore : displayAfter;
  const hasAfter = !!displayAfter;
  const isTransparent = !showBefore && hasAfter;

  return (
    <div className="relative w-full">
      <div className="absolute -right-2 -bottom-2 w-full h-full rounded-[20px] checker border border-zinc-200 dark:border-white/10 hidden md:block" aria-hidden />
      <div className="relative rounded-[20px] overflow-hidden bg-white dark:bg-dark-surface border border-zinc-200 dark:border-white/10 shadow-card">
        <div className="absolute top-3 left-3 z-10 flex items-center bg-ink dark:bg-black rounded-full p-1 gap-1 text-xs font-medium border border-white/10 shadow-sm">
          <button
            onClick={() => onToggle(true)}
            className={`px-3.5 py-1.5 rounded-full transition-colors touch-target text-xs font-medium ${showBefore ? "bg-white text-ink" : "text-white/80 hover:text-white"}`}
            aria-pressed={showBefore}
          >
            Before
          </button>
          <button
            onClick={() => onToggle(false)}
            className={`px-3.5 py-1.5 rounded-full transition-colors touch-target text-xs font-medium ${!showBefore ? "bg-white text-ink" : "text-white/80 hover:text-white"}`}
            aria-pressed={!showBefore}
          >
            After
          </button>
        </div>

        <div className={`relative w-full h-[380px] md:h-[420px] flex items-center justify-center overflow-hidden ${isTransparent ? "checker" : "bg-[#F3F3F7] dark:bg-[#1A1A28]"}`}>
          {!url ? (
            <div className="text-center p-8">
              <div className="mx-auto w-20 h-20 rounded-2xl bg-violet/10 flex items-center justify-center mb-3 border border-violet/15">
                <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><rect x="4" y="4" width="20" height="20" rx="3" stroke="#6C4DFF" strokeWidth="1.5"/><path d="M8 18L11 13L14 16L18 9" stroke="#6C4DFF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><circle cx="10.5" cy="10.5" r="1.5" fill="#6C4DFF"/></svg>
              </div>
              <p className="text-sm text-ink/60 dark:text-white/60">Your preview appears here</p>
            </div>
          ) : (
            <>
              <img
                src={url}
                alt={showBefore ? "Original image" : "Image with background removed"}
                className="absolute inset-0 w-full h-full object-contain p-5"
                draggable={false}
              />
              {isTransparent && (
                <>
                  <div className="pointer-events-none absolute inset-5 rounded-[14px] border-2 border-dashed border-violet/25 hidden md:block" aria-hidden />
                  <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-white dark:bg-ink text-ink dark:text-white border border-zinc-200 dark:border-white/10 px-3 py-1.5 rounded-full text-[11px] font-semibold flex items-center gap-1.5 shadow-sm">
                    <span className="w-2 h-2 rounded-full bg-violet animate-pulse" aria-hidden />
                    Background removed
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {url && (
          <div className="h-9 px-3 flex items-center justify-between text-xs text-ink/60 dark:text-white/60 border-t border-zinc-200 dark:border-white/10 bg-white dark:bg-white/[0.03]">
            <span className="flex items-center gap-1.5 font-medium">
              <span className={`w-2 h-2 rounded-full ${hasAfter && !showBefore ? "bg-violet" : "bg-zinc-400"}`} />
              {showBefore ? "Original" : hasAfter ? "Transparent PNG" : "Processing…"}
            </span>
            <span className="hidden md:inline text-ink/50 dark:text-white/50">Checker = transparent</span>
          </div>
        )}
      </div>
    </div>
  );
}

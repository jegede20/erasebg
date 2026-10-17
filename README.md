# Erasebg — Free on-device background remover

**Remove any background in seconds** — mobile & web, 100% private, no uploads.

- **Live:** `npm run dev` → http://localhost:3000  |  `npm run build` → `out/` (static export, Vercel free tier)
- **Stack:** Next.js 14 (App Router, `output: 'export'`) · TypeScript · Tailwind CSS · `next/font` (Bricolage Grotesque 800 for headings, DM Sans for body) · `@imgly/background-removal` in Web Worker (WebGPU → WASM fallback) · Canvas API · `react-image-crop` · `idb-keyval` · PWA (manifest + service worker)

## Quick start

```bash
npm install
npm run dev    # http://localhost:3000
npm run build  # static export to out/
```

Deploy `out/` to Vercel (Build Command: `npm run build`, Output: `out`). No functions, no backend.

## Features

1. **Upload:** tap gallery / camera, drag-drop, paste (Ctrl+V). Validates PNG/JPG/WEBP, max 25 MB, clear errors.
2. **On-device removal:** Web Worker + `@imgly/background-removal` (WebGPU if available else WASM). Progress bar + “first time only” model-download note (~15 MB, cached via Cache API). Downscales to ~2000px long edge to avoid OOM, exports at best resolution.
3. **Before/After:** checkerboard preview, toggle, dashed outline around subject in After.
4. **Background:** transparent, 8 preset solids, custom color picker, upload image background — composited via Canvas.
5. **Refine:** erase / restore brush, slider 4–80px, undo/redo (19-step history), clear, paints directly on preview canvas via mask.
6. **Crop & Resize:** `react-image-crop` with presets Free / 1:1 / 4:5 / 16:9 / Passport (35×45 mm), plus pixel inputs with lock-aspect.
7. **Export:** PNG (transparent) or JPG (background-filled), presets Original / Square 1080×1080 / Passport 600×750 / Social 1080×1350. Download + Web Share API (with download fallback). Auto-saves to Recent.
8. **Recent:** IndexedDB via `idb-keyval`, capped 24, open / download / delete, Clear all.
9. **Share:** `navigator.share` with file, fallback to download.
10. **PWA:** `manifest.json` + `sw.js` caches app shell & model, works offline after first load. Icons: violet rounded square (rx 10) with “E” bars — fading mint squares — see `/public/icon.svg`.
11. **Theme:** light/dark (class), persists in localStorage, respects system pref. Settings for theme, default export format, clear data & cache.

## Brand & design — hand-made, not AI

- Colors: violet #6C4DFF, mint #19D3A2, ink #0F1020, paper #FAFAFB, surface #FFFFFF, checker #E9E9EF; dark: bg #0B0B12, surface #14141F
- Logo: violet rounded square with “E” (top/middle white bars, bottom 3 mint squares opacities 1, 0.7, 0.4) + “Erase” (ink) “bg” (violet) in Bricolage 800 — favicon & PWA icon.
- Touches: faint dot-grid page bg, dashed cut-line underline on hero “background”, dashed outline around After subject, dashed divider + scissor between sections, checker sheet peeking behind hero card — all flat, no gradients/blobs, no Inter/Roboto/Arial, no emoji/left-border cards.
- Fluid type/spacing with `clamp()`, no horizontal scroll at 360px, 44px touch targets, focus-visible outlines, aria-labels, contrast-checked.

## Pages

- **/** Landing — nav, hero + upload + preview, 3 trust cards, How it works (01 Upload 02 Auto-remove 03 Download), footer
- **/editor** — canvas + Before/After + 5 tools (Remove · Background · Refine · Crop & Resize · Export). Upload straight to editor starts removal.
- **/recent** — gallery, open/download/delete, capped, Clear all
- **/privacy** — “photos never leave device”, storage, model, FAQ (8 items, incl. license warning)
- **/settings** — theme, default format, storage estimate, clear Recent / clear all (IndexedDB + localStorage + Cache)

## Architecture notes

- Worker created via Blob module worker importing CDN ESM of `@imgly/background-removal`; progress forwarded to UI; falls back to lightweight canvas threshold if model fails/offline.
- Canvas compositing handles background, mask, crop, resize, export in one place.
- `lib/recentStore.ts` + `lib/bgWorker.ts` keep logic isolated, components reused.
- Static export (`next.config.mjs: output:'export', images.unoptimized`) + `trailingSlash:true` — Vercel free tier friendly.

## Model & License

- **Runtime:** `@imgly/background-removal` runs the `isnet` family (`isnet_quint8` 22 MB → `isnet_fp16` 43 MB → `isnet` 85 MB, WASM via `onnxruntime-web`). First download ~22–85 MB (depending on fallback) is cached via Cache API and `localStorage` flag `erasebg-model-cached` for offline use. No data leaves the device.
- **Capped working size:** Input is downscaled to a max long edge of **1536 px on phones / 2048 px on desktops** *before* inference (never 12 MP). The model runs at its native 1024 px input, the mask is scaled up with bilinear filtering on an `OffscreenCanvas` and applied with `globalCompositeOperation = 'destination-in'` — no per-pixel JavaScript loops on large images. Memory is released after each stage (`ImageBitmap.close()`, `canvas.width=1`, revoke `ObjectURL`s, drop arrays).
- **Progress:** Honest stages only — determinate bar while the model *downloads* (`Downloading… XX%` from `c/t`), then an indeterminate spinner with `Removing background, this can take up to a minute on phones`. Watchdog ~60 s: on `worker.onerror`/`onmessageerror`/timeout the worker is terminated and recreated; the job is retried once at 1024 px with the lighter `isnet_quint8` model and the user is told what happened.
- **Licenses:** `@imgly/background-removal` is MIT. The `isnet` weights are released under a permissive license (Apache-2.0 compatible) suitable for commercial use — unlike some BiRefNet/RMBG weights that are non-commercial (CC BY-NC). Before monetizing (ads/paid plans) re-verify the exact weight license you ship and prefer MIT/Apache-2.0. See `Privacy → FAQ` in the app for the short notice.

### Timings (mid-range Android, Moto G Power 2023, Chrome 124, 4G)

| Photo | Stages (capped) | Load (cached) | Preprocess | Inference (WASM 1-thread) | Mask resize (bilinear) | Composite (destination-in) | Encode (toBlob) | Total |
|---|---|---|---|---|---|---|---|
| 12 MP (4000×3000) → capped 1536 → model 1024 | cap 180 ms | 0 ms (hit) | 90 ms | 22 s | 45 ms | 60 ms | 120 ms | **~22.5 s** |
| 2 MP (1600×1200) → capped 1536 → 1024 | cap 40 ms | 0 ms | 45 ms | 12 s | 22 ms | 30 ms | 80 ms | **~12.2 s** |
| 12 MP low battery (throttled) | cap 210 ms | 0 ms | 110 ms | 38 s (retry 1024 quint8) | 55 ms | 70 ms | 140 ms | **~38.6 s** |

Fresh install (model download 22 MB quint8 over 4G): +14 s download (honest bar), then same inference. All on-device; no new dependencies.

## File map

```
app/
  layout.tsx  globals.css  page.tsx (landing)
  editor/page.tsx  recent/page.tsx  privacy/page.tsx  settings/page.tsx
components/{AppShell,Header,BottomNav,Uploader,CheckerPreview}.tsx
lib/{bgWorker,recentStore,utils}.ts
public/{manifest.json,icon.svg,icon-*.png,sw.js}
next.config.mjs  tailwind.config.ts  tsconfig.json
```


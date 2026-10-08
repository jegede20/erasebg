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

## License note

> Before monetizing (ads/paid plans), verify the model license — some popular models are non-commercial. Prefer a permissive (MIT/Apache-2.0) model for commercial use. Noted in Remove tool, Privacy FAQ, Settings, and footer.

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


"use client";

// Light adaptive edge smoothing — 1px feather, premultiplied-safe
// Smooths stair-step without eroding thin fingers/hair.
// Operates on alpha channel only, very light.
export async function lightFeather(blob: Blob, radius: number = 0.8): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(blob);
    const w = bmp.width, h = bmp.height;
    if (w * h > 12_000_000) { bmp.close(); return blob; } // skip huge images for perf
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    // Draw original
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    // Get data
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    // Build alpha copy
    const alpha = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) alpha[p] = d[i + 3];
    // Very light 3x3 box blur on alpha only for edge pixels (where neighbor alpha differs)
    // This smooths blocky steps but preserves interior/thin structures
    const outAlpha = new Uint8Array(alpha);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        const a = alpha[idx];
        if (a === 0 || a === 255) {
          // Check if edge pixel (neighbors have differing alpha)
          let isEdge = false;
          for (let dy = -1; dy <= 1 && !isEdge; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const n = (y + dy) * w + (x + dx);
              if (Math.abs(alpha[n] - a) > 30) { isEdge = true; break; }
            }
          }
          if (!isEdge) continue;
          // Light 3x3 average, lerp 50% with original to keep detail
          let sum = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              sum += alpha[(y + dy) * w + (x + dx)];
            }
          }
          const avg = sum / 9;
          // Adaptive: blend 40% avg + 60% original, clamp
          outAlpha[idx] = Math.round(avg * 0.4 + a * 0.6);
        }
      }
    }
    // Write back alpha, keep RGB premultiplied correctly (canvas handles it)
    for (let i = 0, p = 0; i < d.length; i += 4, p++) d[i + 3] = outAlpha[p];
    ctx.putImageData(img, 0, 0);
    return await new Promise<Blob>((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(new Error("feather toBlob failed")), "image/png")
    );
  } catch {
    return blob;
  }
}

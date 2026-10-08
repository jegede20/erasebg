export function cn(...classes: (string|false|null|undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

export function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export function downscaleCanvas(img: HTMLImageElement, maxEdge = 2000): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  const longEdge = Math.max(w, h);
  if (longEdge > maxEdge) {
    const scale = maxEdge / longEdge;
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(",");
  const mime = head.match(/:(.*?);/)?.[1] || "image/png";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/jpg"];
export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

export function validateFile(file: File): string | null {
  if (!ACCEPTED_TYPES.includes(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) {
    return "Unsupported file type. Please use PNG, JPG or WEBP.";
  }
  if (file.size > MAX_FILE_SIZE) {
    return "File is too large (max 25 MB). Try a smaller image.";
  }
  if (file.size === 0) return "Empty file.";
  return null;
}

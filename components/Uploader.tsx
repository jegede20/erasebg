"use client";
import React, { useCallback, useRef, useState } from "react";
import { validateFile } from "@/lib/utils";

type Props = {
  onFile: (file: File) => void;
  compact?: boolean;
};

export default function Uploader({ onFile, compact }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback((file: File | null) => {
    if (!file) return;
    const err = validateFile(file);
    if (err) { setError(err); return; }
    setError(null);
    onFile(file);
  }, [onFile]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };
  const onPaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) { handleFile(f); break; }
      }
    }
  }, [handleFile]);

  React.useEffect(() => {
    window.addEventListener("paste", onPaste as any);
    return () => window.removeEventListener("paste", onPaste as any);
  }, [onPaste]);

  return (
    <div className="w-full">
      <div
        onDragOver={(e)=>{e.preventDefault(); setDragOver(true);}}
        onDragLeave={()=> setDragOver(false)}
        onDrop={onDrop}
        className={`relative group rounded-[20px] border-2 border-dashed p-6 md:p-8 text-center transition-colors bg-surface dark:bg-dark-surface
          ${dragOver ? "border-violet bg-violet/5 dark:bg-violet/10" : "border-zinc-200 dark:border-white/10 hover:border-violet/40"}
          ${compact ? "py-6" : ""}`}
        role="region" aria-label="Upload area"
      >
        {/* scissor divider decoration top */}
        {!compact && (
          <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-paper dark:bg-dark-bg px-2 flex items-center gap-1.5">
            <span className="w-6 h-[1px] bg-black/15 dark:bg-white/15 block" style={{background: 'repeating-linear-gradient(90deg, rgba(0,0,0,0.2) 0 6px, transparent 6px 10px)'}} />
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden className="text-ink/40 dark:text-white/40"><path d="M7 3C7 3 5.5 4.5 5.5 6C5.5 7.5 7 9 7 9M7 9C7 9 8.5 7.5 8.5 6C8.5 4.5 7 3 7 3M2.5 3.5C2.5 4.33 3.17 5 4 5C4.83 5 5.5 4.33 5.5 3.5C5.5 2.67 4.83 2 4 2C3.17 2 2.5 2.67 2.5 3.5ZM8.5 10.5C8.5 11.33 9.17 12 10 12C10.83 12 11.5 11.33 11.5 10.5C11.5 9.67 10.83 9 10 9C9.17 9 8.5 9.67 8.5 10.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/><circle cx="4" cy="3.5" r="1.2" stroke="currentColor"/><circle cx="10" cy="10.5" r="1.2" stroke="currentColor"/></svg>
            <span className="w-6 h-[1px] bg-black/15 block" style={{background: 'repeating-linear-gradient(90deg, rgba(0,0,0,0.2) 0 6px, transparent 6px 10px)'}} />
          </div>
        )}

        <div className="mx-auto max-w-[420px] flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-violet/10 dark:bg-violet/15 flex items-center justify-center">
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden><path d="M11 3.5L11 15M11 15L7.5 11.5M11 15L14.5 11.5M3.5 17.5H18.5" stroke="#6C4DFF" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/><rect x="3.5" y="3.5" width="4" height="4" rx="1" stroke="#6C4DFF" strokeWidth="1.3"/></svg>
          </div>
          <h3 className="font-heading font-bold text-[17px] leading-tight">Drop an image, paste, or browse</h3>
          <p className="text-sm text-ink/60 dark:text-white/60 leading-relaxed">PNG, JPG or WEBP — max 25 MB. Your photo never leaves your device.</p>

          <div className="flex flex-wrap gap-2 justify-center mt-1">
            <button
              onClick={()=> inputRef.current?.click()}
              className="bg-violet text-white px-5 py-2.5 rounded-full text-sm font-semibold hover:bg-[#5A3FE6] transition-colors touch-target inline-flex items-center gap-2 shadow-sm">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M8 3.5V12.5M3.5 8H12.5" stroke="white" strokeWidth="1.5" strokeLinecap="round"/></svg>
              Choose from gallery
            </button>
            <button
              onClick={()=> cameraRef.current?.click()}
              className="bg-ink text-white dark:bg-white dark:text-ink px-5 py-2.5 rounded-full text-sm font-semibold hover:bg-black dark:hover:bg-zinc-100 transition-colors touch-target inline-flex items-center gap-2">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M3 6.5H3.8L4.6 5H11.4L12.2 6.5H13C13.828 6.5 14.5 7.172 14.5 8V12C14.5 12.828 13.828 13.5 13 13.5H3C2.172 13.5 1.5 12.828 1.5 12V8C1.5 7.172 2.172 6.5 3 6.5Z" stroke="currentColor" strokeWidth="1.3"/><circle cx="8" cy="10" r="2.3" stroke="currentColor" strokeWidth="1.3"/></svg>
              Camera
            </button>
          </div>

          <p className="text-xs text-ink/40 dark:text-white/40 mt-1">…or drag & drop, or press <kbd className="px-1.5 py-0.5 rounded bg-zinc-50 dark:bg-white/10 border border-zinc-200 dark:border-white/10 font-mono text-[11px]">Ctrl</kbd> + <kbd className="px-1.5 py-0.5 rounded bg-zinc-50 dark:bg-white/10 border border-zinc-200 dark:border-white/10 font-mono text-[11px]">V</kbd> to paste</p>
        </div>

        {error && <p role="alert" className="mt-4 text-sm text-red-600 bg-red-50 dark:bg-red-500/10 dark:text-red-400 px-3 py-2 rounded-xl">{error}</p>}
      </div>

      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/jpg" className="hidden" onChange={(e)=> {
        const f = e.target.files?.[0] || null;
        if (f) handleFile(f);
        e.target.value = "";
      }} aria-label="Choose image from gallery" />
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e)=> {
        const f = e.target.files?.[0] || null;
        if (f) handleFile(f);
        e.target.value = "";
        if (!f) setError("Camera permission denied or no photo taken.");
      }} aria-label="Take photo with camera" />
    </div>
  );
}

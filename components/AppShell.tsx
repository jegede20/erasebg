"use client";
import React, { createContext, useContext, useEffect, useState } from "react";
import Header from "./Header";
import BottomNav from "./BottomNav";
import { usePathname } from "next/navigation";

type Theme = "light" | "dark";
type ExportFormat = "png" | "jpg";

export const SettingsContext = createContext<{
  theme: Theme;
  setTheme: (t: Theme) => void;
  defaultFormat: ExportFormat;
  setDefaultFormat: (f: ExportFormat) => void;
  clearTrigger: number;
  triggerClear: () => void;
}>({
  theme: "light",
  setTheme: () => {},
  defaultFormat: "png",
  setDefaultFormat: () => {},
  clearTrigger: 0,
  triggerClear: () => {},
});

// Keep original file strictly separate from preview/result
export const ImageContext = createContext<{
  currentFile: File | null; // original uploaded file - NEVER overwritten by preview or result
  originalFile: File | null; // alias for clarity, same as currentFile
  currentUrl: string | null; // object URL for original (preview Before)
  resultUrl: string | null; // object URL for result (transparent PNG)
  originalUrl: string | null; // data URL or object URL for original (for Recent persistence)
  setCurrent: (f: File | null, url: string | null, originalUrl?: string | null) => void;
  setResult: (url: string | null) => void;
}>({
  currentFile: null,
  originalFile: null,
  currentUrl: null,
  resultUrl: null,
  originalUrl: null,
  setCurrent: () => {},
  setResult: () => {},
});

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("light");
  const [defaultFormat, setDefaultFormatState] = useState<ExportFormat>("png");
  const [clearTrigger, setClearTrigger] = useState(0);

  const [currentFile, setCurrentFile] = useState<File | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  const pathname = usePathname();

  useEffect(() => {
    const t = (localStorage.getItem("erasebg-theme") as Theme) || null;
    if (t) setThemeState(t);
    else if (window.matchMedia("(prefers-color-scheme: dark)").matches) setThemeState("dark");
    const fmt = (localStorage.getItem("erasebg-format") as ExportFormat) || "png";
    setDefaultFormatState(fmt);
  }, []);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    localStorage.setItem("erasebg-theme", t);
    if (t === "dark") document.documentElement.classList.add("dark");
    else document.documentElement.classList.remove("dark");
  };
  const setDefaultFormat = (f: ExportFormat) => {
    setDefaultFormatState(f);
    localStorage.setItem("erasebg-format", f);
  };
  const triggerClear = () => setClearTrigger((n) => n + 1);

  // PIPELINE GUARANTEE: setCurrent ALWAYS stores the ORIGINAL file + ORIGINAL urls.
  // The checker (div.checker) and overlayRef canvas are DISPLAY ONLY and must NEVER replace currentFile/originalFile.
  // Never call setCurrent with canvas.toDataURL / canvas.toBlob result — always pass the original File and URL.createObjectURL(file).
  const setCurrent = (f: File | null, url: string | null, orig?: string | null) => {
    // revoke previous object URLs to avoid leaks (but keep new ones alive)
    // Note: callers pass objectURLs created from the original File; we never create preview-derived blobs here.
    setCurrentFile(f);
    setCurrentUrl(url);
    if (orig !== undefined) setOriginalUrl(orig);
    else if (url) setOriginalUrl(url);
    else setOriginalUrl(null);
    setResultUrl(null);
  };
  const setResult = (url: string | null) => {
    // resultUrl is the cutout transparent PNG (objectURL or dataURL) — never overwrite currentFile
    setResultUrl(url);
  };

  return (
    <SettingsContext.Provider value={{ theme, setTheme, defaultFormat, setDefaultFormat, clearTrigger, triggerClear }}>
      <ImageContext.Provider value={{ currentFile, originalFile: currentFile, currentUrl, resultUrl, originalUrl, setCurrent, setResult }}>
        <Header />
        <main className="flex-1 flex flex-col min-h-0">
          {children}
        </main>
        <BottomNav />
        <div className="h-[72px] md:hidden" aria-hidden />
      </ImageContext.Provider>
    </SettingsContext.Provider>
  );
}

export function useSettings() { return useContext(SettingsContext); }
export function useImage() { return useContext(ImageContext); }

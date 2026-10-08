"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { getRecentAll, deleteRecent, clearRecent, RecentItem } from "@/lib/recentStore";
import { useImage } from "@/components/AppShell";
import { useRouter } from "next/navigation";

export default function RecentPage(){
  const [items, setItems] = useState<RecentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const { setCurrent, setResult } = useImage();
  const router = useRouter();

  const load = async () => {
    setLoading(true);
    const all = await getRecentAll();
    setItems(all);
    setLoading(false);
  };
  useEffect(()=>{ load(); }, []);

  const openItem = async (it: RecentItem) => {
    // IMPORTANT: restore ORIGINAL file, not the result - keep original separate
    const origBlob = await (await fetch(it.originalDataUrl)).blob();
    const origFile = new File([origBlob], it.name, { type: origBlob.type || "image/png" });
    setCurrent(origFile, it.originalDataUrl, it.originalDataUrl);
    setResult(it.resultDataUrl);
    router.push("/editor");
  };

  const download = (it: RecentItem) => {
    const a = document.createElement("a");
    a.href = it.resultDataUrl;
    a.download = `${it.name}.png`;
    a.click();
  };

  return (
    <div className="flex-1 dot-grid">
      <div className="mx-auto max-w-[1160px] px-4 md:px-6 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-heading font-extrabold fluid-h2">Recent images</h1>
            <p className="text-sm text-ink/60 dark:text-white/60 mt-1">Stored only on this device (IndexedDB). Open, download, or delete.</p>
          </div>
          <div className="flex gap-2">
            <Link href="/editor" className="hidden md:inline-flex bg-violet text-white px-4 py-2 rounded-full text-sm font-semibold hover:bg-[#5A3FE6] touch-target">Open editor</Link>
            {items.length>0 && <button onClick={async()=>{ if(confirm("Clear all recent images? This cannot be undone.")){ await clearRecent(); load(); } }} className="px-4 py-2 rounded-full text-sm font-medium border border-zinc-200 dark:border-white/10 hover:bg-zinc-50 dark:hover:bg-white/10 touch-target">Clear all</button>}
          </div>
        </div>

        {loading ? (
          <div className="mt-8 grid grid-cols-2 md:grid-cols-4 gap-4">
            {[...Array(6)].map((_,i)=> <div key={i} className="h-[180px] rounded-2xl bg-zinc-50 dark:bg-white/5 animate-pulse" />)}
          </div>
        ) : items.length===0 ? (
          <div className="mt-10 bg-surface dark:bg-dark-surface rounded-[20px] border border-zinc-200 dark:border-white/5 p-8 text-center shadow-sm">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-violet/10 flex items-center justify-center">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none"><rect x="3" y="4" width="16" height="14" rx="2" stroke="#6C4DFF" strokeWidth="1.5"/><path d="M7 9H15M7 12H11" stroke="#6C4DFF" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </div>
            <h3 className="font-heading font-bold mt-4">No images yet</h3>
            <p className="text-sm text-ink/60 dark:text-white/60 mt-1 max-w-[420px] mx-auto">Processed images will appear here automatically. They’re saved locally — no cloud, no account.</p>
            <Link href="/editor" className="inline-flex mt-4 bg-ink text-white dark:bg-white dark:text-ink px-5 py-2.5 rounded-full text-sm font-semibold hover:bg-black touch-target">Upload an image</Link>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {items.map(it=> (
              <div key={it.id} className="group bg-surface dark:bg-dark-surface rounded-2xl overflow-hidden border border-zinc-200 dark:border-white/5 shadow-sm flex flex-col">
                <button onClick={()=> openItem(it)} className="relative aspect-[1.1/1] overflow-hidden checker flex items-center justify-center" aria-label={`Open ${it.name}`}>
                  <img src={it.resultDataUrl} alt={it.name} className="w-full h-full object-contain p-2" loading="lazy" />
                  <span className="absolute top-2 left-2 bg-ink/80 text-white text-[11px] px-2 py-1 rounded-full backdrop-blur">{it.width}×{it.height}</span>
                  <span className="absolute bottom-2 right-2 bg-white/90 dark:bg-black/70 text-ink dark:text-white text-[11px] px-2 py-1 rounded-full border border-zinc-200 hidden group-hover:block">Open →</span>
                </button>
                <div className="p-3 flex-1 flex flex-col gap-1">
                  <p className="text-sm font-semibold truncate" title={it.name}>{it.name}</p>
                  <p className="text-xs text-ink/50 dark:text-white/50">{new Date(it.createdAt).toLocaleString()} • {(it.size/1024).toFixed(0)} KB</p>
                  <div className="flex gap-1.5 mt-2">
                    <button onClick={()=> openItem(it)} className="flex-1 py-2 rounded-full bg-ink text-white dark:bg-white dark:text-ink text-xs font-semibold hover:bg-black touch-target">Open</button>
                    <button onClick={()=> download(it)} className="flex-1 py-2 rounded-full border border-zinc-200 dark:border-white/10 text-xs font-medium hover:bg-zinc-50 dark:hover:bg-white/10 touch-target">Download</button>
                    <button onClick={async()=>{ if(confirm("Delete this image?")){ await deleteRecent(it.id); load(); } }} className="w-9 h-9 rounded-full border border-red-200 dark:border-red-500/20 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 flex items-center justify-center touch-target" aria-label="Delete">
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 4H11M5 4V3C5 2.45 5.45 2 6 2H8C8.55 2 9 2.45 9 3V4M4 4L4.5 11H9.5L10 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/><path d="M6 6.5V9.5M8 6.5V9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-8 bg-paper dark:bg-dark-bg border border-dashed border-zinc-200 dark:border-white/10 rounded-2xl p-4 flex items-start gap-3">
          <span className="w-7 h-7 rounded-full bg-violet text-white flex items-center justify-center text-xs shrink-0">i</span>
          <p className="text-sm leading-relaxed text-ink/70 dark:text-white/70">Recent is capped at 24 items (oldest pruned). Stored via <code className="px-1 py-0.5 rounded bg-zinc-50 dark:bg-white/10">idb-keyval</code> in IndexedDB. Clear anytime in Settings — or with “Clear all” here. Nothing is ever sent to a server.</p>
        </div>
      </div>
    </div>
  );
}

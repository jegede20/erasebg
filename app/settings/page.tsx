"use client";
import { useEffect, useState } from "react";
import { clearRecent, getRecentAll } from "@/lib/recentStore";
import { useSettings } from "@/components/AppShell";

export default function SettingsPage(){
  const { theme, setTheme, defaultFormat, setDefaultFormat } = useSettings();
  const [count, setCount] = useState(0);
  const [storageEst, setStorageEst] = useState<string>("—");

  const refresh = async () => {
    const all = await getRecentAll();
    setCount(all.length);
    if (navigator.storage?.estimate) {
      try {
        const est = await navigator.storage.estimate();
        const used = est.usage ? (est.usage/1024/1024).toFixed(1)+" MB" : "—";
        setStorageEst(used + (est.quota ? ` of ${(est.quota/1024/1024/1024).toFixed(1)} GB` : ""));
      } catch { setStorageEst("—"); }
    }
  };
  useEffect(()=>{ refresh(); }, []);

  const clearAll = async () => {
    if (!confirm("Delete all recent images and clear settings? This cannot be undone.")) return;
    await clearRecent();
    localStorage.removeItem("erasebg-theme");
    localStorage.removeItem("erasebg-format");
    localStorage.removeItem("erasebg-model-cached");
    if ("caches" in window) {
      try { const ks = await caches.keys(); for (const k of ks) await caches.delete(k); } catch {}
    }
    alert("Cleared! Reloading…");
    location.reload();
  };

  return (
    <div className="flex-1 dot-grid">
      <div className="mx-auto max-w-[860px] px-4 md:px-6 py-8">
        <h1 className="font-heading font-extrabold fluid-h2">Settings</h1>
        <p className="text-sm text-ink/60 dark:text-white/60 mt-1">Theme, export defaults, and data — all stored locally.</p>

        <div className="mt-6 space-y-4">
          <div className="bg-surface dark:bg-dark-surface rounded-2xl p-5 border border-zinc-200 dark:border-white/10">
            <h2 className="font-heading font-bold">Appearance</h2>
            <p className="text-sm text-ink/60 dark:text-white/60 mt-1">Light and dark mode. Works offline.</p>
            <div className="mt-4 flex gap-2">
              {[
                { id:"light", label:"Light" },
                { id:"dark", label:"Dark" },
              ].map(o=> (
                <button key={o.id} onClick={()=> setTheme(o.id as any)} className={`flex-1 py-3 rounded-full text-sm font-semibold border touch-target ${theme===o.id ? "bg-ink text-white dark:bg-white dark:text-ink border-ink dark:border-white" : "border-zinc-200 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/10"}`}>
                  {o.label} {theme===o.id ? "•" : ""}
                </button>
              ))}
            </div>
            <p className="text-xs text-ink/40 dark:text-white/40 mt-2">Tip: also respects system preference on first visit.</p>
          </div>

          <div className="bg-surface dark:bg-dark-surface rounded-2xl p-5 border border-zinc-200 dark:border-white/10">
            <h2 className="font-heading font-bold">Default export format</h2>
            <p className="text-sm text-ink/60 dark:text-white/60 mt-1">PNG keeps transparency; JPG needs a background.</p>
            <div className="mt-4 flex gap-2">
              <button onClick={()=> setDefaultFormat("png")} className={`flex-1 py-3 rounded-full text-sm font-semibold border touch-target ${defaultFormat==="png" ? "bg-violet text-white border-violet" : "border-zinc-200 dark:border-white/10"}`}>PNG (transparent)</button>
              <button onClick={()=> setDefaultFormat("jpg")} className={`flex-1 py-3 rounded-full text-sm font-semibold border touch-target ${defaultFormat==="jpg" ? "bg-violet text-white border-violet" : "border-zinc-200 dark:border-white/10"}`}>JPG (with background)</button>
            </div>
          </div>

          <div className="bg-surface dark:bg-dark-surface rounded-2xl p-5 border border-zinc-200 dark:border-white/10">
            <h2 className="font-heading font-bold">Storage</h2>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div className="bg-paper dark:bg-dark-bg rounded-xl p-3 border border-zinc-200 dark:border-white/10">
                <p className="text-xs text-ink/50 dark:text-white/50">Recent images</p>
                <p className="text-lg font-bold">{count} / 24</p>
                <p className="text-xs text-ink/50 dark:text-white/50">IndexedDB (idb-keyval)</p>
              </div>
              <div className="bg-paper dark:bg-dark-bg rounded-xl p-3 border border-zinc-200 dark:border-white/10">
                <p className="text-xs text-ink/50 dark:text-white/50">Estimated usage</p>
                <p className="text-sm font-semibold mt-1">{storageEst}</p>
                <p className="text-xs text-ink/50 dark:text-white/50">Includes cached model (~15 MB)</p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={async()=>{ if(confirm(`Delete ${count} recent images?`)){ await clearRecent(); refresh(); } }} className="px-4 py-2 rounded-full border border-zinc-200 dark:border-white/10 text-sm font-medium hover:bg-black/5 dark:hover:bg-white/10 touch-target">Clear Recent</button>
              <button onClick={clearAll} className="px-4 py-2 rounded-full bg-red-600 text-white text-sm font-semibold hover:bg-red-700 touch-target">Clear all data</button>
            </div>
            <p className="text-xs text-ink/50 dark:text-white/50 mt-3 leading-relaxed">Clears IndexedDB, localStorage, and Cache API (including the downloaded model). No server data to delete — everything was already on-device.</p>
          </div>


        </div>

        <div className="mt-6 text-xs text-ink/60 dark:text-white/60 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-xl p-3">
          <strong>License reminder:</strong> Before adding ads or paid plans, double-check your background-removal model’s license. Prefer a permissive one (MIT/Apache-2.0) for commercial use — some popular models are non-commercial only.
        </div>
      </div>
    </div>
  );
}

"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Uploader from "@/components/Uploader";
import CheckerPreview from "@/components/CheckerPreview";
import { useImage } from "@/components/AppShell";
import { useState } from "react";

export default function LandingPage() {
  const router = useRouter();
  const { setCurrent } = useImage();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showBefore, setShowBefore] = useState(true);

  const handleFile = (file: File) => {
    const url = URL.createObjectURL(file);
    setCurrent(file, url, url);
    router.push("/editor");
  };

  const demoBefore = "/demo-before.jpg";
  const demoAfter = "/demo-after.png";
  const samples = ["/sample1-before.jpg", "/sample2-before.jpg"];

  const afterMap: Record<string, string> = {
    "/demo-before.jpg": "/demo-after.png",
    "/sample1-before.jpg": "/sample1-after.png",
    "/sample2-before.jpg": "/sample2-after.png",
  };
  const activeBefore = previewUrl || demoBefore;
  const activeAfter = previewUrl ? (afterMap[previewUrl] || previewUrl) : demoAfter;

  return (
    <div className="flex-1 flex flex-col dot-grid">
      {/* hero */}
      <section className="mx-auto w-full max-w-[1160px] px-4 md:px-6 pt-8 md:pt-12 pb-10">
        <div className="grid lg:grid-cols-[1.05fr_0.95fr] gap-8 md:gap-10 items-start">
          <div className="pt-2">
            <div className="inline-flex items-center gap-2 bg-white dark:bg-dark-surface border border-zinc-200 dark:border-white/10 rounded-full px-3.5 py-1.5 text-xs font-medium shadow-sm">
              <span className="w-2 h-2 rounded-full bg-violet animate-pulse" />
              100% on-device • No uploads • Works offline
              <span className="hidden sm:inline-flex items-center gap-1 ml-1 bg-violet text-white px-2.5 py-0.5 rounded-full text-[11px] font-semibold">New</span>
            </div>
            <h1 className="fluid-h1 font-heading font-extrabold mt-5 leading-[0.9] tracking-[-0.03em]">
              Remove any <span className="cut-underline decoration-violet">background</span> in seconds
            </h1>
            <p className="mt-4 text-[16px] md:text-[17px] leading-relaxed text-ink/70 dark:text-white/70 max-w-[560px]">
              Free background remover for mobile and web. Upload a photo, the app erases the background instantly — right in your browser. Private by design.
            </p>

            <div className="mt-6">
              <Uploader onFile={handleFile} />
              <p className="mt-3 text-xs text-ink/60 dark:text-white/60 flex items-center gap-1.5">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden><path d="M6 1.5V6M6 6L4.2 4.2M6 6L7.8 4.2M1.5 8.5V9.5C1.5 10.052 1.948 10.5 2.5 10.5H9.5C10.052 10.5 10.5 10.052 10.5 9.5V8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                By uploading you agree photos never leave your device. No account needed.
              </p>
            </div>

            <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-[560px]">
              {[
                { title: "Free to use", desc: "No watermarks, no limits for personal use.", icon: "✓" },
                { title: "Private by design", desc: "On-device AI — nothing uploaded to a server.", icon: "◐" },
                { title: "Works everywhere", desc: "Mobile, desktop, offline after first load.", icon: "◎" },
              ].map(card => (
                <div key={card.title} className="bg-white dark:bg-dark-surface rounded-2xl p-4 border border-zinc-200 dark:border-white/10 shadow-sm">
                  <div className="w-7 h-7 rounded-full bg-ink text-white dark:bg-white dark:text-ink flex items-center justify-center text-xs font-bold mb-2.5">{card.icon}</div>
                  <h3 className="font-heading font-bold text-sm leading-tight">{card.title}</h3>
                  <p className="text-xs leading-relaxed text-ink/60 dark:text-white/60 mt-1.5">{card.desc}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="lg:sticky lg:top-[84px]">
            <CheckerPreview beforeUrl={activeBefore} afterUrl={activeAfter} showBefore={showBefore} onToggle={setShowBefore} />
            {/* sample picker */}
            <div className="mt-4 flex items-center gap-2.5" suppressHydrationWarning>
              <span className="text-xs font-medium text-ink/60 dark:text-white/60">Try a sample:</span>
              <div className="flex items-center gap-2" suppressHydrationWarning>
                {samples.map((src,i)=> (
                  <button key={i} onClick={()=> { setPreviewUrl(src); setShowBefore(false); }} className={`w-10 h-10 rounded-full overflow-hidden border-2 shadow-sm hover:scale-105 transition-transform touch-target ${previewUrl===src ? "border-violet" : "border-white dark:border-dark-surface"}`} aria-label={`Load sample ${i+1}`} suppressHydrationWarning>
                    <img src={src} alt="" className="w-full h-full object-cover" />
                  </button>
                ))}
                <button onClick={()=> setPreviewUrl(null)} className="ml-1 text-xs px-2.5 py-1 rounded-full border border-zinc-200 dark:border-white/10 bg-white dark:bg-dark-surface hover:bg-zinc-50 dark:hover:bg-white/5">Reset</button>
              </div>
            </div>
            <p className="mt-2 text-xs text-ink/50 dark:text-white/50">Tap Before / After to compare. Checker = transparent. Subject fits the box, background is removed inside.</p>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto w-full max-w-[1160px] px-4 md:px-6 pb-8">
        <div className="rounded-[24px] bg-ink dark:bg-white text-white dark:text-ink p-6 md:p-8 flex flex-col md:flex-row gap-6 md:gap-8 items-start md:items-center justify-between overflow-hidden relative border border-ink dark:border-white">
          <div className="absolute top-0 inset-x-6 h-[1px] opacity-20" style={{background: 'repeating-linear-gradient(90deg, white 0 8px, transparent 8px 14px)'}} aria-hidden />
          <h2 className="font-heading font-bold text-xl md:text-2xl shrink-0">How it works</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 flex-1 w-full">
            {[
              { n: "01", title: "Upload", desc: "Pick from gallery, camera, drag & drop, or paste (Ctrl+V)." },
              { n: "02", title: "Auto-remove", desc: "AI runs on your device. See progress — first time downloads the model." },
              { n: "03", title: "Download", desc: "Choose transparent PNG or JPG with a new background. Saved to Recent." },
            ].map(step=> (
              <div key={step.n} className="flex gap-3">
                <span className="w-8 h-8 rounded-full bg-white text-ink dark:bg-ink dark:text-white flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">{step.n}</span>
                <div>
                  <h3 className="font-semibold text-sm">{step.title}</h3>
                  <p className="text-sm opacity-70 leading-relaxed mt-1">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* value cards */}
      <section className="mx-auto w-full max-w-[1160px] px-4 md:px-6 pb-12 grid md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-dark-surface rounded-2xl p-5 border border-zinc-200 dark:border-white/10 shadow-sm">
          <h3 className="font-heading font-bold">No server. Ever.</h3>
          <p className="text-sm text-ink/60 dark:text-white/60 mt-1.5 leading-relaxed">Everything runs in a Web Worker with WebGPU (or WebAssembly fallback). Your photo never leaves your phone or laptop.</p>
          <Link href="/privacy" className="inline-flex mt-3 text-sm font-semibold text-violet hover:underline">Privacy & FAQ →</Link>
        </div>
        <div className="bg-white dark:bg-dark-surface rounded-2xl p-5 border border-zinc-200 dark:border-white/10 shadow-sm">
          <h3 className="font-heading font-bold">PWA — install & go offline</h3>
          <p className="text-sm text-ink/60 dark:text-white/60 mt-1.5 leading-relaxed">Add to home screen. After first load the app and model are cached. Works on the plane.</p>
          <span className="inline-flex mt-3 text-sm font-medium text-ink/50 dark:text-white/50">Look for “Install” in your browser menu</span>
        </div>
        <div className="bg-white dark:bg-dark-surface rounded-2xl p-5 border border-zinc-200 dark:border-white/10 shadow-sm relative overflow-hidden">
          <div className="absolute -right-6 -top-6 w-20 h-20 rounded-full bg-violet/5" aria-hidden />
          <h3 className="font-heading font-bold">Ready to erase?</h3>
          <p className="text-sm text-ink/60 dark:text-white/60 mt-1.5 leading-relaxed">Start now — free, no signup.</p>
          <Link href="/editor" className="inline-flex mt-3 bg-violet text-white px-5 py-2 rounded-full text-sm font-semibold hover:bg-[#5A3FE6] transition-colors touch-target shadow-sm">Open editor</Link>
        </div>
      </section>

      <footer className="mt-auto border-t border-zinc-200 dark:border-white/10 bg-white dark:bg-dark-surface">
        <div className="mx-auto max-w-[1160px] px-4 md:px-6 py-8">
          <div className="flex flex-col md:flex-row gap-8 justify-between">
            <div>
              <div className="flex items-center gap-2.5">
                <svg width="28" height="28" viewBox="0 0 36 36" fill="none" aria-hidden><rect width="36" height="36" rx="10" fill="#6C4DFF"/><rect x="8" y="9" width="20" height="4" rx="1.25" fill="white"/><rect x="8" y="16" width="14" height="4" rx="1.25" fill="white"/><rect x="8" y="23" width="7" height="4" rx="1.25" fill="#19D3A2"/><rect x="17.5" y="23" width="7" height="4" rx="1.25" fill="#19D3A2" opacity="0.7"/><rect x="27" y="23" width="6" height="4" rx="1.25" fill="#19D3A2" opacity="0.4"/></svg>
                <span className="font-heading font-extrabold tracking-tight"><span className="text-ink dark:text-white">Erase</span><span className="text-violet">bg</span></span>
              </div>
              <p className="text-sm text-ink/60 dark:text-white/60 mt-3 max-w-[320px] leading-relaxed">Free, private, on-device background remover. No uploads, no accounts, works offline after first load.</p>
            </div>
            <div className="flex gap-10 text-sm">
              <div>
                <p className="font-semibold">Product</p>
                <ul className="mt-3 space-y-2 text-ink/60 dark:text-white/60">
                  <li><Link href="/editor" className="hover:text-violet">Editor</Link></li>
                  <li><Link href="/recent" className="hover:text-violet">Recent</Link></li>
                  <li><Link href="/privacy" className="hover:text-violet">Privacy</Link></li>
                </ul>
              </div>
              <div>
                <p className="font-semibold">Resources</p>
                <ul className="mt-3 space-y-2 text-ink/60 dark:text-white/60">
                  <li><Link href="/settings" className="hover:text-violet">Settings</Link></li>
                  <li><Link href="/privacy" className="hover:text-violet">FAQ</Link></li>
                  <li><span className="text-ink/40">Model: permissive license</span></li>
                </ul>
              </div>
            </div>
          </div>
          <div className="mt-8 pt-6 border-t border-zinc-200 dark:border-white/10 flex flex-col md:flex-row gap-2 justify-between text-xs text-ink/50 dark:text-white/50">
            <p>© {new Date().getFullYear()} Erasebg — Free, private, on-device.</p>
            <p>Photos never leave your device. Built for mobile & desktop.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

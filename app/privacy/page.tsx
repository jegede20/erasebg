import Link from "next/link";

export default function PrivacyPage(){
  return (
    <div className="flex-1 dot-grid">
      <div className="mx-auto max-w-[860px] px-4 md:px-6 py-8">
        <h1 className="font-heading font-extrabold fluid-h2">Privacy & FAQ</h1>
        <p className="text-ink/60 dark:text-white/60 mt-2">Your photos never leave your device. Here’s how Erasebg works.</p>

        <div className="mt-6 bg-white dark:bg-dark-surface rounded-[20px] p-6 text-ink dark:text-white relative overflow-hidden border border-zinc-200 dark:border-white/10">
          <div className="absolute -right-8 -top-8 w-28 h-28 rounded-full bg-violet/5" aria-hidden />
          <h2 className="font-heading font-bold text-lg">Private by design</h2>
          <ul className="mt-3 space-y-2 text-sm leading-relaxed">
            <li className="flex gap-2"><span>✓</span><span><strong>No uploads.</strong> The AI model runs in a Web Worker in your browser (WebGPU when available, WebAssembly fallback).</span></li>
            <li className="flex gap-2"><span>✓</span><span><strong>No accounts, no backend.</strong> This is a static site on Vercel — there’s no server to receive your images.</span></li>
            <li className="flex gap-2"><span>✓</span><span><strong>No tracking pixels on your photos.</strong> We don’t log image content.</span></li>
            <li className="flex gap-2"><span>✓</span><span><strong>Offline after first load.</strong> PWA + Service Worker cache the app and the model. Airplane mode works.</span></li>
          </ul>
        </div>

        <div className="mt-6 grid md:grid-cols-2 gap-4">
          <div className="bg-surface dark:bg-dark-surface rounded-2xl p-5 border border-zinc-200 dark:border-white/5">
            <h3 className="font-heading font-bold">Where are my images stored?</h3>
            <p className="text-sm text-ink/60 dark:text-white/60 mt-1.5 leading-relaxed">Only on your device. Recent images use <code className="px-1 py-0.5 rounded bg-zinc-50 dark:bg-white/10">idb-keyval</code> (IndexedDB). Settings use <code className="px-1 py-0.5 rounded bg-zinc-50 dark:bg-white/10">localStorage</code>. Clear them in Settings or Recent → Clear all. Uninstalling the PWA or clearing site data removes everything.</p>
          </div>
          <div className="bg-surface dark:bg-dark-surface rounded-2xl p-5 border border-zinc-200 dark:border-white/5">
            <h3 className="font-heading font-bold">What about the model download?</h3>
            <p className="text-sm text-ink/60 dark:text-white/60 mt-1.5 leading-relaxed">First run downloads ~15 MB. You’ll see a progress bar with a “first time only” note. It’s cached via the Cache API. If offline and the model isn’t cached yet, we fall back to a lightweight on-device mode so you still get a result.</p>
          </div>
        </div>

        <div className="mt-8 bg-surface dark:bg-dark-surface rounded-[20px] border border-zinc-200 dark:border-white/5 p-6">
          <h2 className="font-heading font-bold text-lg">FAQ</h2>
          <div className="mt-4 space-y-5">
            {[
              { q:"Is it really free? Any watermarks?", a:"Yes — free for personal use, no watermarks. If you plan to put it behind ads or a paid plan, check the model license first. Some popular background-removal models are non-commercial." },
              { q:"Which files are supported?", a:"PNG, JPG and WEBP. Max ~25 MB. Very large photos are downscaled to ~2000px on the long edge before processing to avoid out-of-memory, but export uses the best resolution possible." },
              { q:"Camera or paste not working?", a:"Browser will ask for camera/clipboard permission. If you deny it, we show a clear message. On iOS, use “Choose from gallery” or drag & drop on desktop. Paste with Ctrl+V (or ⌘+V). If unsupported, try updating your browser." },
              { q:"Does it work offline?", a:"Yes, after the first visit. The PWA manifest + service worker cache the app shell and model. You can install it: on mobile, “Add to Home Screen”; on desktop, the install icon in the address bar." },
              { q:"PNG or JPG for export?", a:"PNG keeps transparency (checkerboard). JPG needs a background — pick Transparent → we’ll fill white, or choose a solid color / custom image background. Presets: Original, Square (1080×1080), Passport (600×750), Social (1080×1350)." },
              { q:"How do crop & resize interact?", a:"Crop uses react-image-crop with Free, 1:1, 4:5, 16:9 and Passport presets. Resize sets pixel dimensions with a locked aspect toggle. They combine before export." },
              { q:"What if WebGPU isn’t available?", a:"We automatically fall back to WebAssembly. Inference is slower but still on-device and private. You’ll still see the same progress UI." },
              { q:"Can I use this commercially?", a:"The code is yours. But verify the chosen model’s license — some require a commercial agreement. Prefer a permissive license (e.g., MIT/Apache-2.0) if you’ll monetize." },
            ].map(item=> (
              <details key={item.q} className="group rounded-xl border border-zinc-200 dark:border-white/5 bg-paper dark:bg-dark-bg px-4 py-3 open:bg-white dark:open:bg-white/[0.03]">
                <summary className="list-none flex items-center justify-between gap-3 cursor-pointer font-medium text-sm">
                  {item.q}
                  <span className="w-7 h-7 rounded-full bg-zinc-50 dark:bg-white/10 flex items-center justify-center group-open:rotate-180 transition-transform">⌄</span>
                </summary>
                <p className="text-sm text-ink/60 dark:text-white/60 leading-relaxed mt-2 pr-2">{item.a}</p>
              </details>
            ))}
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          <Link href="/editor" className="bg-violet text-white px-5 py-2.5 rounded-full text-sm font-semibold hover:bg-[#5A3FE6] touch-target">Open editor</Link>
          <Link href="/settings" className="border border-zinc-200 dark:border-white/10 px-5 py-2.5 rounded-full text-sm font-medium hover:bg-zinc-50 dark:hover:bg-white/10 touch-target">Settings</Link>
        </div>

        <p className="mt-8 text-xs text-ink/40 dark:text-white/40">Last updated: Oct 2026 • If you have questions, open an issue on GitHub. No data is collected from your images.</p>
      </div>
    </div>
  );
}

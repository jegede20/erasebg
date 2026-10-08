"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/editor", label: "Editor", icon: (active:boolean)=> (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="3" y="3" width="14" height="14" rx="2.5" stroke="currentColor" strokeWidth={active?1.8:1.5}/>
      <path d="M7 13L9.5 10.2L11.5 12L14 7" stroke="currentColor" strokeWidth={active?1.8:1.5} strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="8.5" cy="7.5" r="1.25" fill="currentColor"/>
    </svg>
  )},
  { href: "/recent", label: "Recent", icon: (active:boolean)=> (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" strokeWidth={active?1.8:1.5}/>
      <path d="M7 8H13M7 11H11" stroke="currentColor" strokeWidth={active?1.8:1.5} strokeLinecap="round"/>
    </svg>
  )},
  { href: "/settings", label: "Settings", icon: (active:boolean)=> (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="10" cy="10" r="3" stroke="currentColor" strokeWidth={active?1.8:1.5}/>
      <path d="M10 3V4.5M10 15.5V17M3 10H4.5M15.5 10H17M5.3 5.3L6.35 6.35M13.65 13.65L14.7 14.7M14.7 5.3L13.65 6.35M6.35 13.65L5.3 14.7" stroke="currentColor" strokeWidth={active?1.4:1.3} strokeLinecap="round"/>
    </svg>
  )},
];

export default function BottomNav(){
  const pathname = usePathname();
  return (
    <nav aria-label="Mobile bottom navigation" className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-surface/95 dark:bg-dark-surface/95 backdrop-blur-xl border-t border-zinc-200 dark:border-white/5 safe-pb">
      <div className="flex items-center justify-around px-2 py-1.5">
        {tabs.map(t=>{
          const active = pathname === t.href || (t.href==="/editor" && pathname==="/");
          return (
            <Link key={t.href} href={t.href} className={`flex flex-col items-center gap-1 py-1.5 px-6 rounded-2xl transition-colors min-w-[72px] touch-target ${active ? "text-violet" : "text-ink/60 dark:text-white/60"}`}>
              <span className={`p-1 rounded-full ${active ? "bg-violet/10" : ""}`}>{t.icon(active)}</span>
              <span className={`text-[11px] font-medium tracking-wide ${active ? "font-semibold" : ""}`}>{t.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

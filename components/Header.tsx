"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-3 shrink-0" aria-label="Erasebg home">
      <svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
        <rect width="36" height="36" rx="10" fill="#6C4DFF"/>
        {/* E */}
        <rect x="8" y="9" width="20" height="4" rx="1.25" fill="white"/>
        <rect x="8" y="16" width="14" height="4" rx="1.25" fill="white"/>
        {/* bottom three mint squares fading */}
        <rect x="8" y="23" width="7" height="4" rx="1.25" fill="#19D3A2" />
        <rect x="17.5" y="23" width="7" height="4" rx="1.25" fill="#19D3A2" opacity="0.7"/>
        <rect x="27" y="23" width="6" height="4" rx="1.25" fill="#19D3A2" opacity="0.4"/>
      </svg>
      <span className="font-heading font-extrabold text-[22px] tracking-tight leading-none">
        <span className="text-ink dark:text-white">Erase</span><span className="text-violet">bg</span>
      </span>
    </Link>
  );
}

const navItems = [
  { href: "/editor", label: "Editor" },
  { href: "/recent", label: "Recent" },
  { href: "/privacy", label: "Privacy" },
  { href: "/settings", label: "Settings" },
];

export default function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 bg-paper/80 dark:bg-dark-bg/80 backdrop-blur-md border-b border-zinc-200 dark:border-white/[0.06]">
      <div className="mx-auto max-w-[1160px] px-4 md:px-6 h-[64px] flex items-center justify-between gap-4">
        <Logo />
        {/* desktop nav */}
        <nav className="hidden md:flex items-center gap-1" aria-label="Primary">
          {navItems.map(item => {
            const active = pathname === item.href;
            return (
              <Link key={item.href} href={item.href}
                className={`px-3.5 py-2 rounded-full text-sm font-medium transition-colors touch-target flex items-center
                  ${active ? "bg-ink text-white dark:bg-white dark:text-ink" : "text-ink/70 dark:text-white/70 hover:bg-zinc-50 dark:hover:bg-white/10 hover:text-ink dark:hover:text-white"}`}>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="hidden md:flex items-center gap-2">
          <Link href="/editor" className="inline-flex items-center gap-2 bg-violet text-white px-5 py-2.5 rounded-full text-sm font-semibold hover:bg-[#5A3FE6] transition-colors touch-target shadow-sm">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M8 3.5V12.5M3.5 8H12.5" stroke="white" strokeWidth="1.5" strokeLinecap="round"/></svg>
            Upload
          </Link>
        </div>

        {/* mobile hamburger */}
        <button
          className="md:hidden p-2 rounded-full hover:bg-zinc-50 dark:hover:bg-white/10 touch-target"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(v => !v)}
        >
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden>
            {mobileOpen ? (
              <path d="M5 5L17 17M17 5L5 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            ) : (
              <path d="M3 6H19M3 11H19M3 16H19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            )}
          </svg>
        </button>
      </div>
      {/* mobile drawer */}
      {mobileOpen && (
        <div className="md:hidden border-t border-zinc-200 dark:border-white/5 bg-surface dark:bg-dark-surface">
          <nav className="px-4 py-3 flex flex-col gap-1" aria-label="Mobile primary">
            {navItems.map(item => (
              <Link key={item.href} href={item.href} onClick={()=>setMobileOpen(false)}
                className={`px-4 py-3 rounded-xl text-[15px] font-medium touch-target flex items-center justify-between ${pathname===item.href ? "bg-ink text-white dark:bg-white dark:text-ink" : "hover:bg-zinc-50 dark:hover:bg-white/5"}`}>
                {item.label}
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M6 3L11 8L6 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </Link>
            ))}
            <Link href="/editor" onClick={()=>setMobileOpen(false)} className="mt-2 bg-violet text-white rounded-full py-3 text-center font-semibold touch-target flex items-center justify-center gap-2">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3.5V12.5M3.5 8H12.5" stroke="white" strokeWidth="1.5" strokeLinecap="round"/></svg>
              Upload image
            </Link>
          </nav>
        </div>
      )}
    </header>
  );
}

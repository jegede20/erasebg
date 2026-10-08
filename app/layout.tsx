import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, DM_Sans } from "next/font/google";
import "./globals.css";
import AppShell from "@/components/AppShell";

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["600","700","800"],
  variable: "--font-bricolage",
  display: "swap",
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400","500","600"],
  variable: "--font-dm",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Erasebg — Remove any background in seconds",
  description: "Free background remover that works on mobile and web. 100% on-device, private, no uploads.",
  manifest: "/manifest.json",
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#6C4DFF",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${bricolage.variable} ${dmSans.variable}`}>
      <head>
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
      </head>
      <body className="min-h-screen flex flex-col font-body antialiased">
        <AppShell>{children}</AppShell>
        <script dangerouslySetInnerHTML={{__html: `
          (function(){
            try{
              var t=localStorage.getItem('erasebg-theme');
              if(t==='dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches)){
                document.documentElement.classList.add('dark');
              }
              if('serviceWorker' in navigator){
                window.addEventListener('load', function(){
                  navigator.serviceWorker.register('/sw.js').catch(function(){});
                });
              }
            }catch(e){}
          })();
        `}} />
      </body>
    </html>
  );
}

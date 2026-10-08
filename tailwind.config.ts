import type { Config } from "tailwindcss";
const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        violet: '#6C4DFF',
        mint: '#19D3A2',
        ink: '#0F1020',
        paper: '#FAFAFB',
        surface: '#FFFFFF',
        checker: '#E9E9EF',
        dark: {
          bg: '#0B0B12',
          surface: '#14141F',
          muted: '#1E1E2E'
        }
      },
      fontFamily: {
        heading: ['var(--font-bricolage)','sans-serif'],
        body: ['var(--font-dm)','sans-serif'],
      },
      boxShadow: {
        card: '0 4px 24px rgba(15,16,32,0.08)',
        floating: '0 16px 40px rgba(15,16,32,0.12)'
      }
    },
  },
  plugins: [],
};
export default config;

import type { Config } from 'tailwindcss'

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        carbon: '#191c1b', paper: '#f3eedf', sheet: '#fffcf4', recessed: '#e9e3d5',
        pencil: '#3155c6', leaf: '#287259', citron: '#ddf07a', coral: '#a63e31', rule: '#c9c5b9',
        ink: '#191c1b', muted: '#565b57', 'paper-deep': '#e9e3d5', cobalt: '#3155c6', teal: '#287259',
      },
      fontFamily: {
        sans: ['Instrument Sans', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['Newsreader', 'Georgia', 'ui-serif', 'serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: { sheet: '0 2px 0 rgb(25 28 27 / .06), 0 8px 20px rgb(25 28 27 / .045)', card: '0 2px 0 rgb(25 28 27 / .05), 0 12px 28px rgb(25 28 27 / .07)' },
      borderRadius: { sheet: '12px' },
    },
  },
  plugins: [],
} satisfies Config

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  // Capacitor's hash-routed bundle is loaded from the device filesystem and
  // needs relative assets. The hosted BrowserRouter build must use root
  // assets so Netlify deep links (including Plaid's OAuth return path) do not
  // resolve JavaScript from a nested route such as /open/assets/.
  base: process.env.VITE_ROUTER_MODE === 'hash' ? './' : '/',
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, './src'), '@budgefi/contracts': path.resolve(__dirname, './packages/contracts/src/index.ts') } },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4422',
        changeOrigin: true,
        rewrite: value => value.replace(/^\/api/, ''),
      },
    },
  },
})

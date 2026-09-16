import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API_TARGET = process.env.NETCLIP_DEV_API || 'http://127.0.0.1:3210'

export default defineConfig({
  plugins: [react()],
  // Built straight into the server's static dir so `node server/src/index.js`
  // serves the exact same bundle in dev-build and in Docker.
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    host: true, // listen on 0.0.0.0 so a phone on the LAN can hit the dev server too
    port: 3211,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      // SSE needs buffering off; vite's proxy passes it through fine.
      '/api/events': { target: API_TARGET, changeOrigin: true, ws: false },
    },
  },
})

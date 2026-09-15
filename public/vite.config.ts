import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 公开页是独立应用。它将来要落在境外，管理端留在本机，
// 所以这里只连 /public 那几条只读路由，不碰 /api。
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@core': fileURLToPath(new URL('../core/src', import.meta.url)) } },
  server: {
    fs: { allow: ['..'] },
    proxy: { '/public': 'http://127.0.0.1:3000' },
  },
})

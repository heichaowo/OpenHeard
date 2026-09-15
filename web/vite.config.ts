import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('../core/src', import.meta.url)),
    },
  },
  server: {
    // core 在 web/ 之外
    fs: { allow: ['..'] },
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  test: {
    include: ['../core/src/**/*.test.ts'],
  },
})

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
    // core/ 没有自己的 package.json，它的测试挂在这里跑。
    include: ['../core/src/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['./src/testSetup.ts'],
    // 一个文件的第一条界面测试要替 antd 组件付首次加载的钱，单跑 1 到 2 秒。
    // 机器一忙就过了缺省的 5 秒，CI 和本地都因此误报过。真卡死照样抓得到。
    testTimeout: 15_000,
  },
})

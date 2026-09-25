import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    fs: {
      // 允许访问上级目录（盯盘工具/）下的交易日历 JSON（2026交易日.json）
      allow: ['..']
    }
  }
})

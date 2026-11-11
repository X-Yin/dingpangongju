import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  preview: {
    port: 5173,
    strictPort: true, // 端口被占用时直接报错，而不是自动换端口
    host: true,       // 可选：允许局域网访问；默认只监听 localhost
  },
  server: {
    host: true,
    fs: {
      // 允许访问上级目录（盯盘工具/）下的交易日历 JSON（2026交易日.json）
      allow: ['..']
    },
    // 开启 COOP/COEP，使 performance.measureUserAgentSpecificMemory() 可用
    // 该 API 返回进程级内存估算，口径接近 Chrome 任务管理器
    // credentialless 模式不拦截跨域资源，适合本地开发和小型项目
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  // 生产构建输出同样带上 COOP/COEP
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    port: 5173,
    strictPort: true, // 端口被占用时直接报错，而不是自动换端口
    host: true,       // 可选：允许局域网访问；默认只监听 localhost
  },
})

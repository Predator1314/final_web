import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 3000,
    open: true
  },
  // 静态资源目录（默认就是 public）
  publicDir: 'public'
})
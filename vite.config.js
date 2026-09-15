import { defineConfig } from 'vite'

export default defineConfig({
  // 相对路径，保证部署到 GitHub Pages 子路径也能正确加载资源
  base: './',
  server: {
    port: 3000,
    open: true
  },
  // 静态资源目录（默认就是 public）
  publicDir: 'public'
})
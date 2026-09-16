import { defineConfig } from 'vite'

export default defineConfig(({ command }) => ({
  // 构建时用 GitHub Pages 子路径（仓库名 final_web），本地开发用根路径
  base: command === 'build' ? '/final_web/' : '/',
  server: {
    port: 3000,
    open: true
  },
  // 静态资源目录（默认就是 public）
  publicDir: 'public'
}))
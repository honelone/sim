import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // 部署在 GitHub Pages 的 /sim/ 子路径下
  base: '/sim/',
  plugins: [vue()],
  server: {
    host: true,
    open: false
  }
})

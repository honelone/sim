import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// GitHub Pages 没有服务端重写规则：深链刷新（如 /sim/arc）会直接 404。
// 构建结束后复制一份 index.html 作为 404.html 兜底，交由前端路由接管。
function spaFallback() {
  let outDir = resolve(process.cwd(), 'dist')
  return {
    name: 'spa-404-fallback',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      copyFileSync(resolve(outDir, 'index.html'), resolve(outDir, '404.html'))
    }
  }
}

export default defineConfig({
  // 部署在 GitHub Pages 的 /sim/ 子路径下
  base: '/sim/',
  plugins: [vue(), spaFallback()],
  server: {
    host: true,
    open: false
  }
})

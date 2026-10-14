import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['ws'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          gateway: resolve(__dirname, 'src/gateway/proxy.cjs'),
          // RT agent：ws 必须打包进产物（utilityProcess 需磁盘上的自包含单文件）
          agent: resolve(__dirname, 'src/agent/agent.js')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [vue()],
    resolve: {
      alias: { '@': resolve(__dirname, 'src/renderer/src') }
    }
  }
})

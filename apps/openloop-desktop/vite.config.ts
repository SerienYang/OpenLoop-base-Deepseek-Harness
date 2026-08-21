import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'safari13',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        credentials: resolve(import.meta.dirname, 'src/credentials.html'),
      },
    },
  },
})

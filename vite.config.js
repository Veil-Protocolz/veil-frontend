import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      buffer: 'buffer',
    },
  },
  // snarkjs needs these Node built-ins shimmed
  optimizeDeps: {
    include: ['buffer', 'snarkjs'],
    esbuildOptions: {
      target: 'es2020',
      define: { global: 'globalThis' },
    },
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 2000,
  },
  // Serve circuit files with no caching limit
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})

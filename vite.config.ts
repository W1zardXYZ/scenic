import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./web', import.meta.url)) } },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Libraries change far less often than the app, so browsers keep them across updates.
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: 'react', test: /node_modules\/(react|react-dom|scheduler)\// },
            { name: 'ui', test: /node_modules\// },
          ],
        },
      },
    },
  },
  server: {
    // Anchored so source files such as /api.ts and /profiles.ts stay with Vite.
    proxy: Object.fromEntries(['^/api/', '^/thumb/', '^/profile/'].map((path) => [path, 'http://localhost:8420'])),
  },
})

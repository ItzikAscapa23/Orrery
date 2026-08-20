import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // SPA fallback: serve index.html for all non-asset paths so /features/:id
  // works on direct navigation and browser refresh.
  appType: 'spa',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
});

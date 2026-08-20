import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const name = env['VITE_PRODUCT_NAME'] ?? 'Orrery';
  return {
    plugins: [
      react(),
      {
        name: 'html-product-name',
        transformIndexHtml(html: string) {
          return html.replace('%VITE_PRODUCT_NAME%', name);
        },
      },
    ],
    // SPA fallback: serve index.html for all non-asset paths so /features/:id
    // works on direct navigation and browser refresh.
    appType: 'spa',
    server: {
      port: 5173,
      proxy: {
        '/api': { target: 'http://localhost:3001', rewrite: (p) => p.replace(/^\/api/, '') },
      },
    },
  };
});

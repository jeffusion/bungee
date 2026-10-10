import { defineConfig } from 'vite';
import base from '../../packages/ui/vite.config';
const local = new URL(process.env.PUBLICATION_UI_URL ?? 'http://127.0.0.1:28287');
if (!['127.0.0.1', 'localhost'].includes(local.hostname)) throw new Error('Only disposable local UI services are permitted');
const uiPort = Number(local.port || 80);
const management = `http://${local.hostname}:${process.env.BUNGEE_MANAGEMENT_PORT ?? uiPort + 2}`;

// Browser acceptance must use this checkout and a disposable management service.
export default defineConfig({
  ...base,
  server: {
    host: '127.0.0.1', port: uiPort, strictPort: true,
    proxy: {
      '/api': { target: management, changeOrigin: true },
      '/plugins': { target: management, changeOrigin: true },
    },
  },
});

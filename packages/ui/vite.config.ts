import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte({
    preprocess: vitePreprocess()
  })],
  base: '/__ui/',
  resolve: {
    conditions: ['browser', 'module', 'import'],
  },
  optimizeDeps: {
    exclude: ['svelte-spa-router']
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    minify: 'esbuild',
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: undefined
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/__ui/api': {
        target: 'http://localhost:8088',
        changeOrigin: true
      }
    }
  }
});

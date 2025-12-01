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
        manualChunks: (id) => {
          // Chart.js and related libraries
          if (id.includes('chart.js') || id.includes('svelte-chartjs')) {
            return 'vendor-charts';
          }

          // Lodash utilities
          if (id.includes('lodash-es')) {
            return 'vendor-lodash';
          }

          // Svelte framework and core libraries
          if (id.includes('svelte') && !id.includes('svelte-chartjs')) {
            return 'vendor-svelte';
          }

          // Other node_modules dependencies
          if (id.includes('node_modules')) {
            return 'vendor';
          }
        }
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

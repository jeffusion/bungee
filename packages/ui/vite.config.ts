import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import path from 'path';

export default defineConfig({
  plugins: [svelte({
    preprocess: vitePreprocess()
  })],
  base: '/__ui/',
  resolve: {
    conditions: ['browser', 'module', 'import'],
    alias: {
      // 插件 SDK 别名
      '@bungee/plugin-sdk': path.resolve(__dirname, 'src/lib/plugin-sdk/index.ts'),
      // 插件目录别名
      '@plugins': path.resolve(__dirname, '../../plugins'),
    },
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
          // Only split very specific large libraries to avoid circular dependencies
          // Chart.js (don't include svelte-chartjs to avoid circular deps)
          if (id.includes('node_modules/chart.js')) {
            return 'vendor-charts';
          }

          // Lodash utilities
          if (id.includes('node_modules/lodash-es')) {
            return 'vendor-lodash';
          }

          // All other node_modules go into a single vendor chunk
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

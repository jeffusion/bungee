import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'url';
import path from 'path';

export default defineConfig({
  plugins: [
    svelte({
      preprocess: vitePreprocess(),
      compilerOptions: {
        // disable hmr to avoid Svelte4-era hot runtime packages reaching runtime in Task3
        hmr: false,
      },
    }),
  ],
  base: '/__ui/',
  resolve: {
    conditions: ['browser', 'module', 'import'],
    alias: [
      { find: /^\$utils\/(.+)/, replacement: `${path.resolve(fileURLToPath(new URL('./src/utils', import.meta.url)))}/$1` },
      { find: '$utils', replacement: path.resolve(fileURLToPath(new URL('./src/utils.ts', import.meta.url))) },
      { find: '$components', replacement: path.resolve(fileURLToPath(new URL('./src/components', import.meta.url))) },
      { find: '$api', replacement: path.resolve(fileURLToPath(new URL('./src/api', import.meta.url))) },
      { find: '$stores', replacement: path.resolve(fileURLToPath(new URL('./src/stores', import.meta.url))) },
      { find: '$i18n', replacement: path.resolve(fileURLToPath(new URL('./src/i18n', import.meta.url))) },
      { find: '$pluginSdk', replacement: path.resolve(fileURLToPath(new URL('./src/plugin-sdk', import.meta.url))) },
      { find: '$validation', replacement: path.resolve(fileURLToPath(new URL('./src/validation', import.meta.url))) },
      { find: '$types', replacement: path.resolve(fileURLToPath(new URL('./src/types', import.meta.url))) },
      { find: '$hooks', replacement: path.resolve(fileURLToPath(new URL('./src/hooks', import.meta.url))) },
      { find: '$lib', replacement: path.resolve(fileURLToPath(new URL('./src', import.meta.url))) },
      { find: '@bungee/plugin-sdk', replacement: path.resolve(fileURLToPath(new URL('./src/plugin-sdk/index.ts', import.meta.url))) },
      { find: '@plugins', replacement: path.resolve(fileURLToPath(new URL('../../plugins', import.meta.url))) },
    ],
  },
  optimizeDeps: {
    include: [
      'ajv-dist',
      'immutable-json-patch',
      'lodash-es',
      'jmespath'
    ],
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
      '/api/plugins': { target: 'http://localhost:8088', changeOrigin: true },
      '/__ui/api': {
        target: 'http://localhost:8088',
        changeOrigin: true
      }
    }
  }
});

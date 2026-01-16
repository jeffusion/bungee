/** @type {import('tailwindcss').Config} */
const themeConfig = require('./tailwind.theme.js');

export default {
  content: [
    './index.html',
    './src/**/*.{svelte,js,ts}'
  ],
  theme: {
    extend: {
      ...themeConfig.theme.extend,
    },
  },
  plugins: [
    require('daisyui')
  ],
  daisyui: {
    themes: themeConfig.daisyui.themes,
    darkTheme: 'dark',
  }
}

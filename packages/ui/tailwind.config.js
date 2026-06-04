/** @type {import('tailwindcss').Config} */
const themeConfig = require('./tailwind.theme.js');

module.exports = {
  content: [
    './index.html',
    './src/**/*.{svelte,js,ts}',
  ],
  theme: {
    extend: {
      ...themeConfig.theme.extend,
      colors: {
        ...themeConfig.theme.extend.colors,
      },
    },
  },
  plugins: [],
};

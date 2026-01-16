/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          '"Noto Sans"',
          'sans-serif',
          '"Apple Color Emoji"',
          '"Segoe UI Emoji"',
          '"Segoe UI Symbol"',
          '"Noto Color Emoji"',
        ],
        mono: [
          '"JetBrains Mono"',
          '"Fira Code"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          '"Liberation Mono"',
          '"Courier New"',
          'monospace',
        ],
      },
    },
  },
  daisyui: {
    themes: [
      {
        light: {
          ...require("daisyui/src/theming/themes")["light"],
          "primary": "#4F46E5", // Indigo-600
          "secondary": "#64748B", // Slate-500
          "accent": "#0D9488", // Teal-600
          "neutral": "#1F2937", // Gray-800
          "base-100": "#FFFFFF",
          "base-200": "#F3F4F6", // Gray-100
          "base-300": "#E5E7EB", // Gray-200
        },
        dark: {
          ...require("daisyui/src/theming/themes")["dark"],
          "primary": "#6366F1", // Indigo-500
          "secondary": "#94A3B8", // Slate-400
          "accent": "#14B8A6", // Teal-500
          "neutral": "#191D24", // Adjusted dark neutral
          "base-100": "#1D232A",
          "base-200": "#191E24",
          "base-300": "#15191E",
        },
      },
    ],
  },
}

/**
 * Bungee — Industrial Console Theme
 *
 * Visual language: dark carbon base, **orange** as the single primary accent,
 * cyan/sky as secondary highlight, amber/red reserved for cautions and faults.
 * Hard edges, low-transparency borders, mono-spaced numerics, high contrast.
 */

/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          '"Inter var"',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
        mono: [
          '"DM Mono"',
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
        display: [
          '"Orbitron"',
          '"DM Mono"',
          '"JetBrains Mono"',
          'ui-monospace',
          'monospace',
        ],
      },
      colors: {
        // Surface palette — slightly warmer than pure black, gives panels lift
        carbon: {
          950: '#0a0b0e', // page background — deepest
          900: '#15171c', // primary panel surface
          800: '#1a1d24', // raised panel
          700: '#21252e', // hover surface
          600: '#2a2f3a', // edge / divider strong
          500: '#373d4a', // border / hairline highlight
        },
        // Orange — primary accent (the "torch")
        nexus: {
          50: '#fff7ed',
          100: '#ffedd5',
          200: '#fed7aa',
          300: '#fdba74',
          400: '#fb923c',
          500: '#f97316', // primary
          600: '#ea580c',
          700: '#c2410c',
        },
        hazard: {
          amber: '#f59e0b',
          red: '#ef4444',
          emerald: '#10b981',
          sky: '#38bdf8',
          cyan: '#22d3ee',
        },
      },
      letterSpacing: {
        industrial: '0.08em',
        command: '0.12em',
        chiseled: '0.16em',
        signage: '0.24em',
      },
      boxShadow: {
        'industrial': '0 8px 18px rgba(0, 0, 0, 0.45)',
        'industrial-lg': '0 12px 28px rgba(0, 0, 0, 0.55)',
        'glow-orange': '0 0 12px rgba(249, 115, 22, 0.55)',
        'glow-amber': '0 0 10px rgba(245, 158, 11, 0.55)',
        'glow-red': '0 0 10px rgba(239, 68, 68, 0.55)',
        'glow-emerald': '0 0 10px rgba(16, 185, 129, 0.55)',
      },
      borderRadius: {
        DEFAULT: '2px',
        sm: '0px',
        md: '2px',
        lg: '4px',
      },
    },
  },
};

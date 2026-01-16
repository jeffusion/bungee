# Bungee UI Design System

This package implements the Bungee Design System using **Svelte**, **TailwindCSS**, and **DaisyUI**.

## Development

- **Run Dev Server**: `bun run dev` (in root) or `bun run dev` in `packages/ui`.
- **Build**: `bun run build`.

## Design System Route
Access `/#/design` in the browser to view the live design system showcase, including:
- Color Palette (Semantic & Base)
- Typography Scale
- Button Variants
- Form Elements
- Layout Patterns

## Key Principles
1.  **Utility-First**: Use Tailwind classes for layout and spacing.
2.  **Semantic Colors**: Use `primary`, `secondary`, `error` instead of hex codes.
3.  **DaisyUI Components**: Leverage `btn`, `card`, `input` classes.

## Configuration
- **Theme**: Defined in `tailwind.theme.js`.
- **Config**: `tailwind.config.js`.

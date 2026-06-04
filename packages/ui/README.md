# Bungee UI Design System

This package implements the Bungee industrial design system using **Svelte 5**, **TailwindCSS**, and shadcn-svelte/Bits UI v2 primitives.

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
1. **Utility-First**: Use Tailwind classes for layout and spacing.
2. **Industrial Tokens**: Use `carbon-*`, `nexus-*`, and status colors instead of raw hex values.
3. **Industrial Components**: Prefer `src/components/ui/` (shadcn-svelte5 primitives) for basic controls and `src/components/industrial/` (B* semantic components) for product-specific layouts. The `nx-*` CSS classes remain available as design utilities but are not a preferred component architecture.
4. **No DaisyUI**: DaisyUI is completely removed. All styling uses plain Tailwind CSS.
5. **Svelte 5 Runes**: All new and touched components use Svelte 5 runes and snippets.

## Testing & CI
- **Static Migration Guards**: Run `bun test src/migration-guards.test.ts` to verify architectural boundaries.
- **Playwright Smoke Tests**: Run `bun run test:ui:smoke` in the root directory. This is opt-in during CI and is controlled by the environment variable `CI_UI_SMOKE=1`.

## Configuration
- **Theme**: Defined in `tailwind.theme.js`.
- **Config**: `tailwind.config.js`.

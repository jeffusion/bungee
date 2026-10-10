# Bungee UI Design System

This package implements the Bungee industrial design system using **Svelte 5**, **TailwindCSS**, and shadcn-svelte/Bits UI primitives (versions pinned in package.json).

## Development

- **Run Dev Server**: `bun run dev` in `packages/ui`; root `dev` starts the proxy core.
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
6. **Component Ownership**: Extract repeated DOM into shared components; keep their styles scoped inside the owning component. Sharing class names across copied page markup is forbidden.
7. **No Ad Hoc Global Styles**: Global styles are forbidden by default, including `:global`, standalone stylesheets, CSS imports/injection and component rules in `app.css`. Exceptions must follow [the mandatory isolation rules](./docs/INDUSTRIAL_DESIGN_SYSTEM.md#347-mandatory-component-ownership-and-style-isolation); the frozen legacy baseline does not authorize new globals.

## Testing & CI
- **Static Migration Guards**: Run `bun test src/migration-guards.test.ts` to verify architectural boundaries.
- **Style Isolation Guard**: Run `bun test src/style-scope.test.ts` to reject unregistered global CSS across the UI and all plugin UI directories. This runs in normal CI.
- **Playwright Smoke Tests**: Run `bun run test:ui:smoke` in the root directory. The Linux pull-request CI job runs it directly with strict page assertions. See [local browser commands](../../docs/guides/development.md#ui-smoke).

## Configuration
- **Theme**: Defined in `tailwind.theme.js`.
- **Config**: `tailwind.config.js`.

# @jeffusion/bungee-types

TypeScript type definitions for [Bungee](https://github.com/jeffusion/bungee) - a high-performance reverse proxy server.

## Installation

```bash
npm install @jeffusion/bungee-types
# or
bun add @jeffusion/bungee-types
```

## Usage

```typescript
import type { AppConfig, RouteConfig } from '@jeffusion/bungee-types';

const config: AppConfig = {
  routes: [
    {
      path: '/api',
      endpoints: [
        { target: 'http://localhost:3000' }
      ]
    }
  ]
};
```

## Available Types

### Core Configuration Types
- `AppConfig` - Main application configuration
- `RouteConfig` - Route configuration with upstreams and plugins
- `Endpoint` - Upstream target, weight, conditions and directional rules

### Modification and Plugin Types
- `ModificationRules` - Request/response modification rules
- `PluginConfig` - Plugin configuration
- `LoggingConfig` - Logging configuration

## Type Exports

### Root Entry
```typescript
import type { AppConfig } from '@jeffusion/bungee-types';
```

### Type-Only Export
```typescript
import type { RouteConfig } from '@jeffusion/bungee-types/types';
```

## Documentation

For storage aggregates and runtime validation, see [configuration reference](../../docs/reference/configuration.md). Management identity and proxy Keys are plugin capabilities; an exported TypeScript shape does not bypass configuration validation.

Plugin runtime interfaces use `@jeffusion/bungee-core/plugin`, not this package.

## License

MIT

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
import type { AppConfig, RouteConfig, AuthConfig } from '@jeffusion/bungee-types';

const config: AppConfig = {
  routes: [
    {
      path: '/api',
      upstreams: [
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
- `AuthConfig` - Authentication configuration
- `Upstream` - Upstream server configuration

### Modification and Plugin Types
- `ModificationRules` - Request/response modification rules
- `PluginConfig` - Plugin configuration
- `LoggingConfig` - Logging configuration

## Type Exports

### Default Export
```typescript
import type { AppConfig } from '@jeffusion/bungee-types';
```

### Type-Only Export
```typescript
import type { RouteConfig } from '@jeffusion/bungee-types/types';
```

## Documentation

For full documentation, visit [Bungee Documentation](https://github.com/jeffusion/bungee).

## License

MIT

<div align="center">
  <pre>
 ____   _   _ _   _  ____ _____ _____
| __ ) | | | | \ | |/ ___| ____| ____|
|  _ \ | | | |  \| | |  _|  _| |  _|
| |_) || |_| | |\  | |_| | |___| |___
|____/  \___/|_| \_|\____|_____|_____|

  </pre>
  <h1>Bungee</h1>
  <p><strong>A high-performance, configurable reverse proxy server built for the Bun runtime.</strong></p>

  <p>
    <a href="https://github.com/jeffusion/bungee/actions/workflows/ci.yml">
      <img src="https://github.com/jeffusion/bungee/actions/workflows/ci.yml/badge.svg" alt="CI Status">
    </a>
    <a href="https://github.com/jeffusion/bungee/releases">
      <img src="https://img.shields.io/github/v/release/jeffusion/bungee" alt="GitHub release">
    </a>
    <a href="https://github.com/jeffusion/bungee/blob/main/LICENSE">
      <img src="https://img.shields.io/github/license/jeffusion/bungee" alt="License">
    </a>
    <a href="https://github.com/jeffusion/bungee/stargazers">
      <img src="https://img.shields.io/github/stars/jeffusion/bungee?style=social" alt="GitHub stars">
    </a>
  </p>
</div>

**Languages**: **English** | [中文](README_zh.md)

---

## 🌟 Overview

Bungee is a Bun + TypeScript reverse proxy designed for teams that want high throughput and programmable traffic control in the JS/TS ecosystem.
It combines hot configuration reloads, multi-process execution, plugin-based request/response transformations, and a built-in web dashboard.

### Why Bungee?

- **Developer-native**: Configure and extend gateway behavior in TypeScript-friendly workflows.
- **Production-ready**: Multi-worker architecture, structured logging, health checks, and failover support.
- **Extensible by design**: Plugin system for hooks, APIs, dashboard widgets, and AI provider format conversion.

---

## ✨ Feature Highlights

| Area | Highlights |
|---|---|
| **Runtime & Performance** | Bun runtime, multi-worker architecture, zero-downtime reload |
| **Traffic Control** | Route/upstream layering, load balancing, failover, health checks |
| **Transformation** | Expression engine, request/response mutation, streaming transform support |
| **Operations** | Web dashboard, CLI daemon management, structured logging, Docker support |
| **Extensibility** | Plugin hooks, plugin APIs, native dashboard widget integration |

For technical deep dives, use the docs index in the next section.

---

## 📚 Documentation

Documentation index: [docs/README.md](docs/README.md)

### Start Here

- [Configuration Guide](docs/configuration.md)
- [Core Capabilities](docs/core-capabilities.md)
- [Architecture](docs/architecture.md)
- [Web Dashboard](docs/dashboard.md)
- [CLI Reference](docs/cli.md)
- [Deployment (Docker)](docs/deployment.md)
- [Development Guide](docs/development.md)

### Advanced Topics

- [Plugin System](docs/plugin-system.md)
- [Plugin Development](docs/plugin-development.md)
- [AI Provider Conversion](docs/ai-provider-conversion.md)

---

## 🚀 Quick Start

### Option 1: CLI (Recommended for Production)

```bash
# Initialize configuration (creates ~/.bungee/config.json)
npx bungee init

# Start daemon
npx bungee start

# Check status
npx bungee status
```

### Configuration model

Bungee now uses **Config Model V2** for route failover settings:

- Route request timeouts live under `timeouts`
- Retry / passive health / recovery live under `failover`
- Legacy failover timeout fields are migrated in memory to V2 on load
- Mixed legacy/V2 failover fields in the same route are rejected

See [Configuration Guide](docs/configuration.md) for the current schema.

### Option 2: Docker

```bash
docker-compose up -d
```

### Option 3: Development Mode

```bash
bun install
bun dev
```

Dashboard URL (default): `http://localhost:8088/__ui/`

---

## 🗺️ Roadmap

- [x] Web Dashboard
- [x] CLI Tool
- [x] Streaming Support
- [x] API Transformers
- [x] Plugin System
- [ ] WebSocket Proxying
- [ ] gRPC Proxying
- [ ] Automatic TLS/SSL
- [ ] Prometheus Metrics
- [ ] Rate Limiting

Have an idea? [Open an issue](https://github.com/jeffusion/bungee/issues/new/choose).

---

## 🤝 Contributing

Contributions are welcome.

- Follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
- Open an issue before larger feature work
- Include tests for behavior changes

---

## 📄 License

MIT License. See [LICENSE](LICENSE).

---

<div align="center">
  <p>Made with ⚡ by the Bungee team</p>
  <p>
    <a href="https://github.com/jeffusion/bungee">GitHub</a> •
    <a href="https://github.com/jeffusion/bungee/issues">Issues</a> •
    <a href="https://github.com/jeffusion/bungee/discussions">Discussions</a>
  </p>
</div>

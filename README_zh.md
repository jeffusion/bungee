# Bungee

面向 Bun 的高性能反向代理，支持稳定公共监听器、多 worker、SQLite 配置 revision、滚动发布和 TypeScript 插件。

[English](README.md) | 简体中文

## 能力

- OpenAI、Anthropic、Gemini 协议转换
- 基于 Service / Route / Upstream 的路由、负载均衡和故障转移
- 单 master、多 worker，配置发布期间公共端口保持稳定
- 配置唯一真值 `data/bungee.db`，写入采用 revision CAS 与异步 operation polling
- 独立遥测库 `logs/access.db`
- 严格 v2 插件 catalog、revisioned plugin activation 和可扩展 UI widget
- 内置深色工业风 Dashboard

## 快速开始

```bash
npx bungee init
npx bungee start
```

认证由持久化的全局配置控制。未启用认证时，管理访问为匿名；启用认证后，管理请求必须使用配置中的 token。

```bash
npx bungee status
npx bungee logs
npx bungee stop
```

## 数据路径

CLI 默认使用：

```text
~/.bungee/
├── bin/
├── data/bungee.db
├── logs/access.db
├── bungee.log
├── bungee.error.log
└── bungee.pid
```

配置不再从 JSON、YAML 或 `CONFIG_PATH` 读取。Master 独占配置库，worker 只接收经过 hash、catalog 和 revision 校验的不可变快照。

## Docker

```bash
docker compose up -d
curl http://127.0.0.1:8088/health
```

Compose 持久化 `/usr/app/data` 和 `/usr/app/logs`，不挂载配置文件。

## 配置导入导出

```bash
bungee export --token "$TOKEN" --file bungee-snapshot.json
bungee import --file bungee-snapshot.json --token "$TOKEN"
```

导入是带双 hash 校验的完整替换。认证轮换时增加 `--next-token "$NEW_TOKEN"`。系统不提供 merge import 或自动 rollback API。

## 开发

```bash
bun install --frozen-lockfile
bun run build
bun test
```

项目固定使用 Bun 1.3.14。

## 文档

- [配置与控制 API](docs/configuration.md)
- [运行时架构](docs/architecture.md)
- [部署与备份](docs/deployment.md)
- [插件系统](docs/plugin-system.md)
- [插件开发](docs/plugin-development.md)
- [运维手册](docs/runbook.md)
- [SQLite 配置存储设计](docs/sqlite-configuration-storage.md)

## License

[MIT](LICENSE)

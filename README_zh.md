# Bungee

面向个人部署、基于 Bun 的高性能反向代理，支持稳定公共监听器、多 worker、SQLite 配置 revision、滚动发布和 TypeScript 插件。

[English](README.md) | 简体中文

## 能力

- OpenAI、Anthropic、Gemini 协议转换
- 基于 Service / Route / Upstream 的路由、负载均衡和故障转移
- 单 master、多 worker，配置发布期间公共端口保持稳定
- 配置唯一真值 `data/bungee.db`，写入采用 revision CAS 与异步 operation polling
- 插件业务状态与密钥保存在 `data/plugin-state.db`，遥测保存在 `logs/access.db`
- 严格 schema 3 插件 catalog、revisioned plugin activation 和可扩展 UI widget
- 内置深色工业风 Dashboard

## 快速开始

```bash
npx bungee init
npx bungee start
```

`init` 建立 SQLite 配置库及插件状态库，不生成凭证。管理入口默认匿名，代理路由默认公开。需要登录管理时，在插件中心启用“管理认证”（`local-accounts`），建立或验证唯一管理员，使用 Cookie／Bearer 会话；显式停用后恢复匿名管理。

需要限制代理访问时，启用“访问控制”（`key-access`），在插件设置中维护 Key 与受保护路由。Key 允许路由与路由保护分开，创建或编辑 Key 不改变公开状态，保护集合单独修改。撤销最后一个 Key 不解除保护；公开请求即使携带 Key，也不消耗 Key 限速或预算。Route 和 Service 编辑器不配置认证。

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
├── data/
│   ├── bungee.db
│   └── plugin-state.db
├── logs/access.db
├── bungee.log
├── bungee.error.log
└── bungee.pid
```

配置不再从 JSON、YAML 或 `CONFIG_PATH` 读取。独立存储 Worker 执行配置操作，数据面 worker 只接收经过 hash、catalog 和 revision 校验的不可变快照。

## Docker

先设置稳定、私密的 `BUNGEE_PLUGIN_SECRETS_KEY`，再初始化并启动：

```bash
docker compose run --rm --no-deps bungee bun packages/core/dist/main.js --initialize-config /usr/app/data/bungee.db
docker compose up -d
curl http://127.0.0.1:8089/health/management
```

Compose 持久化 `/usr/app/data` 和 `/usr/app/logs`，不挂载配置文件。

## 配置导入导出

```bash
bungee export --file bungee-snapshot.json
bungee import --file bungee-snapshot.json
```

导入是带双 hash 校验的完整替换。开启管理认证时，为导入／导出命令增加 `--token "$SESSION"`，使用当前管理员的短期 Bearer 会话。导入不替换 Key、管理员、会话或预算账本，依赖和路由保护 guard 同样生效。系统不提供 merge import 或自动 rollback API。

## 开发

```bash
bun install --frozen-lockfile
bun run build
bun test
```

项目固定使用 Bun 1.4.2。

## 文档

- [管理认证与访问控制](./docs/guides/authentication.md)
- [配置与控制 API](./docs/reference/configuration.md)
- [运行时架构](./docs/architecture/runtime.md)
- [部署与备份](./docs/guides/deployment.md)
- [插件系统](./docs/reference/plugin-api.md)
- [插件开发](./docs/guides/plugin-development.md)
- [运维手册](./docs/guides/troubleshooting.md)
- [SQLite 配置存储设计](./docs/architecture/storage.md)

## License

[MIT](LICENSE)

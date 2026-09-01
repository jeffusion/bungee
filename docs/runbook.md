# Bungee 运维 Runbook

本指南提供了 Bungee 插件系统的运维观察点、故障排查步骤和推荐的验证命令。

---

## 1. 核心观察点

### 1.1 Generation (版本管理)

Bungee 使用 `generation` 来跟踪插件配置的应用版本。

- **Target Generation**: Master 进程下发的期望配置版本。
- **Serving Generation**: Worker 进程当前正在提供服务的配置版本。
- **Draining Generations**: 正在优雅退出的旧版本。

**运维含义**:
- 如果 `Serving Generation` 长期落后于 `Target Generation`，说明 Worker 进程可能卡死或 Reconcile 失败。
- `Draining Generations` 列表过长可能意味着有长连接请求未结束，或者插件 `onDestroy` 钩子执行缓慢。

### 1.2 插件生命周期状态

通过管理 API 或 Dashboard 观察插件状态：

- **`quarantined` (隔离)**: 插件存在严重兼容性问题。
  - *排查*: 检查 `engines.bungee` 是否匹配，`manifest.json` 格式是否正确。
- **`degraded` (降级)**: 插件加载或初始化失败。
  - *排查*: 查看日志中的 `runtime-load-failure` 错误，检查插件代码是否有 Bug。
- **`serving` (正常)**: 插件已成功加载并正在处理流量。

---

## 2. 故障排查

### 2.1 插件未生效

1. **检查 activation**: 在 Dashboard Plugins 页确认插件已激活；该状态来自 `bungee.db` 当前 revision 的 `plugin_activations`。
2. **检查 binding**: 确认目标 route/service/upstream binding 自身为 enabled。binding 与全局 activation 独立。
3. **检查状态**: 确认插件是否处于 `quarantined` 或 `degraded` 状态。
4. **检查路径**: 确认 `manifest.json` 中的 `main` 字段指向了正确的编译产物。

### 2.2 多 Worker 不一致 (Convergence Failure)

如果 Master 报告收敛失败：

1. **检查 Worker 日志**: 搜索 `plugin-runtime-reconcile-failed`。
2. **检查 IPC**: 确认 Master 与 Worker 之间的通信正常。
3. **超时设置**: 如果插件初始化非常耗时，可能触发了收敛超时（默认 5s）。

---

## 3. 迁移指南 (Legacy to vNext)

如果你有旧版插件，请按照以下步骤迁移到 `vnext` 契约：

1. **更新 Manifest**:
   - 添加 `"manifestContract": "vnext"`。
   - 添加 `"schemaVersion": 2`。
   - 添加 `"artifactKind": "runtime-plugin"`。
   - 明确 `"main"` 路径（通常是 `dist/index.js`）。
2. **声明能力**:
   - 在 `"capabilities"` 中显式列出插件使用的能力（如 `hooks`, `api`）。
3. **UI 模式**:
   - 设置 `"uiExtensionMode"`。如果是 Native Widget，设为 `"native-static"`；如果是 iframe 扩展，设为 `"sandbox-iframe"`。
4. **引擎限制**:
- 添加 `"engines": { "bungee": "^4.2.0" }`。

---

## 4. 验证命令

在发布或修改插件后，建议运行以下命令进行验证：

### 4.1 全量测试
```bash
# 运行所有包的测试
bun test
```

### 4.2 构建验证
```bash
# 执行全量构建，包含 UI 资源打包和插件编译
bun run build
```

### 4.3 Widget 注册表生成
```bash
# 验证 Native Widget 静态注册表是否正确生成
bun run generate:widgets
```

### 4.4 插件编译
```bash
# 仅编译外部插件
cd packages/core
bun run build:plugins
```

# 离线插件恢复

恢复必须在整个实例停止后执行，并持有同一实例的 master／ingress 锁。配置和插件状态由各自存储 Worker 执行；只有数据库关闭 ACK 齐备后才释放锁并返回结果，初始化码也只在此后显示。关闭超时或结果未知会保留锁并报告故障，不要删除锁文件绕过运行实例。

## 前提与数据位置

停止 master、ingress 和所有 Worker。初始化、启动和恢复使用相同的配置路径、环境变量、插件产物与秘密存储密钥。CLI 默认读取 `~/.bungee/data/bungee.db`，自定义路径用 `BUNGEE_CONFIG_DB_PATH`；插件状态库为配置库同目录的 `plugin-state.db`。`recover` 没有配置路径位置参数或 `--config` 选项。

CLI 从配置数据库旁的 `plugin-secrets.key` 读取初始化时持久化的加密密钥，恢复命令不接受参数或环境变量覆盖。恢复数据库备份时，同时还原配套的密钥文件；CLI 初始化约定见 [CLI 参考](../reference/cli.md#bungee-init)。

Docker 部署先停止原容器，再以同一镜像、原数据卷和环境变量运行临时交互容器。在该容器用原生入口明确指定配置库：

```sh
bun packages/core/dist/main.js --recover /usr/app/data/bungee.db --plugin user-auth --action issue-setup-code
```

保持终端交互，不创建空数据卷；命令结束并删除临时容器后再启动原实例。其他部署可使用下述 CLI 命令。

## 初始化管理认证

```sh
bungee recover --plugin user-auth --action issue-setup-code
```

stdin、stdout 都必须为 TTY，不能从文件或管道签发初始化码。宿主先原子持久化强制认证 guard 和 provider 激活选择，再调用插件准备初始化。中途失败不能让下次启动恢复匿名管理；处理原错误后可重新签发。

一次性码由 32 字节随机数生成，30 分钟有效，只保存摘要。命令确认配置与插件状态库均关闭后才在 TTY 显示码。再次签发撤销原码；账号已 ready 时拒绝签发。启动后访问公开管理地址的 `/#/setup`，输入码、账号和两次 5–32 个 Unicode 字符的密码。成功后回登录页，初始化不建立会话。完整步骤见[认证指南](authentication.md#管理认证)。

## 重置账号密码

```sh
bungee recover --plugin user-auth --action reset
```

命令要求 stdin、stdout 都是本地 TTY，交互输入新账号、两次隐藏密码及恢复原因，不要求或记录旧账号。输入历史关闭，公开提示不能通过方向键回显密码。命令定位初始化时建立的恢复锚点，完整身份保留原 ID；锚点身份缺失或损坏时允许重建，保留其他用户及 OIDC 连接。重置撤销全部旧会话与初始化码，保留不含凭据的恢复摘要，不改变强制认证状态、路由、服务或 API Key。Turnstile 关闭提示默认保留原配置，只有输入 `yes` 才关闭挑战。重置完成后启动实例并正常登录。

## 解除强制认证

```sh
bungee recover --plugin user-auth --action release-auth
```

这是解除强制管理认证的唯一入口，要求整个实例停止并使用本地 TTY。身份数据保留，启动后恢复匿名管理。在线插件停用、配置替换和导入都不能解除保护；provider 故障或目录缺失也不能降级匿名。

## 结构化插件状态恢复

`kind: plugin-state` 恢复使用有界 stdin JSON 或 owner-only `0600` 普通文件。输入最多 8192 字节，凭据不进入 argv、环境或日志。宿主拒绝所有 `kind: identity` 结构化输入；身份恢复必须使用本地 TTY action，即使 JSON 来自终端或 owner-only 文件也不例外。

```sh
bungee recover --file recovery.json
# 或
bungee recover < recovery.json
```

### 恢复预算账务

核验上游证据后，对待恢复 attempt 提交替换总数：

```json
{"kind":"plugin-state","plugin":"token-budget","payload":{"keyId":"KEY_ID","requestId":"REQUEST_ID","attemptId":"ATTEMPT_ID","inputTokens":100,"outputTokens":200,"reason":"已核验上游用量"}}
```

按差额更新原周期，相同补记幂等、内容冲突拒绝；正常已结算记录不能人工改写。金额恢复与独立 unknown 轴见[预算集成契约](../../plugins/token-budget/INTEGRATION.md#离线金额人工补记)。

## 完成判断

命令成功关闭存储并释放锁后，重新启动实例。确认管理健康，并按所选操作完成初始化、登录或匿名访问核验，检查相关插件状态。普通插件状态恢复不自动启用插件；配置导入不能替代业务状态恢复。若关闭或结果未知，保留错误和操作身份，排查后查询状态，不能盲目重执行。

## 准备运行时证明格式升级

没有进程寿命锁证明的运行时描述文件不能被新实例自动接管。升级前停止整个实例，并从 supervisor 确认 master、ingress 和全部 Worker 已退出；实例锁空闲本身不能替代完整退出证明。备份三库、SQLite 侧文件和秘密存储密钥，将不受支持的运行时描述文件归档到备份目录，保留原始证据。

在相同配置路径和密钥环境下，使用候选产物的显式离线入口：

```sh
bun packages/core/dist/main.js --prepare-runtime-upgrade /path/to/data/bungee.db
```

命令持有停止锁，执行配置库连续迁移，并分页规范化已有 executor 证明。缺失的进程寿命证据仍为未知；它不制造退出证明、不执行业务命令、不删除 pending 或 unknown 结果。格式或身份损坏时事务回滚并报错。成功后启动候选实例，确认实际版本、管理与数据健康以及目标 revision 的代理请求。新实例开始业务写入后，不得直接覆盖恢复旧数据库。

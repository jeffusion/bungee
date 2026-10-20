# 离线插件恢复

恢复必须在整个实例停止后执行，并持有同一实例的 master／ingress 锁。配置和插件状态由各自存储 Worker 执行；只有数据库关闭 ACK 齐备后才释放锁并返回结果。关闭超时或结果未知会保留锁并报告故障，不要删除锁文件绕过运行实例。

## 前提与数据位置

停止 master、ingress 和所有 Worker。初始化、启动和恢复使用相同的配置路径、环境变量、插件产物与秘密存储密钥。CLI 默认读取 `~/.bungee/data/bungee.db`，自定义路径用 `BUNGEE_CONFIG_DB_PATH`；插件状态库为配置库同目录的 `plugin-state.db`。`recover` 没有配置路径位置参数或 `--config` 选项。

CLI 从配置数据库旁的 `plugin-secrets.key` 读取初始化时持久化的加密密钥，恢复命令不接受参数或环境变量覆盖。恢复数据库备份时，同时还原配套的密钥文件；CLI 初始化约定见 [CLI 参考](../reference/cli.md#bungee-init)。

Docker 部署先停止原容器，再以同一镜像、原数据卷和环境变量运行临时交互容器。官方镜像工作目录为 `/usr/app`，在原 Compose 项目目录执行：

```sh
docker compose stop bungee
docker compose run --rm -it --no-deps --entrypoint bun bungee packages/core/dist/main.js --recover /usr/app/data/bungee.db --plugin user-auth --action reset-password
docker compose up -d bungee
```

将 `reset-password` 换为所需动作。临时容器退出且恢复成功后再启动原实例；不要创建空数据卷。其他部署可使用下述 CLI 命令。

## 新增用户

```sh
bungee recover --plugin user-auth --action add-user
```

提示 Username、New password、Confirm password，不要求恢复原因。用户名重名时拒绝覆盖；密码为 5–32 个 Unicode 码点，允许空格，不裁剪。空命名空间或合法未初始化状态下，可建立首个 ready 账号及稳定恢复锚点。已有用户和会话保留。

## 按用户名重置密码

```sh
bungee recover --plugin user-auth --action reset-password
```

使用与新增用户相同的三个提示。按用户名定位已有账号，找不到时报错；保留 ID、显示名称、外部绑定和 disabled 状态。推进目标用户 generation，撤销该用户旧会话，其他用户会话保留；推进 failureEpoch，使旧登录限流失效。不要求旧密码或恢复原因，不会重新启用被禁用用户。

## 恢复原管理员

```sh
bungee recover --plugin user-auth --action reset
```

提示 Recovery username、New password、Confirm password、Recovery reason 和 Disable Turnstile?。命令定位初始化时建立的稳定恢复锚点，保留原 ID；即使忘记原用户名，也不按用户名猜测身份。允许修复锚点用户缺失或损坏的身份和本地凭据，其他记录仍严格校验，不自动修复任意损坏数据库。保留其他用户、外部绑定、第三方登录连接及会话策略，撤销全部旧会话与在途认证流程，解除旧限流，并保存不含凭据的恢复摘要。Turnstile 默认保留，只有输入 `yes` 才关闭挑战。

上述动作均要求 stdin、stdout 为本地 TTY。输入历史关闭，密码隐藏输入，不能通过 argv 或环境变量传入。它们不自动启用插件或修改 provider 选择，不改变强制认证状态、路由、服务或 API Key。恢复后按原状态启动；认证尚未启用时，在插件中心使用已有账号验证启用。首次在线创建账号见[认证指南](authentication.md#管理认证)。

## 解除强制认证

```sh
bungee recover --plugin user-auth --action release-auth
```

主动解除强制管理认证使用此入口，要求整个实例停止并使用本地 TTY。身份数据保留，启动后恢复匿名管理。在线插件停用、配置替换和导入都不能解除保护；已安装 provider 故障也不能降级匿名。正常启动和离线恢复会自动清理目录中已不存在插件的启用记录；若清理的是所选管理 provider，也会清除其认证选择，详见[存储与生命周期](../architecture/storage.md#管理能力与健康)。

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

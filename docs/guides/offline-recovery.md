# 离线插件恢复

恢复入口读取有界 stdin JSON 或 0600 文件，持有同样的停止锁，通过已选中管理 provider 的
`offlineRecovery` 能力及异步 `PluginDurableState` 执行；选中别的 provider 时拒绝身份恢复。
没有 provider 启用时，可以先恢复明确指定、支持该能力的插件身份，再按正常流程启用它。
恢复输入不会进入 argv、环境或日志；插件数据库和配置 Worker 独立关闭，只有全部关闭确认后才释放实例锁。
关闭超时或打开结果未知会保留锁并报告资源故障。进程退出后操作系统释放锁；不要在原进程仍运行时绕过锁。

```sh
bungee recover --file recovery.json
```

## 前提与输入

停止 master、ingress 和所有 Worker。初始化、启动和恢复使用相同的配置路径、环境和实例锁路径；不要通过删除锁文件绕过运行实例。输入最多 8192 字节，文件必须为 0600，或从 stdin 输入：

```sh
bungee recover < recovery.json
```

### 恢复管理员身份

```json
{"kind":"identity","plugin":"local-accounts","payload":{"username":"admin","password":"替换为新的6至64字符密码","reason":"恢复管理访问"}}
```

已有管理员时指定原账号；无管理员时可建立一个。插件撤销原会话并保留恢复审计，不自动启用管理认证或改变当前模式。其他 provider 必须声明自己的身份恢复协议。

### 恢复预算账务

核验上游证据后，对待恢复 attempt 提交替换总数：

```json
{"kind":"plugin-state","plugin":"token-budget","payload":{"keyId":"KEY_ID","requestId":"REQUEST_ID","attemptId":"ATTEMPT_ID","inputTokens":100,"outputTokens":200,"reason":"已核验上游用量"}}
```

按差额更新原周期，相同补记幂等、内容冲突拒绝；正常已结算记录不能人工改写。金额恢复与独立 unknown 轴见[预算集成契约](../../plugins/token-budget/INTEGRATION.md#离线金额人工补记)。

## 完成判断

命令成功关闭存储并释放锁后，重新启动实例。确认管理健康、以恢复身份登录，并检查相关插件的恢复状态。恢复停用插件的状态不自动启用它；配置导入不能替代业务状态恢复。若关闭或结果未知，保留错误和操作身份，排查后查询状态，不能盲目重执行。

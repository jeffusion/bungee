# 排查就绪、插件和配置发布

适用于进程已启动，但管理不可用、代理失败或保存配置后未生效的情况。先保留错误时间和日志窗口，再按下列顺序缩小范围。

## 区分健康状态

管理监听默认 `127.0.0.1:8089`。对自定义地址替换下面的 URL：

```bash
curl -i http://127.0.0.1:8089/health
curl -i http://127.0.0.1:8089/health/management
curl -i http://127.0.0.1:8089/health/data
```

`live` 只表示进程存活；`management` 表示管理能力就绪；`data` 需要已确认服务 Worker；`degraded` 标识发布或能力降级。总体 health 的 HTTP 200 不证明数据面可用。管理和数据专项未就绪返回 503。

如果页面提示管理访问未就绪，检查所选 provider 的 control 入口、产物和本地依赖初始化日志。所选插件失败保持认证模式并拒绝访问，不会退回匿名；无关插件失败只影响它的消费者。需要恢复身份时使用[停机离线恢复](offline-recovery.md)，不要清除数据库中的认证选择。

## 保存成功但代理仍使用旧配置

1. 使用 Dashboard 或已授权的 `GET /api/config/runtime` 比较目标 revision 和 serving revision，查看 operation/recovery 状态。
2. 检查新 Worker 的初始化、内容 hash、catalog hash、绑定和 ACK；失败时旧 admission 可以继续服务。
3. 检查 master、ingress 与 Worker 的 loopback 监督链路、实例身份及租约。不要删除锁文件、篡改 epoch 或将未知进程当成已退出。
4. 恢复 stopped 时在管理入口查看原因，满足重试条件后使用正式重试操作。不要连续保存相同配置来制造更多发布操作。

成功判断是目标配置成为实际服务版本并处理受控代理请求；数据库提交或进程存活都不是该判断。

## 插件未执行

1. 插件中心确认全局 activation 已提交并发布。
2. 对 scoped 插件确认目标 Route、Service 或 Upstream binding 启用且作用域正确；global 服务插件不出现在绑定选择器是正常行为。
3. 检查 manifest schema 3、宿主版本、编译入口、bodyRequirements 和依赖版本。缺失、重复 provider 或依赖环不能通过忽略错误解决。
4. 检查服务 readiness 与调用范围。未选中 endpoint 的内容需求不执行；没有计量消费者时计量插件不解析正文。

开发产物检查可使用 `bun run build`、`bun run generate:widgets` 和 `bun run check:architecture`，它们应在开发环境执行。具体接口见[SDK 参考](../reference/plugin-api.md)。

## 数据库或关闭故障

启动拒绝未知版本、缺失迁移记录和结构损坏。先停止整个实例并备份三库及秘密密钥，再核对[存储基线](../architecture/storage.md#数据库基线与升级)；不要修改迁移编号冒充升级成功。

写入失联或超时可能意味着结果未知。保留 operation ID，先查询结果或 reconciliation；不能换 ID 自动重执行。数据库关闭 ACK 未确认时实例锁保留。完整停机需要存储关闭及实际进程退出证据，不能用 terminate 请求代替证明。

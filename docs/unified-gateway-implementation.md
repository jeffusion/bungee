# 统一网关 Hook 与正文服务实施记录

## 结果与边界

HTTP 请求入口、路由、准入、上游选择、重试、请求规则、转发、响应规则、正文服务、日志共十个核心插件，使用项目插件相同的 `Plugin.register()`、`PluginHooks` 和 Hook executor。每个必需阶段在初始化时校验恰好一个提供者；请求捕获自身代际的装配，在途重试与后台工作不会切换到新配置的提供者。

正文服务通过 `onGatewayBody` 创建唯一所有者，按实际需求共享 wire、解码、JSON 和 SSE 表示。透明转发不解析正文，日志和 Token 观察独立消费；规则与插件改写正文时更新版本，后续 Hook 的句柄同步绑定新正文。全部随仓库发行的插件和 LLMS 转换器已适配公共 SDK，没有旧 SDK 双执行路径。

本轮未增加数据库迁移。沿用自动 v15 整理与局部忽略不可用旧规则；运行时仅执行方向明确的 request/response 配置，不要求用户手动搬迁。没有实现 WebSocket。

**本轮不部署。** 用户明确要求等待后续更新指令，当前环境容器和配置保持本轮未修改状态。

## 按步骤完成的工作

1. 将 HTTP 执行链搬到核心插件，原 handler/proxy/processor/modifier 仅保留类型化 Hook 分发或通用 helper；删除直接业务执行重导出。
2. 注册正文服务提供者，统一生产正文构造入口；共享解码与冻结 JSON/SSE 计算，区分请求、attempt、方向、阶段和版本。
3. 将日志、Token 计量、协议转换、OAuth 与 JSON 修改插件接到共享视图。辅助 OAuth 交换、账号 usage、目录下载仍在明确的独立网络边界内。
4. 使正文旁路跟随实际下游 pull，隔离可选消费者的积压、失败和取消。最后一个必要消费者结束时取消实际 reader；其他活跃消费者继续使用自身视图。
5. 在每个响应 tap 后刷新正文句柄及元数据，支持同作用域和跨作用域的普通/raw 响应替换。SSE 日志保持 event/data 数组展示。
6. 将 SignatureRepair 的补偿请求改为网关管理的独立 attempt，统一准入、凭据、超时、日志与统计；宿主与独立插件 bundle 用公共 Action 品牌识别同一动作契约。
7. 区分 HTTP 正文限制、worker 资源预算与日志保存配额。补充可重复测量，解码槽位以八并发样本为运行基线，可通过环境变量调整；不宣称任意大小或并发均可完成。
8. 公共 SDK 仅发布 dist 入口，不在导入时初始化默认日志文件/数据库或定时器；通过 dist-only 包名导入检查部署布局。
9. 增加 AST 架构门禁与负例：私有核心导入、独立正文构造/解码/分帧、原生读体/异步迭代/pipe、业务执行 import/namespace/re-export 旁路。CI、根构建和 Docker 构建均执行门禁。
10. 完成源码、发布产物、真实 HTTP/主进程与双 worker 回归，以及两个互不重叠的独立审查轴。提交 PR；不更新当前服务。

## 审查 finding 逐项处理

| Finding | 处理 | 验证证据 |
| --- | --- | --- |
| P1：旁路提前消费 SSE 导致迟订阅丢失首段 | 用惰性观察流替换提前 pump，安装只预留 reader，实际 pull 才读取 | 安装后 30 个微任务仍零读取；首帧、DONE、计量完整 |
| P1：响应 tap 更新后 BodyHandle 仍读旧正文 | 每个 waterfall tap 后更新 owner、metadata、句柄和版本 | 普通/raw × 同/跨作用域四组真实 pipeline：内容 1→2→3，版本 0→1→2 |
| P1：取消未到达原始 reader | 记录并共享实际 cancel Promise，最后必要消费者释放时取消一次 | JSON/SSE 延迟 gate、锁释放、多消费者隔离及解码器释放 |
| P1：SSE 规则错误被清理拖住或覆盖 | 确定解析错误先传播，后台保存清理；普通 cancel 仍等待实际取消 | 非法封套不等 gate；帧超限不被拒绝取消覆盖；identity/gzip/zstd × 有/无观察器六组独立核验 |
| P2：SSE signal 取消过早结束 | 区分消费者取消与已知解析失败，前者等待物理取消 | 裸/受控句柄 signal gate，以及显式正常 cancel 独立核验 |
| P2：Docker 公共 SDK bun 导出指向缺失 src | 删除源码条件，公共包名统一导向 dist | 只有 package.json+dist 的隔离 node_modules 目录通过包名导入，子进程正常退出 |
| P2：namespace 导入可直接执行网关实现 | 守卫覆盖属性和字面量索引引用 | namespace 正常写法两组负例 |
| P2：for-await/pipe 可直接消费正文 | 守卫覆盖 body 异步迭代、pipeTo/pipeThrough/values、简单别名与字面量索引 | 五组负例；共享事件迭代仍允许 |
| P2：值重导出仍可绕过执行 Hook | 守卫覆盖 named/star/namespace 值导出；删除旧 query/header 值入口 | 五个值/类型导出断言；生产源码 finding 为空 |

流生命周期独立复审：45 pass / 0 fail，5240 assertions，所有原 finding 关闭。架构轴最终限定复审：31 pass / 0 fail，47 assertions，生产源码 finding 为空。

## 验收命令

```sh
bun run check:architecture
bun run build
bun test
```

最终全量验收：4202 项测试，4199 pass、3 skip、0 fail，33318 assertions；跳过项为当前 Linux 环境不适用的 Windows 分支。根完整构建通过，删除旧入口后的 core 重建及产物契约测试再次通过。架构专项最终 31 pass、0 fail。

发布产物测试实际重建 core，验证 SDK 包名导入、独立 SignatureRepair bundle 动作识别及陈旧产物清理。真实进程测试覆盖空配置、配置发布、gzip/zstd/二进制透明 wire、流式首段、独立日志、双 worker Token 统计、重试与重启持久化。资源测量方法及样本在 [body-resource-measurements.md](./body-resource-measurements.md)。详细运行契约见 [http-body-architecture.md](./http-body-architecture.md)。

架构门禁是对受信项目源码的可执行约束，覆盖明确禁止的常见旁路；不是恶意插件 JavaScript 安全沙箱。尚未实测的任意高并发、大正文、长连接组合，不以本轮样本通过替代容量验证。

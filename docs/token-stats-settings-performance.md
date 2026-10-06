# Token 统计设置页性能修复

原页面进入时串行请求全部价格模型：8394 个模型、84 页、约 917 KiB；目录全部加载后才结束首屏 loading。每个目录分页还会构建全部匹配对象，再截取当前页。

现在首屏只读取目录状态、映射和 provider 摘要。模型选择器打开后才按 provider、关键词请求一页，每页 50 个模型；关键词输入有 250 ms 防抖。关闭、切换 provider 或销毁组件会取消请求，迟到响应不能覆盖新结果。目录版本改变时重新查询打开的选择器。后端保留搜索、排序、大小写、末页钳制与扫描预算，只构建返回页的模型对象，不新增缓存或通信框架。

现有映射原值保持显示。部分分页结果不能证明某个旧映射不存在，因此移除依赖全目录的前端缺失提示；服务端保存校验与计价规则保持原实现。客户端模型仍来自保留期内真实统计记录，支持原大小写与自由输入，不生成统计记录。

## 验证证据

本轮证据目录为 `/tmp/brave-egret-token-settings-performance/`，完成本地更新时另复制至该次数据库备份目录。

| 检查 | 结果与证据 |
| --- | --- |
| 针对性源码测试 | `targeted-tests-final.log`：16 pass、0 fail、81 assertions；覆盖分页、取消、防抖、迟到响应和 provider 版本竞态 |
| 真实隔离浏览器 | `browser-final/report.json`：13 项通过，页面/控制台错误为空，进程及端口清理已确认 |
| 浏览器性能与行为 | `browser-final/settings-performance.json`：进入设置页模型请求为 0，首屏单次约 115 ms；真实目录 8396 模型/226 providers；第二页选择、刷新后打开的选择器重新查询均通过 |
| 目录算法比较 | `catalog-comparison.json`：同一份 8394 模型目录、84 页，交替运行的中位数由 63.18 ms 降至 14.55 ms；仅包含本地服务调用、目录计算和 JSON 序列化，不包含认证、网络及浏览器 |
| 完整构建 | `build-final.log`、`build-binaries-final.log`：应用、插件、UI 及五平台二进制/archives 完成 |
| 根全量测试 | `full-tests-retry.log`：3964 pass、3 skip、0 fail，26533 assertions，3967 tests / 387 files，exit 0；三个 Windows 专属测试在 Linux 跳过 |
| 类型诊断比较 | `type-comparison.json`：相对本轮 HEAD `990a4b7`，core 9→9、UI 27→27，无新增诊断；三个搜索 helper 的独立严格检查为零诊断。UI TypeScript 检查不等同于完整 Svelte 类型检查，Svelte 编译与交互另由构建和浏览器验收覆盖 |

浏览器耗时为一次本地隔离测量，不能据此承诺不同机器及数据规模下的延迟。此次没有改变请求热路径、计量结算、数据库 schema 或历史费用。

## 独立审查与失败证据

独立性能审查发现一项 P2：首次 provider 查询可能早于目录状态，返回空列表后不再重新加载。已改为目录状态确认版本后后台加载 provider，使用版本与 generation 防止旧响应覆盖新列表，同版本在途请求去重，首屏不等待 provider。新增两项回归覆盖逆序响应、同版本轮询及空目录变为首个版本；原审查轴复审已关闭该问题，无新增 P1/P2。

复审指出打开的选择器刷新目录时还缺少明确请求断言。浏览器脚本现等待并检查刷新后同 provider 的第一页响应，最终 13 项验收通过。该项为测试断言补齐，已自行验证，无需复审。

首次全量测试 `full-tests.log` 出现一次核心启动失败及两项级联失败（3959 pass、3 skip、3 fail）。失败日志保留；未确认根因，也未把并行二进制构建推测为已证明原因。对应 suite 单独重跑 `canonical-reproduction.log` 为 4 pass、0 fail。

所有构建结束后的串行运行 `full-tests-final.log` 中，核心启动 suite 已通过；但整个运行在 3272 项通过、尚无断言失败时收到 SIGTERM，exit 143，没有最终汇总。该次不计为全量通过，中断原因未确认。再次通过终端会话运行并显式记录退出码，`full-tests-retry.log` 为 3964 pass、3 skip、0 fail，exit 0。

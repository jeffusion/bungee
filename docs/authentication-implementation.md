# 个人反代认证与插件实施核验

本轮文档以 [功能设计](./authentication-authorization-design.md) 和 [插件架构](./plugin-extension-architecture.md) 为准，使用步骤见 [认证指南](./authentication.md)。本记录只列本轮已读取的测试日志和代码定位，不把旧产品方案的回归、浏览器或部署记录当作当前方案验收。

## 当前实现定位

| 能力 | 代码定位 |
| --- | --- |
| 默认匿名管理、provider 选择与切换校验 | `packages/core/src/master-runtime/management-auth.ts` |
| 单管理员、Cookie／Bearer 会话、改密和恢复 | `plugins/local-accounts/server/control.ts` |
| 插件内 Key 生命周期与保护路由集合 | `plugins/key-access/server/control.ts` |
| 公开匿名、受保护 Key 验证、路由／最终模型范围 | `plugins/key-access/server/policy.ts` |
| 持久保护 guard 与通用只读资源组装 | `packages/core/src/master-runtime/composition.ts` |
| 只读 collection／extension 协议 | `packages/core/src/plugin-control/contracts.ts`、`host.ts` |
| 限速依赖 access，预算依赖 access + metering，统计仅依赖 metering | 各插件 `manifest.json` |
| 只建库初始化、持锁离线恢复 | `packages/core/src/master-runtime/initialize-configuration.ts`、`offline-recovery.ts` |
| CLI 实际参数 | `packages/cli/src/index.ts`、`commands/init.ts`、`commands/recover.ts` |

## 已读取的本轮测试证据

| 日志 | 结果 | 已覆盖范围 |
| --- | --- | --- |
| `/tmp/personal-final-tests.log` | 12 文件，90 通过，0 失败，720 次断言 | master 组装与关闭、通用资源读取、持久路由保护、真实请求、初始化、真实管理进程、管理 Origin、管理认证、离线恢复 |
| `/tmp/personal-config-api-final.log` | 4 文件，61 通过，0 失败，456 次断言 | 配置恢复 API、同步／异步配置操作、默认匿名写入、管理员会话复核、provider 故障拒绝、Cookie／CSRF、停用回匿名及重启用原身份 |

两组测试有文件与用例重叠，不能相加作为独立覆盖总数。日志包含故障注入场景的预期错误输出；测试末尾为 0 fail。本轮文档核验未重跑这些测试，也未据此宣称整仓回归完成。

## 最终构建与回归记录（2026-10-03）

- 工作树误删后，通过源码快照与会话中的修改记录恢复；恢复后完整构建、core 类型检查及 `git diff --check` 均通过，详见 `/tmp/bungee-recovery-replay/verification-results.json`。
- 全仓测试采用逐文件独立进程运行，首次 326 个文件中 322 个通过；其余 4 个文件修正旧认证预期与真实入站身份初始化后全部通过（7 个用例）。后续旧核心认证测试随旧接口删除。单进程整仓运行曾受到模块 mock 污染等影响，不能表述为单进程全绿。
- 恢复后再次执行真实 admission 回归（14 个用例）、上述 4 文件（7 个用例）和管理认证／访问控制回归（12 个用例），全部通过。
- 新 Key 默认拒绝所有受保护路由，避免后续策略保存失败时产生无限制 Key。独立审查发现的问题已修复并复审关闭。
- 独立打包插件抛出的认证错误经过严格规范化，真实构建请求缺少 Key 返回 401；未知错误仍拒绝请求。

## 浏览器验收

使用真实构建产物启动独立临时实例并通过 Playwright 操作，10 项检查通过、页面脚本错误为 0：匿名进入、启用访问控制保持公开、创建 Key 并明确保护 Route、撤销最后 Key 仍保护、单管理员启用与刷新、退出重登、改密后重登、停用恢复匿名、解除保护后停用与只读、依赖自动启用及 Switch 禁用。报告 `/tmp/bungee-personal-browser-report.json`，截图 `/tmp/bungee-personal-shots/`。

配置发布尚未就绪时，页面明确报告本次未提交；测试仅在该前置拒绝情况下重试，没有重放已提交操作。

## 独立验收部署（2026-10-03）

验收容器 `bungee-auth-acceptance-20261003` 已用新构建重建，数据面监听 `0.0.0.0:28088`、管理面监听 `0.0.0.0:28089`。管理入口为 `http://192.168.100.120:28089`，保留原管理员 jeffusion 的密码，旧会话在单管理员迁移时撤销。

误删目录的数据库从原验收进程持有的文件描述符救回，配置库与日志库的 SQLite 完整性检查均为 `ok`。恢复后保留 6 个数据 Key，将旧 Service 范围约束换算为对应 Route 范围，并保留 1 条现有路由保护。该在线文件救援不是事务一致的备份承诺；原始副本位于 `/tmp/bungee-recovery-acceptance`，留存用于追溯。

部署验证：健康检查通过，网络地址可读取认证模式；管理 API 未登录返回 401，受保护代理路由缺少 Key 返回 401。部署前后其他容器的 ID、镜像、PID、启动时间和运行状态均相同。详细制品摘要与报告位于忽略目录 `data/bungee-acceptance-auth-20261003/personal-upgrade-report.json`。

功能测试不替代生产负载测量；已接纳请求可能导致预算超额，进程崩溃不保证流连接存活。普通配置导入不替换 Key、管理员会话或预算运行账本，物理备份恢复须核验备份时点。

## 密码与模型匹配验收补充（2026-10-03）

密码规则调整为至少 6 个 Unicode 字符，移除创建、登录、改密和恢复路径的密码字段上限，保留通用请求体限制。模型允许列表支持 `*` 匹配任意数量字符，其他字符按字面处理，仍校验最终上游模型。访问控制中的路由直接来源于平台 Route 列表并使用稳定 ID，界面补充了这一说明。

针对性回归 34 个用例通过；补充长密码尾部差异拒绝测试后，账号测试再次通过。完整构建通过。真实浏览器使用 6 字符密码启用，再改为超过 1000 字符密码并登录成功；页面设置 `gpt-*` 后 `gpt-4.1-mini` 返回 200，未授权模型返回 403。10 项浏览器流程通过且页面脚本错误为 0。证据位于 `/tmp/bungee-password-model-tests.log`、`/tmp/bungee-password-boundary-final.log`、`/tmp/bungee-password-model-build.log`、`/tmp/bungee-password-model-browser.log`。

## 创建 Key 交互与密码上限调整（2026-10-03）

密码新建、修改及离线恢复统一为 6–64 个 Unicode 字符。登录保留验证既有密码的能力，避免上一版本已设置的长密码无法登录改密。

创建和编辑 Key 以基本信息、可访问路由、模型范围组织表单。创建默认指定路由；选中的公开路由显示“公开 → 需要 Key”，只有确认步骤提交后才保存 Key 与保护，移除原“同时保护”附加复选框。路由公开状态仍可在插件内“路由访问”页调整，取消 Key 的路由授权不会使路由公开。

账号边界测试 8 项通过，包含 5／6／64／65 字符及 Unicode；UI 规范检查 42 项通过。完整构建通过，浏览器检查确认前 Key 数量为零且路由仍公开，返回修改保留输入；确认后正确限制代理请求。桌面与 390px 移动布局截图已检查，页面脚本错误为零。证据：`/tmp/bungee-password64-tests.log`、`/tmp/bungee-redesign-ui-guards.log`、`/tmp/bungee-access-redesign-build.log`、`/tmp/bungee-access-redesign-browser.log`。

## Key 编辑、删除及再次查看（2026-10-03）

Key 操作调整为编辑／删除。编辑元数据和访问范围通过单次耐久写入保存；新 Key 明文使用现有 AES-256-GCM SecretStore 加密保存，列表与准入策略不包含明文。查看接口使用管理面权限并返回 no-store；旧摘要 Key 明确返回 409，不自动换 Key。删除凭证与授权后清理加密记录，路由保护保持，清理失败可重试且已删除 Key 不可认证或查看。其他插件历史额度账本保留，不恢复已删除凭证。

路由列表只显示“是否公开”的 Switch，开启为公开、关闭为需要 Key，不显示单元格文案。“允许所有路由（含新增）”明确授权包含未来路由。

完整构建及最终 core 重建通过；针对性测试 5 用例、94 断言通过，真实请求测试 1 用例、24 断言通过，浏览器 11 流程通过且页面脚本错误为零。浏览器覆盖修改后刷新持久化、再次查看保持原 Key、隐藏明文、删除后401，以及公开开关方向与无文案状态。独立复核无阻塞 finding，额外补充密文清理失败及重试测试并自行验证。日志：`/tmp/bungee-key-crud-tests.log`、`/tmp/bungee-key-crud-real.log`、`/tmp/bungee-key-crud-browser.log`、`/tmp/bungee-key-crud-final-build.log`。

## Key 操作入口及表单精简（2026-10-03）

“查看”移到列表操作列，编辑表单不再承载明文展示；查看对话框关闭时清除页面中的明文。“任意路由”开启时隐藏路由选择，关闭后恢复原选择。创建与编辑的按钮简化为下一步／上一步／取消／保存，取消不提交数据。沿用原组件样式。

完整构建通过；浏览器 11 项流程通过、pageerror 为零，覆盖创建和编辑中任意路由切换、列表重复查看、关闭清除明文、取消不写入、确认返回与保存。证据：`/tmp/bungee-key-ui-polish-build.log`、`/tmp/bungee-key-ui-polish-browser.log`。独立验收升级报告位于 `data/bungee-acceptance-auth-20261003/key-ui-polish-upgrade.json`。

## 关联 Key 的路由禁止公开（2026-10-03）

路由仍关联已保存 Key 时，禁止从受保护切换为公开，覆盖指定路由与任意路由授权，过期不自动解除关联。服务端在串行写入链中核验，拒绝返回 409 且不写入、不发布；前端使用服务端返回的关联信息禁用开关，悬停说明关联 Key。解除授权或删除 Key 后可公开。公开开关恢复 BSwitch 默认内置图标，不增加单元格文案；切换结果立即同步关联锁定状态。

测试：control 2 用例、61 断言通过；覆盖过期 Key、任意路由、解除授权、并发操作及拒绝不落库。完整构建和最后 UI/core 重建通过。最终浏览器 13 流程通过、pageerror 为零，验证 UI 禁用、直接接口409、取消授权后开放以及即时状态同步。证据：`/tmp/bungee-route-lock-tests.log`、`/tmp/bungee-route-lock-build.log`、`/tmp/bungee-route-lock-final-build.log`、`/tmp/bungee-route-lock-browser.log`。

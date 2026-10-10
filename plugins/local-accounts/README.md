# 管理认证

可选的单管理员认证插件，仅保护管理面，不参与代理请求的 Bearer Token 认证。未启用时管理面允许匿名访问。

在插件中心启用时设置管理员账号和密码；已有管理员时须验证原密码。插件设置页提供查看当前账号、设置登录会话有效期、修改密码和退出会话，不提供成员、角色或租户管理。停用后恢复匿名管理，保留管理员记录供再次启用时验证。

## 登录会话有效期

- 空闲超时默认 30 分钟，登录最长有效期默认 8 小时。可分别设置为非负整数时长（分钟、小时或天）；0 表示关闭对应的服务端超时。
- 设置通过 `/session-policy`（GET / PUT）持久化到plugin-state.db 的插件命名空间。PUT 提交 `{version, policy: {idleTimeoutMinutes, absoluteTimeoutMinutes}}`，使用读取到的版本，防止覆盖其他页面的新设置。
- 设置仅影响新登录会话。每个新会话保存当时的策略，已有会话未记录策略时继续使用默认会话策略；重启不会改变会话策略。
- Cookie 保留时间不超过剩余登录最长有效期；关闭最长有效期时使用 400 天的浏览器 Cookie 租约。成功调用 `/api/auth/verify` 时续期租约，但不改变服务端登录创建时间或延长绝对期限。浏览器可能自行缩短保留时间、清理 Cookie，或由用户删除；关闭服务端超时不意味着浏览器能永久保存凭据。
- 退出登录、改密、停用插件和离线恢复身份仍撤销相应会话。Origin、CSRF、登录限流及会话数量上限保持不变。

## Host 接入契约

- master 通过 `createControl(host).management` 接入；状态使用插件独占的 `durableState` 命名空间。
- 初始化或读取失败保持受保护状态，不回退匿名。启用、停用由管理认证切换协调器执行。
- Cookie 登录要求同源 Origin；Cookie 使用 HttpOnly、SameSite=Strict，HTTPS 时使用 Secure。写请求同时校验 Origin 和 CSRF token。
- 会话摘要持久化，密码使用 Argon2id；修改密码撤销旧会话。登录失败受到限流保护。
- 管理员拥有平台全部管理能力。平台通过通用身份与能力接口调用 provider，不反向依赖账号插件实现。
- `/self`、`/session-policy`、`/password`、`/logout` 支持内置设置页，没有成员管理接口。

管理员、会话和限流分别存储，认证只触碰当前会话。管理员 generation 撤销旧会话；failureEpoch 使旧限流状态失效。普通验证使用 CAS，不记录完整账户历史。状态不符合当前记录 schema 时拒绝初始化，不在运行中自动选择身份或转换账户。

验证：`bun test plugins/local-accounts/tests/control.test.ts`。

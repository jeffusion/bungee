# 管理认证

可选的单管理员认证插件，仅保护管理面，不参与代理请求的 Bearer Token 认证。未启用时管理面允许匿名访问。

在插件中心启用时设置管理员账号和密码；已有管理员时须验证原密码。插件设置页提供查看当前账号、修改密码和退出会话，不提供成员、角色或租户管理。停用后恢复匿名管理，保留管理员记录供再次启用时验证。

## Host 接入契约

- master 通过 `createControl(host).management` 接入；状态使用插件独占的 `durableState` 命名空间。
- 初始化或读取失败保持受保护状态，不回退匿名。启用、停用由管理认证切换协调器执行。
- Cookie 登录要求同源 Origin；Cookie 使用 HttpOnly、SameSite=Strict，HTTPS 时使用 Secure。写请求同时校验 Origin 和 CSRF token。
- 会话摘要持久化，密码使用 Argon2id；修改密码撤销旧会话。登录失败受到限流保护。
- 管理员拥有平台全部管理能力。平台通过通用身份与能力接口调用 provider，不反向依赖账号插件实现。
- `/self`、`/password`、`/logout` 支持内置设置页；旧成员管理接口已移除。

旧账号数据仅在存在唯一有效 owner 时迁移为单管理员，删除其他成员和旧会话。存在多个 owner 时拒绝自动选择，须通过离线恢复明确管理员身份。

验证：`bun test plugins/local-accounts/tests/control.test.ts`。

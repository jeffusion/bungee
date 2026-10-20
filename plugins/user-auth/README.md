# 用户认证

可选的管理身份插件，支持多个用户、本地密码、Google、Microsoft、GitHub 及自定义 OIDC 连接及 Cloudflare Turnstile。所有有效用户拥有平台全部管理能力，不提供角色、自助注册、MFA 或邮件服务，也不参与代理请求的 Bearer Token 认证。本地密码登录始终保留；第三方登录不替代本地恢复途径。

## 初始化与离线恢复

启用弹窗通过 `GET /api/plugins/user-auth/management-setup` 读取本插件的初始化状态。尚无记录时显示首次设置步骤；已初始化时才显示已有账号验证表单。查询不启动插件或写入数据，读取失败时显示错误并允许重新检查，不推断为已有账号。已有记录损坏仍明确报错。

首次使用时，在插件中心打开“用户认证”开关，填写账号、密码和确认密码。启用请求通过 `managementSetup: {operation: "initialize", username, password, passwordConfirmation}` 原子建立首个用户、本地密码和稳定恢复锚点，再提交 provider 激活和强制认证选择；弹窗随后建立 Cookie 会话并经宿主核验。已有账号时改用 `{operation: "verify", username, password}`，只验证身份，不创建用户。若账号已创建而配置提交失败，账号保留；重新读取状态后使用已有账号验证继续启用。

用户名为 1–64 个 ASCII 字符，只允许字母、数字及 `_ . @ -`，首字符必须为字母或数字，保存为小写。显示名称最多 128 个 Unicode 字符。密码为 5–32 个 Unicode 码点，允许空格，不裁剪。

已选中 provider 但尚未初始化时，也可在公开管理地址的 `/#/setup` 填写账号、密码和确认密码。此独立页面成功后返回登录页，不创建会话。它与首次启用弹窗使用相同的首个账号创建规则。

离线管理账号时，先停止整个实例并备份完整数据，在原部署目录使用原数据位置和环境执行：

```sh
bungee recover --plugin user-auth --action add-user
bungee recover --plugin user-auth --action reset-password
bungee recover --plugin user-auth --action reset
```

每次只执行所需动作。`add-user` 提示 Username、New password、Confirm password，拒绝重名；空命名空间可建立首个 ready 账号。`reset-password` 使用相同提示，按用户名精确定位，缺失时报错；保留用户 ID、绑定及禁用状态，推进目标用户 generation 和登录失败代际，使目标旧会话及旧限流失效，其他用户会话保留。这两个动作不要求恢复原因。

`reset` 用于忘记账号或恢复原管理员，提示 Recovery username、New password、Confirm password、Recovery reason 和是否关闭 Turnstile。它定位初始化时建立的稳定恢复锚点，保留原 ID，并允许修复该用户缺失或损坏的身份与本地凭据，不按用户名猜测锚点，也不自动修复任意损坏状态。保留其他用户、外部绑定、第三方登录连接和会话策略，撤销全部会话与在途认证流程，重置有效登录限流。Turnstile 默认保留；只有显式输入 `yes` 才关闭挑战。

离线动作不自动启用插件或改变 provider 选择，不解除宿主强制认证，不修改路由、服务或 API Key。stdin、stdout 都必须为 TTY，密码隐藏输入，不通过参数或环境变量传入。Docker 使用同一镜像、原数据卷和环境，具体命令见[离线恢复](../../docs/guides/offline-recovery.md)。

## 用户与外部身份

独立的「用户管理」菜单页面支持创建用户、修改用户名或显示名称、禁用或重新启用用户、设置本地密码。用户的创建、编辑和密码重设通过弹窗完成，管理页不读取或修改外部身份绑定。用户不支持硬删除。不能禁用最后一个已启用且有本地密码的用户。创建用户时密码可留空，管理员也可以稍后给只使用 SSO 的用户设置密码。

「用户信息」菜单页面展示当前账号资料、本地密码状态和第三方登录绑定。绑定列表按连接展示提供商、连接名称和身份 ID，只提供插件登录管理中已配置并启用的登录连接的绑定入口，包括预设提供商和自定义 OIDC。连接配置统一在插件登录管理中维护，用户信息页不提供配置入口。未绑定连接点击「绑定」直接前往提供商验证，不弹出二次确认；已有绑定的连接只显示解绑操作，更换账号先解绑。解绑需确认身份及退出全部会话的影响。自行改密通过弹窗完成，必须提交当前密码。改密、管理员重设密码、禁用状态变化和外部身份绑定变化都会推进该用户身份代际，撤销其全部会话。其他用户的有效会话保持可用。

外部身份以精确的 `issuer + subject` 唯一识别，不按邮箱合并。账号绑定及解绑集中在用户信息页，绑定必须完成对应提供商认证。自行绑定必须从已认证的用户信息页启动；回调仅验证外部身份并返回用户信息页，之后由发起绑定的同一会话提交受保护的完成请求。回调不会登录或切换成其他用户。

## 第三方登录与 Turnstile

「登录管理」位于用户认证插件的内置设置页，集中维护第三方登录连接、统一自动开户开关、Turnstile 和会话策略，不加入业务页面菜单。用户管理和用户信息通过插件声明提供独立菜单及页面；用户操作及第三方登录连接的创建和编辑通过弹窗完成。第三方登录连接以表格展示，支持搜索、状态筛选、启用、停用和删除。

连接默认停用。添加时先选择提供商，已配置公开管理 Origin 时，创建弹窗显示固定回调地址 `<managementOrigin>/api/auth/login/callback/<connectionId>`，并提供官方应用创建入口。未配置时明确提示，不从请求地址推导回调。新建表单不显示启用开关；将回调地址登记到提供商后，填写 Client ID 和 Client Secret 并保存，再从列表启用。保存执行配置及元数据检查，不代表凭据已通过真实认证；完整流程通过正式登录入口验收，不提供独立测试登录入口。编辑留空 Secret 保留原值，连接的提供商类型不能修改，需要删除重建。

| 提供商 | 配置 | 协议与默认范围 |
| --- | --- | --- |
| Google | 名称、Client ID、Client Secret | Google 官方 Discovery；OIDC，`openid profile email` |
| Microsoft | 名称、账号范围、Client ID、Client Secret；指定组织需 GUID Tenant ID | 公共云 Entra OIDC；`openid profile email`；账号范围为指定组织、任意组织、个人、组织及个人，默认指定组织 |
| GitHub | 名称、Client ID、Client Secret | GitHub.com OAuth App；`read:user`；使用 `/user` 返回的稳定数字 ID，不以用户名或邮箱识别 |
| 自定义 OIDC | 名称、Client ID、Client Secret、配置来源 | Issuer、Discovery URL 或手动元数据三选一；Scopes 默认 `openid profile email`，必须包含 `openid` |

预设提供商不接受协议端点或 Scopes 覆盖。自定义地址失焦后自动读取 Discovery 并展示 Issuer 和端点。Discovery URL 可以为非标准路径；保存时固定已展示的 Issuer，运行时返回不同 Issuer 时拒绝登录。手动模式填写 Issuer、授权端点、Token 端点、JWKS URI、客户端认证方式（默认 Basic，可选 Post）及签名算法（默认 RS256，可选 PS256／ES256）。

第三方登录和身份绑定要求明确配置公开 `managementOrigin`（`BUNGEE_PUBLIC_ORIGIN`），支持 HTTP 或 HTTPS，生产环境建议使用 HTTPS。身份提供商的配置和发现端点要求 HTTPS，仅 loopback 可使用 HTTP；允许 HTTPS 内网身份提供商。外部请求禁止重定向、超时 5 秒，发现、Token、JWKS 和用户信息响应均最多 1 MiB。Discovery 和 JWKS 请求不携带 Client Secret。

协议处理使用 `openid-client` 的授权码流程，使用 S256 PKCE 和一次性 state；OIDC 额外校验 nonce、ID Token 签名、Issuer、Audience 和期限。Microsoft 按实际 `iss/tid`、账号范围及签名密钥 Issuer 核验，跨租户身份独立。GitHub 授权服务器的 Issuer 为 `https://github.com/login/oauth`，回调按其[官方元数据](https://docs.github.com/en/apps/github-authentication-discovery-endpoints)校验 `iss`。通过访问令牌请求固定用户 API 获取身份，不要求 OIDC ID Token；平台的 GitHub 身份命名空间仍为 `https://github.com`，与授权服务器 Issuer 分开。提供商令牌不持久化。流程 Cookie 为 HttpOnly、SameSite=Lax，HTTPS 下使用 Secure，与管理会话 Cookie 分离；返回位置仅允许本站路径。

`autoCreateUsers` 是插件全局开关，默认为 `false`；连接不接受同名字段。未知身份在关闭时拒绝登录，开启时原子创建用户、绑定身份、创建会话并消费流程。回调最终提交会重查开关、连接代际和用户状态，禁用身份不会重新创建用户。停用或修改连接会立即使该连接的已有会话和在途流程失效，重新启用不会恢复它们。删除连接需要确认并校验版本。连接进入删除状态与受影响用户的会话代际更新在同一事务提交，立即拒绝该连接的新登录、绑定及旧会话；随后分批清理该连接的全部外部身份绑定、在途流程和未再使用的秘密，完成后才返回成功。每次事务不超过 256 条变更，删除状态保留待回收的秘密引用，确认回收后才清除；中断、确认丢失或重启后继续清理，清理期间连接不能重新启用。平台用户、本地密码及其他连接的身份绑定保留；绑定被清理的用户退出全部会话，其他用户不受影响。删除影响当前用户时返回登录页。重新添加连接使用新 ID；外部身份需重新绑定，或按当前统一自动开户设置创建平台用户，不能恢复旧会话。

Turnstile 默认关闭。只有 site key、secret 和允许的 hostname 均完整时才能开启。开启后所有本地密码登录，包括 Cookie 和 Bearer，均需 `turnstileToken`。服务端调用 Siteverify，要求 `success=true`、hostname 在列表中且 action 精确为 `local-login`；超时和网络故障拒绝登录。限流在网络验证和密码哈希之前预留；挑战令牌不能重复使用。Site key 可公开，secret 只写入 SecretStore，新引用确认保存后才通过 CAS 发布；读取接口只返回 `hasSecret`。

## 会话与持久化

空闲超时默认 30 分钟，设为 0 可关闭；最长有效期默认 480 分钟，范围 1–43200 分钟，空闲超时上限同为 43200 分钟。策略只影响新会话，既有会话保留创建时的策略。Cookie `bungee_user_session` 使用 HttpOnly、SameSite=Strict，HTTPS 下使用 Secure。Cookie 写请求同时校验公开 Origin 和 CSRF；Bearer 与 Cookie 会话不能互换。退出撤销当前会话，全局撤销及离线 `reset` 撤销全部会话；离线 `reset-password` 只撤销目标用户会话，`add-user` 保留既有会话。

插件仅使用宿主注入的 `user-auth` 命名空间，通过异步 durableState 和 CAS 保存 schema 3 记录，分别保存用户、本地密码、绑定、连接、设置和恢复锚点，不添加数据库表或 SQL 迁移。空命名空间在插件启动时通过 CAS 创建最小 `uninitialized` 元数据；状态查询只读，不启动插件。ready 状态下用户丢失或记录损坏时明确报错，不重新开放初始化。其他 schema 明确拒绝，不转换，也不读取 `local-accounts`。历史 schema 3 待初始化记录中的 `setup.code` 仅由插件集中读取投影及启动／离线维护 CAS 清理；核心不添加迁移，已有 ready 用户格式和 ID 保持不变。

密码使用 Argon2id（64 MiB、3 次迭代），会话仅保存令牌摘要。用户最多 128 个、第三方登录连接最多 32 个、有效绑定最多 512 个；会话最多 512 个固定槽、限流最多 1024 个固定槽、认证流程及审计各 128 个固定槽。审计仅记录 actor、action、result 和时间，不记录凭据。流程中的 PKCE verifier 通过 SecretStore 引用保存，10 分钟后流程失效，固定槽复用时清理原引用。秘密使用最多 512 个可复用键，引用同时绑定秘密版本，旧流程清理不能删除复用后的秘密；就绪后安全设置缺失时返回不可用，不回退默认关闭。

固定 `clock` 用 CAS 保存已观察时间，拒绝请求不会回滚时间，时钟回拨或重启不能恢复过期凭据。所有有状态计划使用读前、读后时钟版本围栏核验读集。续期先保存 `pendingTouch`，只在重新读到已提交 pending、身份和原期限仍有效后，以槽版本和时钟版本 CAS 确认续期。授权与 Cookie 刷新只读取已确认时间，不续期。

## 控制接口

下表路径相对于受保护的插件控制入口。所有写接口要求有效管理会话；Cookie 写请求还需 Origin 和 CSRF。未声明字段拒绝接受。密码字段始终要求 `passwordConfirmation`，密码及 secret 不出现在响应中。

| 路径 | 方法 | 请求与响应 |
| --- | --- | --- |
| `/self` | GET | `{administrator: User, csrfToken?}` |
| `/users` | GET | `{users: User[]}` |
| `/users` | POST | `{username, displayName?, password?, passwordConfirmation?}` → `{user: User}`，201 |
| `/users/update` | PUT | `{id, username, displayName, disabled}` → `{user: User}` |
| `/users/password` | POST | `{id, password, passwordConfirmation}` → `{ok:true}` |
| `/password` | POST | `{currentPassword, password, passwordConfirmation}` → `{ok:true}`，清除当前 Cookie |
| `/logout` | POST | `{ok:true}`，清除当前 Cookie |
| `/identities` | GET | 可选 `?userId=`，返回 `{identities:[{id,userId,connectionId,protocol,issuer,subject}]}` |
| `/identities` | POST / DELETE | 绑定 `{userId,connectionId,subject}`；解绑 `{id}`；返回 `{ok:true}` |
| `/identities/link/start` | POST | `{connectionId}` → `{authorizationUrl,flowId}` |
| `/identities/link/finish` | POST | `{flowId}` → `{ok:true}`，撤销该用户会话 |
| `/login-connections` | GET | `{publicOrigin: string|null, connections: Connection[]}`；未显式配置公开 Origin 时 `publicOrigin` 为 `null` |
| `/login-connections` | POST / PUT | `{id,label,enabled?,provider,clientId,clientSecret?,configuration,scopes?}`；PUT 增加 `version`；返回 `{connection: Connection}`，创建为 201 |
| `/login-connections` | DELETE | `{id,version}` → `{ok:true,sessionRevoked:boolean}`；清理该连接的身份绑定和在途流程，保留平台用户，撤销受影响用户的全部会话 |
| `/login-connections/discover` | POST | `{mode:"issuer"或"discovery",url}` → `{issuer,discoveryUrl,authorizationEndpoint,tokenEndpoint,jwksUri,tokenEndpointAuthMethods,idTokenSigningAlgs}`，不保存连接 |
| `/login-settings` | GET / PUT | `{version,autoCreateUsers}`；PUT 需提交读取的版本 |
| `/turnstile` | GET | `{version,enabled,siteKey,hostnames,hasSecret}` |
| `/turnstile` | PUT | `{version,enabled,siteKey,hostnames,secret?}` → 同 GET；省略 secret 保留原值 |
| `/session-policy` | GET / PUT | `{version,policy:{idleTimeoutMinutes,absoluteTimeoutMinutes}}` |

`User` 为 `{id,username,displayName,disabled,hasLocalPassword,requiresPasswordChange}`。`Connection` 为 `{id,label,enabled,provider,issuer,clientId,scopes,hasSecret,version,configuration}`。创建的 `id` 为小写 UUID，已存在时拒绝覆盖。`provider` 为 `google`、`microsoft`、`github` 或 `oidc`，`issuer` 为只读展示值；Microsoft 身份绑定保存实际令牌 Issuer。

`configuration`：Google／GitHub 为 `{}`；Microsoft 为 `{accountType,tenantId?}`，`accountType` 为 `tenant`、`organizations`、`consumers` 或 `common`，仅 `tenant` 允许并要求 `tenantId`。自定义 OIDC 为 `{mode,issuer,...}`：`issuer` 模式无额外字段；`discovery` 模式增加 `discoveryUrl`；`manual` 模式增加 `authorizationEndpoint`、`tokenEndpoint`、`jwksUri` 及可选的 `tokenEndpointAuthMethod`、`idTokenSigningAlg`。只有自定义 OIDC 接受顶层 `scopes`。Microsoft 的 `common`／`organizations` 连接不接受仅提供 subject 的手工绑定，返回 `verified_identity_required`；使用用户信息页的认证绑定流程。

PUT 连接省略 client secret 时保留原秘密。版本过期返回 `409 version_conflict`，需重新读取后编辑。禁用最后本地用户返回 `409 last_local_user`，重复用户名或绑定分别返回 `username_exists`、`identity_exists`。错误体为 `{error:code}`。

匿名认证协议入口由选中的管理 provider 提供：

- `GET /api/auth/login/options` → `{local:{enabled:true,turnstile:{enabled,siteKey?}},methods:[{id,label,provider}]}`。
- `POST /api/auth/login/start` 输入 `{methodId,returnTo?}`，返回 `{authorizationUrl,flowId}` 和流程 Cookie；要求 Origin 与 provider 绑定。
- `GET /api/auth/login/callback/:methodId` 验证回调后重定向；成功默认 `/#/`，绑定回到 `/#/extensions/user-auth/profile?oidcLink=<flowId>`，错误返回 `/#/login?oidcError=<code>`，不把授权码放进应用 URL。
- 本地登录输入 `{username,password,transport?,turnstileToken?}`。Cookie 登录返回 `{administrator,csrfToken}`；Bearer 登录返回 `{administrator,token,expiresIn}`。

初始化入口为 `setupStatus()`、`initialize(request)` 和只读 `readManagementSetup(state)`。独立初始化请求输入 `{username,password,passwordConfirmation}`；启用时 `bootstrap` 接受上述 `operation: "initialize"` 或 `operation: "verify"`。离线恢复通过 `offlineRecovery: {kind: "identity", actions}` 声明 `add-user`、`reset-password`、`reset`；`release-auth` 由宿主处理。状态、存储或 provider 不可用时保持受保护，不回退匿名访问。

针对性验证：

```sh
bun test --isolate plugins/user-auth/tests/unit/ plugins/user-auth/tests/integration/
```

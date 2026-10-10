# ChatGPT OAuth 个人自用插件

插件提供两种独立的账户来源。新增账户默认选择「使用 ChatGPT 登录」（SIWC）；原有 Codex 设备码和浏览器登录继续可用。账户重新登录沿用原登录类型，旧账户缺少 `authType` 时按 Codex 处理。

| 来源 | 上游 | 凭据允许的请求 |
| --- | --- | --- |
| `chatgpt-siwc` / Sign in with ChatGPT | `https://api.openai.com` | `POST /v1/responses`、`GET /v1/models` |
| `chatgpt` / 原 Codex OAuth | `https://chatgpt.com` | 原 Codex Responses 和 models 接口 |

SIWC 请求使用 `Authorization` 和 Bungee 自身的 `User-Agent: Bungee/5.11.0`、`Originator: Bungee`。来源之间不共用凭据策略，不会把 SIWC 令牌发到旧 Codex 后端。凭据由插件控制面存储，服务及路由草稿只保存账户引用。

## 登录：Docker 和二进制使用同一流程

Bungee 可以部署在你的电脑、远程服务器或 Docker 容器。授权完成后的回调固定为 `http://127.0.0.1:1455/auth/callback`；这里的 `127.0.0.1` 是**打开授权页面的用户电脑**，不是远程 Bungee 或容器地址。容器无需发布 1455 端口。

1. 在 Bungee 的 ChatGPT 账户页面点击「添加账号」，选择「使用 ChatGPT 登录」，点击「开始登录」，取得授权地址。
2. 打开授权地址，在浏览器中完成授权。
3. 从浏览器最终地址栏复制**完整回调地址**，粘贴到 Bungee 登录窗口，点击「提交回调地址」，等待账户保存成功。最后的本地回调页面可能无法打开，仍可复制其地址。必须保留完整查询参数，不要只复制 `code`。
4. 在账户卡片点击「用于服务」或「用于路由」。检查编辑器中的草稿后，明确保存才会发布配置。

这与旧 OAuth 的手动回调交互相同，不需要为 Docker 或二进制配置两套认证。登录窗口关闭不会自动取消会话；需要停止时点击「取消登录」。提交或关闭输入窗口后，界面清空回调内容，不将其写入浏览器存储或草稿。不要把授权地址、回调地址或凭据贴到公共日志和聊天中。

如果希望本地回调页面正常打开，可在打开授权地址前，在浏览器所在电脑运行可选命令 `bungee oauth-callback`（独立发布的原生程序使用 `./bungee-linux oauth-callback` 等对应文件名）。它只监听 `127.0.0.1:1455`，捕获一次回调后将完整地址输出到终端并退出；将该地址粘贴回 Bungee 即可。此命令不交换或保存令牌，不启动代理服务。容器部署也不需要安装该命令。

SIWC 会话使用 PKCE、state 和 nonce；插件验证回调及身份后才保存账户。部署的 host ID 保存在插件存储中，重启时复用；Docker 持久化数据目录和二进制数据目录均应按现有 Bungee 部署方式保留。不要在登录进行中删除插件存储。

## 请求与用量边界

SIWC 支持客户端的 `/v1/responses` 和 `/v1/chat/completions` 请求；后者转为公共 `/v1/responses`。上游请求固定 `store:false`、`stream:true`，客户端仍可选择接收流式结果或聚合后的 JSON。

客户端需发送完整对话。字符串 `input` 转为用户消息数组，system 消息转为 developer，`previous_response_id` 被拒绝。其他不支持的后台、对话句柄、输出上限、采样、元数据等字段被移除，具体列表见 `server/adapter.ts`。工具限定为 function 和 custom；不支持托管 MCP、tool search、原生 computer、image generation、file search、code interpreter 等工具。

SIWC 的模型接口按返回的 `visibility:list` 生成 OpenAI 格式模型列表；不套用旧 Codex 的 `supported_in_api` 过滤条件。

此登录方式没有公开的用量查询或重置额度接口。账户页与额度组件提供 [ChatGPT](https://chatgpt.com) 设置用量入口，不查询旧 Codex 用量、不显示自动重置。旧 Codex 账户保留现有功能。

这是个人自用集成。协议、账户权限、模型和额度可随上游变化；实现不保证账户不受限制或不会封号，也不表示获得官方应用授权。

## 实现来源与验证

OAuth/PKCE 流程参考 [Pi 的 MIT 实现](https://github.com/earendil-works/pi/blob/main/packages/ai/src/auth/oauth/openai-chatgpt.ts)。SIWC 在 Bungee 插件接口中独立实现，没有复制官方 DevKit 的非商业授权代码。原插件来源说明保留在 [LICENSE](LICENSE)。

针对性测试：

```sh
bun test plugins/chatgpt-oauth/tests/unit/siwc-adapter.test.ts \
  plugins/chatgpt-oauth/tests/unit/ui/siwc-account-model.test.ts \
  plugins/chatgpt-oauth/tests/unit/ui/account-automation.test.ts
```

这些测试覆盖请求转换、受限工具、模型列表、SSE 聚合/转换、授权地址校验、登录类型和 manifest 契约；真实登录、账户权限及上游服务可用性需用自己的账户验证。

## 共享正文接口

插件 server 只依赖公开 `@jeffusion/bungee-core/plugin` SDK。代理返回的模型列表和 HTTP 错误使用宿主 `bodyHandle.json()`；Codex/SIWC 的流式转换和非流式聚合共同使用 `bodyHandle.events()`。解压、SSE 分帧和 JSON 解析由宿主完成，插件只校验 Codex 事件与终态。模型正文限额继承宿主 `bodyHandle.maxBytes`，日志保存限额独立。缺少共享正文视图会返回固定错误，不自行创建读流器。

OAuth 令牌交换、账户用量/额度 RPC、模型目录缓存和管理 API 输入是独立辅助网络入口，其限额和 reader 不用于代理正文。

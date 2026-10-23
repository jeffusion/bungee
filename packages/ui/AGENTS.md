# 管理 UI 开发

遵循[根指引](../../AGENTS.md)。触及本包、插件原生组件或管理根下 HTML 前，读取[工业设计规范](docs/INDUSTRIAL_DESIGN_SYSTEM.md)。

- 使用单一深色工业主题、橙色强调和现有设计 token。
- 基础交互采用 `src/components/ui/`；工业语义组件采用 `src/components/industrial/`；业务组件归 `src/components/domain/`，布局归 `shell/`。禁止恢复已删除的 Nx、表单和输入兼容包装层。
- 新增及修改组件使用 Svelte 5 runes、事件属性和 snippets；响应式翻译计算必须先检查 `$isLoading`。
- 重复结构由共享组件拥有；样式由组件隔离。新增或修改全局样式必须先按规范记录明确例外并审查，禁止刷新样式基线掩盖失败。
- 修改 UI 行为后按设计规范完成真实浏览器、错误检查和截图验收；HTTP 成功不能证明页面可用。不新增自动化用例不等于免除验收，真实浏览器验收也不等于每次都要新增永久用例。
- 前端自动化仅覆盖设计规范 §8.1 允许的业务行为；CSS、尺寸、响应式布局、动画、焦点、译文和展示格式走浏览器审查，不以公开契约或测试下沉为由新增自动断言。
- 原生组件注册表由 `bun run generate:widgets` 生成，不手改生成入口。

| 任务 | 按需读取 |
| --- | --- |
| 组件、布局与样式 | 设计规范相应章节、组件源码、`/#/design` |
| 插件组件 | 目标插件 manifest、README、[插件参考](../../docs/reference/plugin-api.md) |
| 前端测试设计、新增与评审 | [scripts](../../.agents/skills/scripts/SKILL.md) 的测试准入与层级选择，再读现有测试及夹具；不另建测试框架 |
| 文档或工具 | [documentation](../../.agents/skills/documentation/SKILL.md) 或 [scripts](../../.agents/skills/scripts/SKILL.md) |

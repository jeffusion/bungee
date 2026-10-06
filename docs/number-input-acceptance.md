# 整数 NumberInput 验收

本轮只实现 models.dev 两个整数输入框，复用现有 Input、按钮样式和图标，不新增依赖或历史数据兼容。刷新间隔为 1–24 小时，默认 24；下载超时为 5–120 秒，默认 15。

## 行为

- 仅接受 ASCII 数字；拒绝小数、正负号、指数和字母，非法粘贴整次拒绝。
- 清空绑定为 `undefined`，必填校验阻止保存，不自动转为 0。
- 编辑时允许暂时越界，失焦或 Enter 时夹到边界并去除前导零。
- 自有上下按钮和方向键按 1 步进；边界禁用，按钮不会提交表单。
- 保留文本选择和光标；支持外部值同步、只读、禁用和 spinbutton 无障碍属性。
- 业务保存和服务端仍验证整数及范围。

## 已完成的验证

证据目录：`/tmp/brave-egret-integer-number-input/`。本地更新时会将证据复制到对应备份目录的 `checks/` 中。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 针对性测试 | 58 通过，0 失败 | `targeted-tests.log` |
| 完整构建 | 通过 | `build-final.log` |
| 最终代码串行全量测试 | 3,964 通过，3 项平台相关跳过，0 失败；387 文件，477.07 秒 | `full-tests-final.log` |
| 独立组件 Chromium 验收 | 5 组通过，无页面或控制台错误 | `component-final/report.json` |
| 真实业务 Chromium 验收 | 13 步通过，独立数据库、凭据和端口；含真实键入、系统剪贴板粘贴、保存后重载 | `browser-final/report.json` |
| 类型诊断比较 | core 9 → 9，UI 27 → 27，无新增；既有诊断仍存在 | `type-comparison.json` |
| 独立只读审查 | 未发现实质性缺陷 | 本轮审查记录 |

组件验收命令：`NUMBER_INPUT_EVIDENCE_DIR=/tmp/bungee-number-input-evidence bun run packages/ui/tests/number-input-playwright.ts`（在仓库根目录执行）。

## 失败证据与边界

首次全量运行的插件构建用例超过默认 5 秒，RPC 的 SIGKILL 恢复卡在旧代释放；第二次串行全量运行中 RPC 正常重启未能在 10 秒内确认一个 worker 退出，后续测试级联失败。证据分别为 `full-tests.log`、`full-tests-serial.log`，保留了失败 fixture。

插件构建单独复跑 8 项通过；RPC 单独复跑 3 项通过；增加临时阶段日志的最小前置序列 16 项通过，各项 worker 清理均完成。临时运行时诊断已撤销并重新构建，没有修改退出证明或强杀策略。此前 RPC 失败的内部原因尚未确认，不能宣称已修复其间歇性问题。

临时诊断撤销并重新构建后，最终串行全量测试通过，包含此前失败的 RPC 重启、SIGKILL 恢复、真实计费请求和清理检查。

浏览器证据限 Chromium；输入法恢复检查使用合成 composition 事件，不代表真实输入法或其他浏览器已验收。

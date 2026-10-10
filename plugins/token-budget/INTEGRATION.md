# Key 策略与预算集成契约

三个插件均为 global runtime；预算 manifest 的 ingress entry 指向 server/policy.ts，其 createIngress 也由 server/index.ts 转导出。Key UI 组件是 ui/KeyPolicy.svelte，Host 传入 keyId、active、ready、value、usage、save。Host 资源扩展将组件插入 Key 高级设置，只有 active 且 ready 可编辑。

## 管理控制面

GET/PUT `/keys/:keyId`；PUT body 是策略本身或 null。可信 management subject 必须在 API context 内。Host 先按 capability 授权，再调用插件。

- key-access：`{services: string[]|null, routes: string[]|null, models: string[]|null}`。非空数组，同维度 OR，跨维度 AND；model 匹配最终值，区分大小写并支持 `*` 通配符，无通配符时精确匹配。
- key-rate-limit：`{rps: positiveFiniteNumber, burst: positiveSafeInteger}`。
- token-budget：`{mode: "daily"|"weekly"|"monthly"|"cumulative", unit?: "tokens"|"usd", limit: number}`。未提供 unit 保持旧 Token 策略原值；Token 额度为正安全整数，USD 额度用美元输入，最多六位小数且必须为正，转换为安全整数 nanoUSD（1 USD = 1,000,000,000 nanoUSD）。

Control Host 注入 `validateKeyPolicyReferences(keyId, policy): boolean|Promise<boolean>`。对三个插件均检查 Key 是否存在且属于数据域；key-access 还检查所有服务/路由 ID 存在、路由所属服务与选择一致。没有校验器拒绝修改，不允许把缺失资源当成不限制。scope 准入时目标对象存在性由 Host 对冻结的目标保证。

key-access/rate policy publication：`{version,value:{byKey:{[keyId]:policy|null}}}`。
预算 publication：`{version,value:{version,byKey:{[keyId]:{policy,cumulative,monthly:{[UTCMonth]:number},unresolved:{[attemptRecordId]:"pending"|"unknown"}}}}}`。准入版本由独立耐久记录 admission-version 提供，策略编辑、结算或 unknown 状态变化才递增；prepare 与仅清除 pending 的 cancel 保留原准入版本，耐久记录 CAS 版本独立递增。预算准入按当前单位检查各自 unknown，正常在途 pending 不预留额度。冷启动将 Token/金额 pending 标成 unknown。完整扩展账本结构见下方。

## 预算数据面

budget Plugin 实例具有 `prepareAdmissionAttempt({target,snapshot,body,stateRpc})`，Host 从 global handler 调用；也可用 `createBudgetConsumer(meteringService, pricingService)` 工厂。snapshot 是该插件的 ingress grant JSON，无预算为 null。方法读取计量服务 supported，unsupported 返回422；USD 预算用实际 prepareAttempt 返回的 model/pricingProvider 调用 token-stats.pricing.v1.canPrice，不可定价返回422，服务调用失败503；发送前 stateRpc prepare，失败503。订阅必需 token-metering 的每 request 结果，按 attempt 筛选后调用 token-stats.pricing.v1.price 并 settle；价格服务缺失、失败或无匹配时 costNanoUsd 为 null，不能按零价处理。Token 策略也尝试记费用。返回 `{denial?,cancel?,onResult?}`；cancel 只限未发送，onResult `{sent,outcome,observationLost?}`：未发送 cancel，观察丢失 settle unknown，普通完成先等待 `token-metering.drainRequest(requestId)`，保持请求租约直到必需回调完成；无结算回调也按 unknown 处理。

Host 的 stateRpc 为当前 target 绑定可信 principal/requestId/attemptId，调用 PluginControl.stateRpc(method,payload,context)，不得从 payload 取得身份：

- prepare `{snapshot:{keyId,requestId,month,day,week,policy,version}}`：固定请求快照且登记 attempt pending，重复内容保持幂等；身份/周期/策略变化拒绝。每个后续 failover attempt 单独准备。
- settle `{result:TokenMeteringResult,costNanoUsd: nonnegativeSafeInteger|null}`：累计 input+output，不重复累计缓存；输入输出分别官方优先；更高 settlementVersion 更新差额，相同版本相同内容幂等，不同内容拒绝。缺少有效观察为 unknown，完整官方结果可以恢复。
- cancel `{sent:false}`：仅 pending 可取消，未发送不计账；sent=true 拒绝。
- status `{}`：返回该可信 ctx 对应 attempt 或 null，用于 RPC ACK 不确定时查询，禁止换 ID 重发。

每次结算后控制插件 await publishPolicy；prepare、status 与仅清除 pending 的 cancel 不发布，以保持 preview→prepare→admit 版本 CAS 稳定。Host 必须保证 durable ACK、policy 发布与 ingress 账务更新一致；发布失败或 RPC 结果未知时阻止该 Key 新预算准入，不能继续用旧低用量快照。已经发送的流继续。Master 不可用时新 attempt 准备失败不能发送。

所有账务只在 token-budget namespace；不会写 core token 字段。停用仅停止新请求选择此插件，原 handler 与 token-metering service lease 必须保留到原请求结算结束。旧 RPC stateRpc 可以结算，dispose 不删配置或账务。


## 四种周期与两种单位

日/月按 UTC 日历，周按 UTC 周一日期（例如周日 2026-02-01 属于 2026-01-26 周）。准入快照同时固定 day/week/month；迟到结算、跨日/周/月、修改策略或切换单位都只更新原快照周期。Token 和金额各自同时记录累计、每日、每周、每月，不重置旧账。金额只累加整数 nanoUSD，较高结算版本按差额修订，未知价格保留之前已经入账的金额并单独标 unknown，相同版本相同内容幂等。

Token unresolved 和 money.unresolved 独立：Token 策略只因 Token unknown 拒绝，USD 策略只因费用 unknown 拒绝（503 token-budget.cost_unknown）。pending 不预留额度；冷启动将各轴 pending 转 unknown。未发送 cancel 不记 Token 或费用。请求租约覆盖定价和 durable settle，必需结算完成后才释放。

## UI 使用结构及旧数据界限

GET usage/readResource.usage 与 publication 每 Key 账本包含：

```ts
{
  policy, cumulative, monthly: {[UTCMonth]: tokens},
  daily: {[UTCDate]: tokens}, weekly: {[UTCMondayDate]: tokens},
  unresolved: {[attemptRecordId]: 'pending'|'unknown'},
  money: {
    cumulativeNanoUsd, monthlyNanoUsd: {[UTCMonth]: nanoUSD},
    dailyNanoUsd: {[UTCDate]: nanoUSD}, weeklyNanoUsd: {[UTCMondayDate]: nanoUSD},
    unresolved: {[attemptRecordId]: 'pending'|'unknown'}
  },
  collection: {
    dailyWeeklyStartedAtMs: number|null, moneyStartedAtMs: number|null,
    legacyTokensExcluded: boolean
  },
  // usage additionally contains attemptCount and at most 50 attempts:
  attempts: [{requestId,attemptId,month,day:null|string,week:null|string,
    status,inputTokens:null|number,outputTokens:null|number,inputSource,outputSource,
    partial,costNanoUsd:null|number,costStatus:'pending'|'known'|'unknown'|'untracked'}]
}
```

费用展示除以 1e9，USD limit 本身仍为美元数。collection 时间表示此 Key 开始采集新字段的实际时间；null 表示尚未开始。legacyTokensExcluded 标识旧 Token 历史不包含在每日/每周账本中。旧累计/月度 Token 原样保留，旧 month-only 在途快照只更新累计/月度，没有真实日期就不推断日/周；旧历史没有金额就不从 Token 或当前价格反算。金额账本只包含新增的精确费用观察，应向用户说明与旧 Token 历史起点不同。untracked 表示旧 attempt 没有费用观察，不能显示为费用 0。

## 离线金额人工补记

offlineRecovery 的 recoverUsage 输入包含 `{keyId,requestId,attemptId,reason}`，可提供 `inputTokens,outputTokens` 一对、`costUsd`（非负且最多六位小数），或同时提供两者；只有各自未解决轴允许人工补记。0 美元必须是人工核验确认的显式值。Token 补记保留独立费用 unknown，随后允许费用单独补记。Token 与费用分别使用不可变 recovery/recovery-cost 审计记录，记录原 attempt、理由、时间、固定周期及 Token/金额差额；完全相同输入幂等，内容冲突拒绝。人工恢复后的该 attempt 拒绝自动结算覆盖审计值。

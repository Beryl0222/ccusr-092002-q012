# 县域转诊闭环管家

衔接基层转诊、院前评估、院内陪诊、危急升级和康复下转回访。

`contracts/referral_order.json` 保存公开的领域样例，用来约定外部数据的名称与层级；样例不含真实个人资料、业务凭据或生产连接信息。

执行 `npm run check` 可检查服务身份，运行 `npm test` 可核对基础契约。服务启动后，`/health` 返回项目标识。

## 转诊质量改进服务（质控科）

`src/quality/` 是**独立的质量改进服务** `referral-quality-improvement`，与临床转诊管家分离。它把脱敏转诊单与**已关闭旅程**折算为按规则版本计算的时间指标，支撑审查、申诉、整改与月报。

边界（强约束）：

- 正在诊疗（`status=active`）的个案**只读接入**；对其建立审查等操作返回 409。
- 系统不提供任何改道/变更路线端点（无 `/reroute` 之类），临床路线只能由临床人员决定。
- 下钻视图对转诊号做不可逆假名化，去除姓名、证件、电话、住址与病情自由文本。

### 六个时间指标（`src/quality/rules.js`）

| 指标 | 起点 → 终点 | v1 阈值 | v2 阈值（2026-10-01 起） |
|---|---|---|---|
| `docs_ready` 资料齐备 | 下单 → 必备资料齐 | 到院窗口前 | 到院窗口前，且新增“风险评估表” |
| `first_contact` 首次联系 | 下单 → 首次联系 | 30 分钟 | 15 分钟 |
| `handover_wait` 到院交接 | 到院 → 完成交接 | 20 分钟 | 10 分钟 |
| `escalation_response` 危急升级 | 升级请求 → 启动改道 | 30 分钟 | 15 分钟 |
| `downgrade_confirm` 下转确认 | 发起下转 → 基层确认 | 48 小时 | 24 小时 |
| `followup_completion` 随访完成 | 关闭 → 随访完成 | 14 天 | 7 天 |

规则版本**只追加、不改写**：指标按转诊创建时间适用当时口径；缺资料、未联系、应升级未升级、到院未交接等显式记为未达标并注明原因（非简单空值），从而暴露“反复漏传的基层点”“无人接应的到院时段”“升级是否真缩短了等待”。

### 质控能力

- **审查队列**：按来源机构 / 风险层级 / 班次（白班 8–16、小夜班 16–24、大夜班 0–8，东八区）建群，确定性哈希抽样，重放得到相同样本。
- **双人标注**：两位审查员独立标注根因；一致即定论，分歧由第三人仲裁；双方原始意见与仲裁结论都保留。
- **机构申诉 / 资料补正 / 口径调整**：全部以追加事件保存，保留前后结论（申诉成立翻转结论但保留 `prior_verdict`；补正叠加不覆盖原始单）。
- **整改闭环**：培训/排班/接口整改必须有负责人、期限与复测样本量+达标率；无复测、样本不足、达标率不足或缺证据都**不得关闭**，不能凭总体平均值宣告关闭。
- **月报**：发布时冻结输入、排除清单、事件流位置与指纹（规则版本表入哈希）；样本量 < 5 的基层点只列数据、**不公开排名**。
- **下钻**：`/drilldown/:referral_id/:metric` 从异常指标下钻到去标识事件、审查意见、申诉与整改证据。
- **重放**：`/months/:month/replay` 在冻结位置重算并校验指纹，历史月份必须得到当时一致的报告。

### 运行

```bash
npm run check:quality     # 质量服务身份检查
npm run start:quality     # 默认 :8001，数据写 data/quality/events.jsonl（追加式，已 gitignore）
npm test                  # 含指标口径、双标注、申诉、整改、冻结重放、只读边界等用例
```

主要端点：`POST /journeys`、`POST /journeys/:id/amendments`、`POST /exclusions`、
`POST /queues`、`POST /reviews`、`POST /annotations`、`POST /adjudications`、
`POST /appeals`、`POST /actions`（及 `/evidence`、`/retests`、`/close`）、
`GET /report?month=`、`POST /months/:month/freeze`、`GET /months/:month/replay`、
`GET /drilldown/:id/:metric`。旅程字段见 `contracts/referral_quality_journey.json`。

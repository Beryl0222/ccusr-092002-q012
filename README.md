# 县域转诊闭环管家

衔接基层转诊、院前评估、院内陪诊、危急升级和康复下转回访。

`contracts/referral_order.json` 保存公开的领域样例，用来约定外部数据的名称与层级；样例不含真实个人资料、业务凭据或生产连接信息。

执行 `npm run check` 可检查服务身份，运行 `npm test` 可核对基础契约。服务启动后，`/health` 返回项目标识。

## 转诊质量改进服务（referral-quality）

质控科独立使用的第二服务，入口 `src/quality-server.js`（默认端口 8001）：

```bash
npm run start:quality -- --port 8001
```

### 边界

- **只消费脱敏数据**：`contracts/quality_journey.json` 为旅程契约；姓名、证件号、电话、住址、住院号等直接标识字段在入口即被拒绝。
- **在诊个案只读**：`status=open` 的旅程允许同步，但任何质控写操作（结论、补正、审查、申诉）一律 `409 OPEN_READONLY`，系统不替临床人员改变路线。
- 仅 `status=closed` 的已关闭旅程进入指标计算。

### 规则版本化的六项时间指标

口径集中在 `src/quality/rules.js`：资料齐备、首次联系、到院交接、危急改道等待、下转确认、随访完成。
每项产出 `ok / breach / missing / n/a` 四态——起点存在但缺完成事件记为 **missing**（反复漏传资料、到院无人接应、升级后未改道），在均值之外单独统计缺失率与失败率。
口径调整只新增规则版本（如 `qc-rules-2026-10` 收紧首联/交接 SLA），旧版本永久保留，月报按发布时冻结的版本计算与重放。

### 主要接口（前缀 `/v1`）

| 能力 | 接口 |
| --- | --- |
| 摄取转诊单/旅程 | `POST /referrals`、`POST /journeys` |
| 资料补正（保留前后结论） | `POST /journeys/:id/corrections` |
| 个案结论（可指定规则版本） | `GET /journeys/:id/conclusion?ruleVersion=` |
| 当前指标（总体/分段/异常/排名/接应曲线） | `GET /metrics?month=&ruleVersion=` |
| 排除清单 | `POST/DELETE /exclusions[/:id]` |
| 审查队列（来源/风险/班次、确定性抽样、按机构分层） | `POST /review-queues` |
| 双人根因标注、分歧裁定 | `POST /reviews/:caseId/annotations`、`.../adjudication` |
| 机构申诉（前后结论留痕） | `POST /appeals`、`POST /appeals/:id/response` |
| 指标口径调整留痕 | `POST /caliber-changes` |
| 整改（负责人/期限/复测样本/证据） | `POST /actions`、`.../evidence`、`.../reaudit`、`.../close` |
| 月报冻结发布、重放、下钻 | `POST /reports/:month/publish`、`POST .../replay`、`GET /reports/:month`、`GET /drilldown` |

### 质控规则

- **双人标注**：两名不同审查人独立标注，一致即成立；不一致由未参与原审的第三人裁定，标注不可覆盖。
- **整改关闭守卫**：必须有负责人、期限、针对该问题分段（机构×班次×指标）自身的复测样本与整改证据；复测样本不足或失败率超阈值一律 `422`，禁止仅凭总体平均值宣告关闭。
- **月报冻结**：发布时冻结输入清单（逐例内容指纹）、排除清单与规则版本；冻结后的补正不影响历史月份，重放（replay）逐版本取回旧数据，校验 `reportHash` 一致。
- **小样本保护**：样本少于规则书 `minRankSample` 的基层点只给计数、不公开排名。
- **下钻**：从异常指标可看到去标识事件流（病例与执行者伪名化、仅保留相对时序与班次）、双人审查意见、申诉与整改证据。

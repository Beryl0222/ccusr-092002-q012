import assert from "node:assert/strict";
import test from "node:test";

import { QualityService } from "../../src/quality/service.js";
import { publishMonthlyReport, replayReport, getReport, liveDrilldown } from "../../src/quality/reports.js";
import { makeJourney, septemberDataset, octoberDataset } from "../helpers/fixtures.js";

function seededSeptember(clock = "2026-10-01T09:00:00.000Z") {
  const svc = new QualityService(() => clock);
  for (const j of septemberDataset()) svc.ingestJourney(j);
  return svc;
}

test("月报发布冻结输入、排除清单与规则版本", () => {
  const svc = seededSeptember();
  svc.addExclusion("FD-C1", { code: "test_record", reason: "演练数据" });
  const report = publishMonthlyReport(svc, "2026-09", { ruleVersion: "qc-rules-2026-09" });

  assert.equal(report.ruleVersion, "qc-rules-2026-09");
  assert.equal(report.metrics.generatedFrom.included, 12);
  assert.equal(report.metrics.generatedFrom.excluded, 1);
  assert.ok(report.freeze.inputHash);
  assert.ok(report.freeze.exclusionHash);
  assert.ok(/^[0-9a-f]{8}$/.test(report.reportHash));
  // 冻结输入逐例记录内容指纹
  const frozenB1 = report.freeze.inputs.find((i) => i.referral_id === "FD-B1");
  assert.ok(frozenB1.contentHash);

  // 同月不可重复发布
  assert.throws(() => publishMonthlyReport(svc, "2026-09", { ruleVersion: "qc-rules-2026-09" }), /已冻结/);
});

test("冻结后到达的资料补正不改变历史报告：按冻结版本重放结果一致", () => {
  const svc = seededSeptember();
  const report = publishMonthlyReport(svc, "2026-09", { ruleVersion: "qc-rules-2026-09" });
  const bNightBefore = report.metrics.segments.origin_shift["店下镇卫生院|night"];
  assert.equal(bNightBefore.metrics.materials_ready.missing, 4);

  // 发布后 B1 补传资料（当前数据变化）
  svc.submitCorrection(
    "FD-B1",
    makeJourney({
      id: "FD-B1",
      origin: "店下镇卫生院",
      risk: "high",
      t0: "2026-09-05T21:00:00+08:00",
      offsets: { materials_complete: 50, first_contact: 45, arrival: 30, handoff: 45 },
    }),
    { submittedBy: "店下镇卫生院", note: "补传检查报告" }
  );

  const replay = replayReport(svc, "2026-09");
  assert.equal(replay.consistent, true);
  assert.equal(replay.frozenHash, replay.replayedHash);
  assert.equal(replay.report.ruleVersion, "qc-rules-2026-09", "重放必须沿用冻结口径");
  const bNightReplayed = replay.report.metrics.segments.origin_shift["店下镇卫生院|night"];
  assert.equal(bNightReplayed.metrics.materials_ready.missing, 4, "重放仍为冻结时的漏传数");

  // 冻结对象本身不被改写
  assert.equal(getReport(svc, "2026-09").reportHash, report.reportHash);
});

test("冻结报告中小样本机构不公开排名", () => {
  const svc = seededSeptember();
  const report = publishMonthlyReport(svc, "2026-09", { ruleVersion: "qc-rules-2026-09" });
  assert.deepEqual(report.metrics.suppressedOrigins, [{ origin: "嵛山岛卫生院", sample: 2, ranked: false }]);
  assert.ok(!report.metrics.ranking.some((r) => r.origin === "嵛山岛卫生院"));
});

test("十月按新口径发布；重放九月仍得到九月口径，互不串扰", () => {
  const svc = seededSeptember();
  const sept = publishMonthlyReport(svc, "2026-09", { ruleVersion: "qc-rules-2026-09" });
  for (const j of octoberDataset()) svc.ingestJourney(j);
  const oct = publishMonthlyReport(svc, "2026-10", { ruleVersion: "qc-rules-2026-10" });

  assert.equal(oct.ruleVersion, "qc-rules-2026-10");
  assert.equal(oct.metrics.overall.first_contact.breach, 6);
  assert.equal(sept.metrics.overall.first_contact.breach, 4); // B1-B3,B5 首联超时

  const replaySept = replayReport(svc, "2026-09");
  assert.equal(replaySept.consistent, true);
  assert.equal(replaySept.report.metrics.overall.first_contact.breach, 4);
  assert.equal(replayReport(svc, "2026-10").consistent, true);
});

test("从异常指标可下钻到去标识事件、审查意见与整改证据", () => {
  const svc = seededSeptember();
  const report = publishMonthlyReport(svc, "2026-09", { ruleVersion: "qc-rules-2026-09" });
  const anomaly = report.metrics.anomalies.find(
    (a) => a.origin === "店下镇卫生院" && a.shift === "night" && a.metric === "arrival_handoff"
  );
  assert.ok(anomaly, "应存在店下夜班接应异常");

  // 双人审查 + 整改（培训/排班/接口整改带负责人、期限、复测样本）
  const queue = svc.createReviewQueue({ name: "夜班专项", origin: "店下镇卫生院", shift: "night", sampleSize: 2 });
  const target = queue.cases[0];
  svc.annotateRootCause(target.caseId, { reviewer: "qc-a", rootCauses: ["夜间无人排班"] });
  svc.annotateRootCause(target.caseId, { reviewer: "qc-b", rootCauses: ["夜间无人排班"] });

  const action = svc.createAction({
    title: "店下夜班接应排班整改",
    metric: anomaly.metric,
    origin: anomaly.origin,
    shift: anomaly.shift,
    owner: "李护士长",
    dueAt: "2026-10-20T00:00:00Z",
    requiredSample: 5,
    sourceAnomaly: anomaly,
  });
  svc.addEvidence(action.id, { type: "schedule", ref: "SCHED-2026-10-night", note: "夜班新增陪诊岗排班表" });

  // 直接在已冻结报告的下钻视图中核验（重算时也包含最新质控痕迹）
  const replay = replayReport(svc, "2026-09");
  const cell = replay.report.drilldown["店下镇卫生院|night"];
  assert.ok(cell);

  // 去标识：病例编号为伪名，执行者为伪名，事件只保留相对时序与班次
  const sampleCase = cell.cases[0];
  assert.match(sampleCase.case, /^J\d{3}$/);
  assert.ok(sampleCase.events.every((e) => typeof e.offsetMinutes === "number"));
  assert.ok(sampleCase.events.every((e) => e.actor === null || /^S\d{2}$/.test(e.actor)));
  const serialized = JSON.stringify(sampleCase.events);
  assert.ok(!serialized.includes("转诊管家") && !serialized.includes("护士"));

  // 审查意见可下钻
  const reviewed = cell.reviews.find((r) => r.case === target.case || cell.cases.some((c) => c.referralRef === target.referral_id && c.case === r.case));
  assert.ok(reviewed, "应能下钻到该异常分段的双人审查意见");
  assert.equal(reviewed.annotations.length, 2);

  // 整改证据可下钻
  const linked = cell.actions.find((p) => p.id === action.id);
  assert.ok(linked);
  assert.equal(linked.owner, "李护士长");
  assert.equal(linked.evidence[0].ref, "SCHED-2026-10-night");
  assert.equal(linked.status, "open");
});

test("运行时下钻同样可用，且只返回目标机构班次", () => {
  const svc = seededSeptember();
  const result = liveDrilldown(svc, { origin: "店下镇卫生院", shift: "night", ruleVersion: "qc-rules-2026-09" });
  assert.equal(result.cells.length, 1);
  assert.equal(result.cells[0].origin, "店下镇卫生院");
  assert.equal(result.cells[0].shift, "night");
});

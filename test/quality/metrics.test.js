import assert from "node:assert/strict";
import test from "node:test";

import { computeJourneyMetrics, computeMetrics } from "../../src/quality/metrics.js";
import { getRule } from "../../src/quality/rules.js";
import { makeJourney, septemberDataset, octoberDataset, validated } from "../helpers/fixtures.js";

const RULE_V9 = getRule("qc-rules-2026-09");
const RULE_V10 = getRule("qc-rules-2026-10");

test("六项时间指标按事件锚点正确计时", () => {
  const j = makeJourney({
    id: "T1",
    offsets: {
      materials_complete: 25,
      first_contact: 10,
      arrival: 30,
      handoff: 42, // 到院后 12 分钟
      escalation: 50,
      rerouted: 75, // 升级后 25 分钟
      down_transfer: 2 * 24 * 60,
      down_confirmed: 2 * 24 * 60 + 90,
      followup_complete: 5 * 24 * 60,
    },
  });
  const r = computeJourneyMetrics(validated(j), RULE_V9);
  assert.equal(r.metrics.materials_ready.minutes, 25);
  assert.equal(r.metrics.first_contact.minutes, 10);
  assert.equal(r.metrics.arrival_handoff.minutes, 12);
  assert.equal(r.metrics.escalation_wait.minutes, 25);
  assert.equal(r.metrics.down_confirmation.minutes, 90);
  assert.equal(r.metrics.followup_completion.minutes, 3 * 24 * 60 - 90);
  for (const k of Object.keys(r.metrics)) assert.equal(r.metrics[k].status, "ok", k);
});

test("缺完成事件记为 missing 而非平均时被忽略：反复漏传资料/无人接应可被发现", () => {
  const j = makeJourney({
    id: "T2",
    t0: "2026-09-05T21:30:00+08:00",
    offsets: { first_contact: 10, arrival: 30 },
  });
  const r = computeJourneyMetrics(validated(j), RULE_V9);
  assert.equal(r.metrics.materials_ready.status, "missing");
  assert.equal(r.metrics.arrival_handoff.status, "missing");
  assert.equal(r.flags.arrivalNoHandoff, true);
  assert.equal(r.flags.materialsMissing, true);
  assert.equal(r.shift, "night");
  // 未升级、未下转 -> n/a，不污染样本
  assert.equal(r.metrics.escalation_wait.status, "n/a");
  assert.equal(r.metrics.down_confirmation.status, "n/a");
});

test("危急升级未改道记 missing；超时改道记 breach，验证升级是否真缩短等待", () => {
  const unresolved = makeJourney({
    id: "T3",
    offsets: { materials_complete: 10, first_contact: 5, arrival: 20, escalation: 40 },
  });
  const r1 = computeJourneyMetrics(validated(unresolved), RULE_V9);
  assert.equal(r1.metrics.escalation_wait.status, "missing");

  const slow = makeJourney({
    id: "T4",
    offsets: { escalation: 40, rerouted: 95 },
  });
  const r2 = computeJourneyMetrics(validated(slow), RULE_V9);
  assert.equal(r2.metrics.escalation_wait.status, "breach");
  assert.equal(r2.metrics.escalation_wait.minutes, 55);
});

test("分段聚合识别 B 机构夜班为异常，且产出到院时段接应曲线", () => {
  const m = computeMetrics(septemberDataset().map(validated), RULE_V9);
  assert.equal(m.generatedFrom.included, 13);

  const bNight = m.segments.origin_shift["店下镇卫生院|night"];
  assert.ok(bNight, "应存在 B 机构夜班分段");
  assert.equal(bNight.metrics.materials_ready.missing, 4); // B1-B3,B5 漏资料
  assert.equal(bNight.metrics.arrival_handoff.missing, 5); // B1-B5 均到院无人接应（B4 走了升级改道）

  const anomaliesForBMaterials = m.anomalies.filter(
    (a) => a.origin === "店下镇卫生院" && a.shift === "night" && a.metric === "materials_ready"
  );
  assert.ok(anomaliesForBMaterials.length > 0, "B 机构夜班漏传应被标记异常");
  assert.ok(anomaliesForBMaterials[0].reasons.includes("missing_rate"));

  const coverage = m.arrivalCoverage.find((c) => c.hour === 21 || c.hour === 22);
  assert.ok(coverage.noHandoff > 0, "夜间到院时段应呈现无人接应");
});

test("样本少于 minRankSample 的基层点不公开排名，但保留计数", () => {
  const m = computeMetrics(septemberDataset().map(validated), RULE_V9);
  const rankedOrigins = m.ranking.map((r) => r.origin);
  assert.ok(rankedOrigins.includes("店下镇卫生院"));
  assert.ok(rankedOrigins.includes("太姥山镇卫生院"));
  assert.ok(!rankedOrigins.includes("嵛山岛卫生院"), "小样本机构不得出现在公开排名");
  const suppressed = m.suppressedOrigins.find((s) => s.origin === "嵛山岛卫生院");
  assert.deepEqual(suppressed, { origin: "嵛山岛卫生院", sample: 2, ranked: false });
  // 问题更严重的 B 机构排在 A 前面
  assert.deepEqual(rankedOrigins, ["店下镇卫生院", "太姥山镇卫生院"]);
});

test("同一份数据按不同规则版本计算得到不同结论：10 月收紧 SLA", () => {
  const rows = octoberDataset();
  const m9 = computeMetrics(rows.map(validated), RULE_V9);
  const m10 = computeMetrics(rows.map(validated), RULE_V10);
  assert.equal(m9.overall.first_contact.breach, 0);
  assert.equal(m10.overall.first_contact.breach, 6);
  assert.equal(m9.overall.arrival_handoff.breach, 0);
  assert.equal(m10.overall.arrival_handoff.breach, 6);
  assert.equal(m9.ruleVersion, "qc-rules-2026-09");
  assert.equal(m10.ruleVersion, "qc-rules-2026-10");
});

test("排除清单中的转诊不参与指标，但保留在排除列表可追溯", () => {
  const rows = septemberDataset();
  const exclusions = new Map([
    ["FD-B1", { code: "patient_cancelled", reason: "患者临时取消" }],
  ]);
  const m = computeMetrics(rows.map(validated), RULE_V9, { exclusions });
  assert.equal(m.generatedFrom.excluded, 1);
  assert.equal(m.generatedFrom.included, 12);
  assert.deepEqual(m.exclusions.map((e) => e.referral_id), ["FD-B1"]);
});

test("在诊(open)旅程不进入指标计算", () => {
  const open = makeJourney({ id: "OPEN1", status: "open" });
  const closed = makeJourney({ id: "C1", offsets: { materials_complete: 10, first_contact: 5 } });
  const m = computeMetrics([open, closed].map(validated), RULE_V9);
  assert.equal(m.generatedFrom.open, 1);
  assert.equal(m.generatedFrom.included, 1);
});

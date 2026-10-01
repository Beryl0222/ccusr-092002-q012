import assert from "node:assert/strict";
import test from "node:test";

import { QualityError, createQualityApp, sampleCases } from "../../src/quality/quality.js";
import { effectiveJourney } from "../../src/quality/store.js";
import { buildReport, freezeMonth, replayMonth } from "../../src/quality/report.js";
import { goodJourney, highRiskEscalated, tempApp } from "./helpers.js";

const expectError = (status, re) => (err) => err instanceof QualityError && err.status === status && re.test(err.message);

let seedCounter = 0;
function seedMonth({ app, month = "2026-09", origins = ["太姥山镇卫生院"], perOrigin = 6, mutate }) {
  const ids = [];
  for (const origin of origins) {
    for (let k = 0; k < perOrigin; k++) {
      seedCounter += 1;
      const id = `FD-${month.replace("-", "")}-${String(seedCounter).padStart(3, "0")}`;
      let j = goodJourney({ referral_id: id, origin });
      if (mutate) j = mutate(j, { origin, k, id });
      app.recordJourney(j);
      ids.push(id);
    }
  }
  return ids;
}

test("在诊个案只读：对 active 旅程建立审查被拒，且系统无改道能力", () => {
  const { store, app } = tempApp();
  app.recordJourney(goodJourney({ referral_id: "FD-ACTIVE-1", status: "active" }));
  assert.throws(
    () => app.openReview({ queue_id: "q", referral_id: "FD-ACTIVE-1", metric: "handover_wait", by: "qc" }),
    expectError(409, /在诊个案只读/)
  );
  // 应用层不暴露任何改道/变更路线方法
  assert.equal(typeof app.reroute, "undefined");
  assert.equal(typeof app.changeRoute, "undefined");
});

test("审查队列按机构/风险/班次建群，确定性抽样可复现", () => {
  const { app } = tempApp();
  seedMonth({ app, origins: ["太姥山镇卫生院", "店下镇卫生院"], perOrigin: 8 });
  const q1 = app.createQueue({ month: "2026-09", origin: "太姥山镇卫生院", ratio: 0.5, by: "qc" });
  const q2 = app.createQueue({ month: "2026-09", origin: "太姥山镇卫生院", ratio: 0.5, by: "qc" });
  // 第二次建同参数队列：cohort/抽样一致（queue_id 基于 cohort 指纹）
  assert.deepEqual(q1.sampled.sort(), q2.sampled.sort());
  assert.equal(q1.cohort_size, 8);
  assert.equal(q1.sampled.length, 4);
  // sampleCases 自身确定性
  assert.deepEqual(sampleCases(["a", "b", "c", "d"], { ratio: 0.5, salt: "x" }),
    sampleCases(["a", "b", "c", "d"], { ratio: 0.5, salt: "x" }));
});

test("风险层级与班次过滤生效", () => {
  const { app } = tempApp();
  app.recordJourney(highRiskEscalated({ referral_id: "FD-H-1", arrived_at: "2026-09-18T02:30:00+08:00", handover_at: "2026-09-18T02:40:00+08:00" }));
  app.recordJourney(goodJourney({ referral_id: "FD-L-1" }));
  const night = app.createQueue({ month: "2026-09", shift: "night", ratio: 1, by: "qc" });
  assert.deepEqual(night.sampled, ["FD-H-1"]);
  const high = app.createQueue({ month: "2026-09", risk: "high", ratio: 1, by: "qc" });
  assert.deepEqual(high.sampled, ["FD-H-1"]);
});

test("双人标注一致即定论；不一致须仲裁，仲裁覆盖但保留双方意见", () => {
  const { app } = tempApp();
  const [id] = seedMonth({ app, perOrigin: 1 });
  app.createQueue({ month: "2026-09", ratio: 1, by: "qc" });
  const rid = app.openReview({ queue_id: "q", referral_id: id, metric: "handover_wait", by: "qc" });

  // 分歧
  app.annotate({ review_id: rid, reviewer: "甲", root_cause: "夜间无人接应", metric_verdict: "missed" });
  let st = app.annotate({ review_id: rid, reviewer: "乙", root_cause: "患者迟到", metric_verdict: "met" });
  assert.equal(st.needs_adjudication, true);
  assert.equal(st.final_verdict, null);
  assert.throws(() => app.annotate({ review_id: rid, reviewer: "丙", root_cause: "x", metric_verdict: "met" }), expectError(409, /双人/));

  st = app.adjudicate({ review_id: rid, arbiter: "主任", final_root_cause: "排班缺口", final_verdict: "missed", note: "查排班表确认" });
  assert.equal(st.final_verdict, "missed");
  // 两位审查员的原始意见仍保留
  assert.equal(st.annotations.length, 2);
  assert.equal(st.annotations[0].root_cause, "夜间无人接应");
});

test("双人一致直接定论，无需仲裁", () => {
  const { app } = tempApp();
  const [id] = seedMonth({ app, perOrigin: 1 });
  const rid = app.openReview({ queue_id: "q", referral_id: id, metric: "first_contact", by: "qc" });
  app.annotate({ review_id: rid, reviewer: "甲", root_cause: "电话延迟", metric_verdict: "missed" });
  const st = app.annotate({ review_id: rid, reviewer: "乙", root_cause: "电话延迟", metric_verdict: "missed" });
  assert.equal(st.consensus, "missed");
  assert.equal(st.final_verdict, "missed");
  assert.throws(() => app.adjudicate({ review_id: rid, arbiter: "x", final_root_cause: "x", final_verdict: "met" }), expectError(409, /一致|仲裁/));
});

test("机构申诉保留前后结论：成立则翻转，驳回则维持", () => {
  const { app } = tempApp();
  const [id] = seedMonth({ app, perOrigin: 1 });
  const rid = app.openReview({ queue_id: "q", referral_id: id, metric: "docs_ready", by: "qc" });
  app.annotate({ review_id: rid, reviewer: "甲", root_cause: "漏传检查资料", metric_verdict: "missed" });
  app.annotate({ review_id: rid, reviewer: "乙", root_cause: "漏传检查资料", metric_verdict: "missed" });
  const aid = app.fileAppeal({ review_id: rid, origin: "太姥山镇卫生院", justification: "资料已于08:50补传，系统延迟显示", by: "机构" });
  // 申诉成立 → 结论翻转，但 prior_verdict 保留为 missed
  const view = app.resolveAppeal(aid, { upheld: true, decision_note: "核实补传时间早于到院", by: "科主任" });
  assert.equal(view.prior_verdict, "missed");
  assert.equal(view.final_verdict, "met");
  assert.equal(view.status, "upheld");
});

test("资料补正叠加不覆盖：补传后指标改善但历史链可查", () => {
  const { store, app } = tempApp();
  const id = "FD-AMEND-1";
  app.recordJourney(goodJourney({
    referral_id: id,
    documents: [{ type: "转诊单", uploaded_at: "2026-09-18T08:02:00+08:00" }],
  }));
  const before = effectiveJourney(store.replay(), id);
  assert.equal(before.documents.length, 1);
  app.amendDocuments(id, {
    documents: [
      { type: "检查资料", uploaded_at: "2026-09-18T08:50:00+08:00" },
      { type: "用药记录", uploaded_at: "2026-09-18T08:55:00+08:00" },
    ],
    reason: "机构补传",
    by: "qc",
  });
  const after = effectiveJourney(store.replay(), id);
  assert.equal(after.documents.length, 3);
  // 原始单与补正事件都仍在
  const state = store.replay();
  assert.equal(state.journeys.get(id).amendments.length, 1);
});

test("整改闭环：无复测/样本不足/达标率不足/无证据均不得关闭", () => {
  const { app } = tempApp();
  const [id] = seedMonth({ app, perOrigin: 1 });
  const rid = app.openReview({ queue_id: "q", referral_id: id, metric: "handover_wait", by: "qc" });
  app.annotate({ review_id: rid, reviewer: "甲", root_cause: "排班缺口", metric_verdict: "missed" });
  app.annotate({ review_id: rid, reviewer: "乙", root_cause: "排班缺口", metric_verdict: "missed" });
  const aid = app.createAction({
    review_id: rid,
    owner: "李护士长",
    due_date: "2026-11-30",
    intervention: { type: "scheduling", detail: "增设夜间接应岗" },
    retest: { sample_size: 10, target_pass_rate: 0.9 },
    by: "科主任",
  });

  assert.throws(() => app.closeAction(aid, { by: "科主任" }), expectError(409, /无复测/));
  assert.throws(
    () => app.recordRetest(aid, { sample_size: 6, pass_count: 6, period: "2026-11", by: "qc" }),
    expectError(400, /复测样本不足/)
  );
  app.recordRetest(aid, { sample_size: 10, pass_count: 8, period: "2026-11", by: "qc" }); // 80% < 90%
  assert.throws(() => app.closeAction(aid, { by: "科主任" }), expectError(409, /未达目标/));
  app.addEvidence(aid, { kind: "schedule", url: "evidence/night-shift.pdf", note: "夜班表", by: "李护士长" });
  // 达标率仍不足；补一次达标的复测
  app.recordRetest(aid, { sample_size: 12, pass_count: 11, period: "2026-12", by: "qc" }); // 91.7%
  const view = app.closeAction(aid, { by: "科主任" });
  assert.equal(view.status, "closed");
  assert.match(view.closure.basis, /复测12例/);
});

test("排除清单从队列与月报中剔除，撤销后重新纳入", () => {
  const { app } = tempApp();
  const ids = seedMonth({ app, perOrigin: 3 });
  app.addExclusion("EX-1", { referral_id: ids[0], reason: "外院转回不合规单", by: "qc" });
  const q = app.createQueue({ month: "2026-09", ratio: 1, by: "qc" });
  assert.equal(q.cohort_size, 2);
  app.revokeExclusion("EX-1", { reason: "核实为本县病例", by: "qc" });
  const q2 = app.createQueue({ month: "2026-09", ratio: 1, by: "qc" });
  assert.equal(q2.cohort_size, 3);
});

test("月报小样本抑制（独立）", () => {
  const { store, app } = tempApp();
  seedMonth({ app, origins: ["太姥山镇卫生院"], perOrigin: 6 });
  seedMonth({ app, origins: ["嵛山岛卫生院"], perOrigin: 2 });
  const report = buildReport(store.replay(), "2026-09");
  const rankedOrigins = report.ranking.map((r) => r.origin);
  assert.ok(rankedOrigins.includes("太姥山镇卫生院"));
  assert.ok(!rankedOrigins.includes("嵛山岛卫生院"));
  assert.ok(report.suppressed_orgs.some((s) => s.origin === "嵛山岛卫生院"));
  assert.match(report.ranking_note, /不公开排名/);
  // 分维度聚合到位
  assert.equal(report.overall.sample_n, 8);
  assert.ok(report.by_shift.day);
});

test("冻结后重放得到一致报告（指纹与快照一致），且冻结后补传不改变历史月份", () => {
  const { store, app } = tempApp();
  const ids = seedMonth({ app, perOrigin: 6 });
  const frozen = freezeMonth(store, app, "2026-09", { by: "科主任" });
  assert.equal(frozen.head_seq, 6); // 6 条旅程数据事件；冻结事件为其后第 7 条
  // 冻结后补传一份 9 月资料
  app.amendDocuments(ids[0], { documents: [{ type: "用药记录", uploaded_at: "2026-09-18T23:00:00+08:00" }], reason: "迟到补传", by: "x" });

  const replay = replayMonth(store, "2026-09");
  assert.equal(replay.consistent, true);
  assert.equal(replay.fingerprint.frozen, replay.fingerprint.replayed);
  // 重放报告与冻结快照一致
  assert.equal(replay.replayed_report.overall.sample_n, replay.frozen_report.overall.sample_n);
  // 不得重复冻结
  assert.throws(() => freezeMonth(store, app, "2026-09", { by: "x" }), /已冻结/);
});

test("下钻串联去标识事件、审查意见、申诉与整改证据", () => {
  const { app } = tempApp();
  const [id] = seedMonth({ app, perOrigin: 1 });
  const rid = app.openReview({ queue_id: "q", referral_id: id, metric: "handover_wait", by: "qc" });
  app.annotate({ review_id: rid, reviewer: "甲", root_cause: "无人接应", metric_verdict: "missed" });
  app.annotate({ review_id: rid, reviewer: "乙", root_cause: "无人接应", metric_verdict: "missed" });
  const aid = app.createAction({
    review_id: rid, owner: "李护士长", due_date: "2026-11-30",
    intervention: { type: "scheduling" }, retest: { sample_size: 5, target_pass_rate: 0.8 }, by: "qc",
  });
  app.addEvidence(aid, { kind: "schedule", url: "e/x.pdf", note: "排班", by: "李" });

  const d = app.drilldown(id, "handover_wait");
  assert.match(d.case_ref, /^REF-/);
  assert.ok(d.events.some((e) => e.type === "handover"));
  assert.ok(!JSON.stringify(d).includes(id)); // 原始转诊号不下发
  assert.equal(d.reviews[0].action.evidence[0].url, "e/x.pdf");
  assert.equal(d.metric_value.target, 20); // v1 交接 SLA
});

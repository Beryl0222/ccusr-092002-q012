import assert from "node:assert/strict";
import test from "node:test";

import { QualityService } from "../../src/quality/service.js";
import { makeJourney, septemberDataset, octoberDataset } from "../helpers/fixtures.js";

function seededService() {
  const svc = new QualityService(() => "2026-10-01T09:00:00.000Z");
  for (const j of septemberDataset()) svc.ingestJourney(j);
  return svc;
}

test("按来源/风险/班次建立审查队列，抽样结果确定可复现", () => {
  const s1 = seededService();
  const s2 = seededService();
  const q1 = s1.createReviewQueue({ name: "夜班高风险", risk: "high", shift: "night", sampleSize: 2 });
  const q2 = s2.createReviewQueue({ name: "夜班高风险", risk: "high", shift: "night", sampleSize: 2 });
  assert.equal(q1.candidates, 4); // B1,B2,B3,B5
  assert.deepEqual(q1.cases.map((c) => c.referral_id), q2.cases.map((c) => c.referral_id));
  assert.equal(q1.basisHash, q2.basisHash);
  // 分层抽样：每个机构独立配额
  const q3 = s1.createReviewQueue({ name: "按机构分层", perOrigin: true, sampleSize: 1, month: "2026-09" });
  const origins = new Set(q3.cases.map((c) => c.origin));
  assert.equal(origins.size, 3);
});

test("双人标注根因：一致即成立，不一致需第三人裁定，禁止覆盖与自评", () => {
  const svc = seededService();
  const q = svc.createReviewQueue({ name: "Q", shift: "night", sampleSize: 2 });
  const [c1, c2] = q.cases;

  svc.annotateRootCause(c1.caseId, { reviewer: "qc-a", rootCauses: ["基层漏传", "接口缺校验"] });
  let r = svc.annotateRootCause(c1.caseId, { reviewer: "qc-b", rootCauses: ["基层漏传", "接口缺校验"] });
  assert.equal(r.status, "agreed");
  assert.deepEqual(svc.finalRootCauses(c1.caseId), ["基层漏传", "接口缺校验"]);

  // 同一人重复标注被拒绝
  assert.throws(
    () => svc.annotateRootCause(c1.caseId, { reviewer: "qc-a", rootCauses: ["x"] }),
    /禁止覆盖/
  );

  // 分歧 -> 裁定；裁定人不能是原审人
  svc.annotateRootCause(c2.caseId, { reviewer: "qc-a", rootCauses: ["基层漏传"] });
  r = svc.annotateRootCause(c2.caseId, { reviewer: "qc-b", rootCauses: ["夜间无人排班"] });
  assert.equal(r.status, "disagreement");
  assert.throws(() => svc.adjudicate(c2.caseId, { adjudicator: "qc-a", rootCauses: ["x"] }), /裁定人不得/);
  r = svc.adjudicate(c2.caseId, { adjudicator: "qc-lead", rootCauses: ["夜间无人排班", "基层漏传"] });
  assert.equal(r.status, "adjudicated");
  assert.deepEqual(svc.finalRootCauses(c2.caseId), ["基层漏传", "夜间无人排班"]);
});

test("在诊(open)个案只读：标注、补正、申诉均返回 409，且系统不改其路线", () => {
  const svc = new QualityService();
  svc.ingestJourney(makeJourney({ id: "OPEN1", status: "open", offsets: { arrival: 30 } }));
  assert.equal(svc.getJourney("OPEN1").status, "open");
  assert.throws(() => svc.caseConclusion("OPEN1"), /只读/);
  const q = svc.createReviewQueue({ name: "q", sampleSize: 5 });
  assert.equal(q.cases.length, 0, "open 个案不得进入审查队列");
  assert.throws(
    () => svc.submitCorrection("OPEN1", makeJourney({ id: "OPEN1", status: "closed" })),
    /只读/
  );
  assert.throws(
    () => svc.annotateRootCause("Q-001:OPEN1", { reviewer: "a", rootCauses: ["x"] }),
    /审查样本不存在/
  );
});

test("资料补正保留版本并给出前后结论；旧指纹仍在版本历史中", () => {
  const svc = seededService();
  const id = "FD-B1"; // 原本漏资料、无人接应
  const before = svc.caseConclusion(id);
  assert.equal(before.cells.materials_ready.status, "missing");

  const corrected = makeJourney({
    id,
    origin: "店下镇卫生院",
    risk: "high",
    t0: "2026-09-05T21:00:00+08:00",
    offsets: { materials_complete: 50, first_contact: 45, arrival: 30, handoff: 45 },
  });
  const result = svc.submitCorrection(id, corrected, { submittedBy: "店下镇卫生院", note: "补传检查报告" });
  assert.equal(result.correction.changed, true);
  assert.equal(result.correction.before.materials_ready.status, "missing");
  assert.equal(result.correction.after.materials_ready.status, "ok");

  const entry = svc.journeys.get(id);
  assert.equal(entry.versions.length, 2);
  assert.notEqual(entry.versions[0].journey.contentHash, entry.current.contentHash);
});

test("机构申诉记录前后结论；申诉成立加入排除清单后结论改变且可追溯", () => {
  const svc = seededService();
  const id = "FD-B1";
  const beforeHash = svc.caseConclusion(id).hash;
  const appeal = svc.appeal(id, { grounds: "患者当晚自行取消就诊，重复建单", requestedAction: "排除出本月样本" });
  assert.equal(appeal.status, "open");
  assert.equal(appeal.before.hash, beforeHash);

  const closed = svc.respondAppeal(appeal.id, {
    decision: "upheld",
    response: "情况属实，按 duplicate_order 排除",
    addExclusionCode: "duplicate_order",
  });
  assert.equal(closed.status, "closed");
  assert.notEqual(closed.after.hash, closed.before.hash);
  assert.equal(closed.after.cells.materials_ready.status, "missing"); // 个案单元格不变
  assert.equal(closed.after.excluded, true); // 但样本层面已排除
  assert.equal(svc.exclusions.get(id).code, "duplicate_order");
  assert.equal(svc.currentMetrics({ month: "2026-09" }).generatedFrom.excluded, 1);
});

test("口径调整保留两个版本的总体结论", () => {
  const svc = new QualityService(() => "2026-10-31T10:00:00.000Z");
  for (const j of octoberDataset()) svc.ingestJourney(j);
  const change = svc.recordCaliberChange({
    month: "2026-10",
    fromVersion: "qc-rules-2026-09",
    toVersion: "qc-rules-2026-10",
    reason: "夜间陪诊到位后收紧首次联系与交接 SLA",
  });
  assert.equal(change.before.overall.first_contact.breach, 0);
  assert.equal(change.after.overall.first_contact.breach, 6);
  assert.notEqual(change.before.reportHash, change.after.reportHash);
});

test("整改必须有负责人、期限和复测样本；无证据或复测不达标不得关闭", () => {
  const svc = seededService();
  assert.throws(
    () => svc.createAction({ title: "整改", metric: "arrival_handoff", dueAt: "2026-10-20T00:00:00Z", requiredSample: 5 }),
    /负责人/
  );

  const action = svc.createAction({
    title: "店下夜班接应排班整改",
    metric: "arrival_handoff",
    origin: "店下镇卫生院",
    shift: "night",
    owner: "李护士长",
    dueAt: "2026-10-20T00:00:00Z",
    requiredSample: 5,
  });

  // 无证据无复测 -> 禁止关闭
  assert.throws(() => svc.closeAction(action.id), /不满足关闭条件/);

  svc.addEvidence(action.id, { type: "schedule", ref: "SCHED-2026-10-night", note: "夜班新增陪诊岗排班表" });
  assert.throws(() => svc.closeAction(action.id), /复测/);

  // 复测样本不属于目标机构/班次被拒绝
  assert.throws(
    () => svc.submitReaudit(action.id, { sampleReferralIds: ["FD-A1"] }),
    /责任机构/
  );

  // 复测样本不足 -> 仍不能关闭
  svc.submitReaudit(action.id, { sampleReferralIds: ["FD-B1"] });
  assert.throws(() => svc.closeAction(action.id), /复测样本不足/);
});

test("整改复测达标后方可关闭；逾期状态如实记录", () => {
  const svc = seededService();
  // 造 5 例 B 机构夜班、到院 5 分钟内交接的新样本（模拟整改后）
  for (let i = 6; i <= 10; i += 1) {
    svc.ingestJourney(
      makeJourney({
        id: `FD-B${i}`,
        origin: "店下镇卫生院",
        risk: "high",
        t0: `2026-10-0${i - 5}T21:00:00+08:00`,
        offsets: { materials_complete: 20, first_contact: 10, arrival: 30, handoff: 34 },
      })
    );
  }
  const action = svc.createAction({
    title: "店下夜班接应排班整改",
    metric: "arrival_handoff",
    origin: "店下镇卫生院",
    shift: "night",
    owner: "李护士长",
    dueAt: "2026-10-20T00:00:00Z",
    requiredSample: 5,
  });
  svc.addEvidence(action.id, { type: "schedule", ref: "SCHED-2026-10-night", note: "夜班新增陪诊岗" });
  const reaudit = svc.submitReaudit(action.id, { sampleReferralIds: ["FD-B6", "FD-B7", "FD-B8", "FD-B9", "FD-B10"] });
  assert.equal(reaudit.n, 5);
  assert.equal(reaudit.breaches, 0);
  assert.equal(reaudit.failureRate, 0);
  const closed = svc.closeAction(action.id, { closureNote: "复测达标，关闭" });
  assert.equal(closed.status, "closed");
  assert.equal(closed.closure.overdue, false);
});

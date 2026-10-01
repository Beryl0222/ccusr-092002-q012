import assert from "node:assert/strict";
import test from "node:test";

import { computeMetrics, documentsCompleteAt } from "../../src/quality/model.js";
import { getRule, ruleAt, shiftOf } from "../../src/quality/rules.js";
import { goodJourney, highRiskEscalated } from "./helpers.js";

test("规则版本按转诊创建时间选择，v2 于 2026-10-01 生效", () => {
  assert.equal(ruleAt("2026-09-30T23:59:00+08:00").version, "v1");
  assert.equal(ruleAt("2026-10-01T00:00:00+08:00").version, "v2");
  assert.deepEqual(getRule("v1").required_documents, ["转诊单", "检查资料", "用药记录"]);
  assert.ok(getRule("v2").required_documents.includes("风险评估表"));
});

test("六个时间指标在全程达标旅程上均达标并带单位量值", () => {
  const m = computeMetrics(goodJourney()).metrics;
  assert.equal(m.first_contact.met, true);
  assert.equal(m.first_contact.value, 10);
  assert.equal(m.handover_wait.value, 10);
  assert.equal(m.docs_ready.met, true);
  assert.equal(m.downgrade_confirm.met, true);
  assert.equal(m.followup_completion.met, true);
  // 低风险无升级事件 → 不适用而非缺失
  assert.equal(m.escalation_response.applicable, false);
});

test("资料齐备：缺资料记为未达标并列出缺项；v2 额外要求风险评估表", () => {
  const v1 = computeMetrics(goodJourney({ documents: [{ type: "转诊单", uploaded_at: "2026-09-18T08:02:00+08:00" }] }));
  assert.equal(v1.metrics.docs_ready.met, false);
  assert.match(v1.metrics.docs_ready.note, /检查资料/);

  const oct = goodJourney({
    created_at: "2026-10-02T08:00:00+08:00",
    arrival_window: ["2026-10-02T09:00:00+08:00", "2026-10-02T10:00:00+08:00"],
  });
  assert.equal(computeMetrics(oct).metrics.docs_ready.met, false); // v2 缺风险评估表
  const octComplete = goodJourney({
    created_at: "2026-10-02T08:00:00+08:00",
    arrival_window: ["2026-10-02T09:00:00+08:00", "2026-10-02T10:00:00+08:00"],
    documents: [
      { type: "转诊单", uploaded_at: "2026-10-02T08:02:00+08:00" },
      { type: "检查资料", uploaded_at: "2026-10-02T08:05:00+08:00" },
      { type: "用药记录", uploaded_at: "2026-10-02T08:10:00+08:00" },
      { type: "风险评估表", uploaded_at: "2026-10-02T08:12:00+08:00" },
    ],
  });
  assert.equal(computeMetrics(octComplete).rule_version, "v2");
  assert.equal(computeMetrics(octComplete).metrics.docs_ready.met, true);
});

test("资料在到院窗口起点后才齐备 → 未达标（识别反复漏传/迟传）", () => {
  const late = goodJourney({
    documents: [
      { type: "转诊单", uploaded_at: "2026-09-18T08:02:00+08:00" },
      { type: "检查资料", uploaded_at: "2026-09-18T08:05:00+08:00" },
      { type: "用药记录", uploaded_at: "2026-09-18T09:30:00+08:00" }, // 晚于 09:00 窗口起点
    ],
  });
  assert.equal(computeMetrics(late).metrics.docs_ready.met, false);
});

test("危急升级：高风险应升级而未发起记未达标；响应超 SLA 未达标", () => {
  const noEsc = computeMetrics(goodJourney({ risk: "critical" }));
  assert.equal(noEsc.metrics.escalation_response.met, false);
  assert.match(noEsc.metrics.escalation_response.note, /应升级而未发起/);

  const slow = highRiskEscalated({
    escalation: { requested_at: "2026-09-18T08:20:00+08:00", rerouted_at: "2026-09-18T09:10:00+08:00" },
  });
  // v1 SLA 30 分钟，耗时 50 分钟
  assert.equal(computeMetrics(slow).metrics.escalation_response.value, 50);
  assert.equal(computeMetrics(slow).metrics.escalation_response.met, false);

  // 同一 50 分钟在 v2（SLA 15）依然未达标；20 分钟在 v1 达标、v2 不达标
  const twenty = highRiskEscalated({
    created_at: "2026-10-02T08:00:00+08:00",
    escalation: { requested_at: "2026-10-02T08:20:00+08:00", rerouted_at: "2026-10-02T08:40:00+08:00" },
  });
  assert.equal(computeMetrics(twenty).rule_version, "v2");
  assert.equal(computeMetrics(twenty).metrics.escalation_response.met, false);
});

test("到院交接等待暴露无人接应：到院未交接记未达标", () => {
  const m = computeMetrics(goodJourney({ handover_at: null }));
  assert.equal(m.metrics.handover_wait.met, false);
  assert.match(m.metrics.handover_wait.note, /未完成交接/);
});

test("下转与随访窗口按口径判定，v2 窗口更严", () => {
  const longFollow = goodJourney({
    closed_at: "2026-09-26T10:00:00+08:00",
    followup_completed_at: "2026-10-15T10:00:00+08:00", // 19 天，v1 窗口 14 天
  });
  assert.equal(computeMetrics(longFollow).metrics.followup_completion.met, false);

  const eightDays = goodJourney({
    created_at: "2026-10-02T08:00:00+08:00",
    closed_at: "2026-10-05T10:00:00+08:00",
    followup_completed_at: "2026-10-13T10:00:00+08:00", // 8 天，v2 窗口 7 天
  });
  assert.equal(computeMetrics(eightDays).metrics.followup_completion.met, false);
});

test("班次按东八区到院时刻划分，可定位易脱班时段", () => {
  assert.equal(shiftOf("2026-09-18T09:10:00+08:00"), "day");
  assert.equal(shiftOf("2026-09-18T16:30:00+08:00"), "evening");
  assert.equal(shiftOf("2026-09-18T02:00:00+08:00"), "night");
});

test("可显式指定规则版本重算（历史重放口径固定）", () => {
  const j = goodJourney();
  const asV2 = computeMetrics(j, { ruleVersion: "v2" });
  assert.equal(asV2.rule_version, "v2");
  assert.equal(asV2.metrics.docs_ready.met, false); // v1 下达标，v2 因缺风险评估表不达标
});

test("documentsCompleteAt 同类资料取最晚上传时刻", () => {
  const rule = getRule("v1");
  const r = documentsCompleteAt(
    goodJourney({
      documents: [
        { type: "转诊单", uploaded_at: "2026-09-18T08:02:00+08:00" },
        { type: "检查资料", uploaded_at: "2026-09-18T08:05:00+08:00" },
        { type: "用药记录", uploaded_at: "2026-09-18T08:10:00+08:00" },
        { type: "用药记录", uploaded_at: "2026-09-18T08:30:00+08:00" },
      ],
    }),
    rule
  );
  assert.equal(r.complete, true);
  assert.equal(new Date(r.completeAt).getMinutes(), 30);
});

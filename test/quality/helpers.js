// 测试夹具：构造在各指标上可控的脱敏旅程。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createQualityApp } from "../../src/quality/quality.js";
import { createStore } from "../../src/quality/store.js";

export function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "refq-"));
  return createStore({ dir, file: "events.jsonl" });
}

export function tempApp(now) {
  const store = tempStore();
  const app = createQualityApp(store, now ? { now: () => new Date(now) } : {});
  return { store, app };
}

// 生成一条“全程达标”的 9 月（v1）已关闭旅程，可逐项覆盖时间点制造异常。
let seq = 0;
export function goodJourney(overrides = {}) {
  seq += 1;
  const n = String(100 + seq);
  return {
    referral_id: `FD-202609${n.slice(-2)}-${n}`,
    origin: "太姥山镇卫生院",
    risk: "low",
    status: "closed",
    created_at: "2026-09-18T08:00:00+08:00",
    arrival_window: ["2026-09-18T09:00:00+08:00", "2026-09-18T10:00:00+08:00"],
    documents: [
      { type: "转诊单", uploaded_at: "2026-09-18T08:02:00+08:00" },
      { type: "检查资料", uploaded_at: "2026-09-18T08:05:00+08:00" },
      { type: "用药记录", uploaded_at: "2026-09-18T08:10:00+08:00" },
    ],
    first_contact_at: "2026-09-18T08:10:00+08:00",
    arrived_at: "2026-09-18T09:10:00+08:00",
    handover_at: "2026-09-18T09:20:00+08:00",
    downgrade_sent_at: "2026-09-25T09:00:00+08:00",
    downgrade_confirmed_at: "2026-09-26T09:00:00+08:00",
    closed_at: "2026-09-26T10:00:00+08:00",
    followup_completed_at: "2026-09-30T10:00:00+08:00",
    ...overrides,
  };
}

export function highRiskEscalated(overrides = {}) {
  return goodJourney({
    risk: "high",
    escalation: {
      requested_at: "2026-09-18T08:20:00+08:00",
      rerouted_at: "2026-09-18T08:35:00+08:00",
      channel: "胸痛中心绿色通道",
    },
    ...overrides,
  });
}

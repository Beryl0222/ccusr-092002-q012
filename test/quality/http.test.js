import assert from "node:assert/strict";
import test from "node:test";

import { createQualityServer } from "../../src/quality/service.js";
import { tempApp } from "./helpers.js";

async function withServer(fn) {
  const { store, app } = tempApp();
  const server = createQualityServer({ store, app });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (path, opts = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: opts.method ?? "GET",
      headers: opts.body ? { "content-type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  try {
    return await fn({ call, app });
  } finally {
    server.close();
  }
}

const closedJourney = {
  referral_id: "FD-HTTP-1",
  origin: "太姥山镇卫生院",
  risk: "high",
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
  escalation: { requested_at: "2026-09-18T08:20:00+08:00", rerouted_at: "2026-09-18T08:30:00+08:00", channel: "绿通" },
  closed_at: "2026-09-26T10:00:00+08:00",
  followup_completed_at: "2026-09-30T10:00:00+08:00",
};

test("健康检查返回质控服务身份", () =>
  withServer(async ({ call }) => {
    const r = await call("/health");
    assert.equal(r.status, 200);
    assert.equal(r.body.service, "referral-quality-improvement");
    assert.equal(r.body.scope, "quality-control");
  }));

test("端到端 HTTP：录入→月报→队列→双人标注→整改→冻结→重放→下钻", () =>
  withServer(async ({ call }) => {
    let r = await call("/journeys", { method: "POST", body: closedJourney });
    assert.equal(r.status, 201);

    r = await call("/report?month=2026-09");
    assert.equal(r.status, 200);
    assert.equal(r.body.overall.sample_n, 1);

    r = await call("/queues", { method: "POST", body: { month: "2026-09", ratio: 1, by: "qc" } });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.sampled, ["FD-HTTP-1"]);

    r = await call("/reviews", { method: "POST", body: { queue_id: r.body.queue_id, referral_id: "FD-HTTP-1", metric: "handover_wait", by: "qc" } });
    const rid = r.body.review_id;
    assert.equal(r.status, 201);

    await call("/annotations", { method: "POST", body: { review_id: rid, reviewer: "甲", root_cause: "接应延迟", metric_verdict: "missed" } });
    r = await call("/annotations", { method: "POST", body: { review_id: rid, reviewer: "乙", root_cause: "接应延迟", metric_verdict: "missed" } });
    assert.equal(r.body.final_verdict, "missed");

    r = await call("/actions", {
      method: "POST",
      body: { review_id: rid, owner: "李护士长", due_date: "2026-11-30", intervention: { type: "scheduling" }, retest: { sample_size: 5, target_pass_rate: 0.8 }, by: "qc" },
    });
    const aid = r.body.action_id;
    await call(`/actions/${aid}/evidence`, { method: "POST", body: { kind: "schedule", url: "e.pdf", by: "李" } });
    // 无复测不得关闭
    r = await call(`/actions/${aid}/close`, { method: "POST", body: { by: "qc" } });
    assert.equal(r.status, 409);
    await call(`/actions/${aid}/retests`, { method: "POST", body: { sample_size: 5, pass_count: 5, period: "2026-11", by: "qc" } });
    r = await call(`/actions/${aid}/close`, { method: "POST", body: { by: "qc" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "closed");

    r = await call("/months/2026-09/freeze", { method: "POST", body: { by: "科主任" } });
    assert.equal(r.status, 201);
    r = await call("/months/2026-09/replay");
    assert.equal(r.status, 200);
    assert.equal(r.body.consistent, true);

    // 下钻下发假名而非原始转诊号
    r = await call("/drilldown/FD-HTTP-1/handover_wait");
    assert.equal(r.status, 200);
    assert.ok(!JSON.stringify(r.body).includes("FD-HTTP-1"));
    assert.match(r.body.case_ref, /^REF-/);
    assert.equal(r.body.reviews[0].action.status, "closed");
  }));

test("在诊个案经 HTTP 建立审查返回 409", () =>
  withServer(async ({ call }) => {
    await call("/journeys", { method: "POST", body: { ...closedJourney, referral_id: "FD-ACT", status: "active" } });
    const r = await call("/reviews", { method: "POST", body: { queue_id: "q", referral_id: "FD-ACT", metric: "handover_wait", by: "qc" } });
    assert.equal(r.status, 409);
  }));

test("不存在任何改道/临床写入端点（404）", () =>
  withServer(async ({ call }) => {
    const r = await call("/reroute", { method: "POST", body: { referral_id: "x" } });
    assert.equal(r.status, 404);
  }));

test("非法 JSON 返回 400", async () => {
  const { store, app } = tempApp();
  const server = createQualityServer({ store, app });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/journeys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

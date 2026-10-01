import assert from "node:assert/strict";
import test from "node:test";

import { createQualityServer, qualityServiceId } from "../../src/quality/http.js";

async function withServer(run) {
  const server = createQualityServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function call(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const closedJourney = (id, t0 = "2026-09-10T08:00:00+08:00") => ({
  referral_id: id,
  origin: "太姥山镇卫生院",
  risk: "high",
  status: "closed",
  events: [
    { type: "order_created", at: t0 },
    { type: "materials_complete", at: "2026-09-10T08:30:00+08:00", actor: "基层联络员" },
    { type: "first_contact", at: "2026-09-10T08:10:00+08:00", actor: "转诊管家" },
  ],
});

test("健康检查表明质控边界", async () => {
  await withServer(async (base) => {
    const { status, json } = await call(base, "GET", "/health");
    assert.equal(status, 200);
    assert.equal(json.service, qualityServiceId);
    assert.match(json.boundary, /不干预临床路线/);
  });
});

test("摄取脱敏旅程 → 建队列 → 双人标注全链路", async () => {
  await withServer(async (base) => {
    for (let i = 1; i <= 3; i += 1) {
      const r = await call(base, "POST", "/v1/journeys", closedJourney(`FD-H${i}`));
      assert.equal(r.status, 202);
    }
    const q = await call(base, "POST", "/v1/review-queues", { name: "HTTP 队列", sampleSize: 2 });
    assert.equal(q.status, 201);
    assert.equal(q.json.cases.length, 2);

    const caseId = q.json.cases[0].caseId;
    const a1 = await call(base, "POST", `/v1/reviews/${encodeURIComponent(caseId)}/annotations`, {
      reviewer: "qc-a",
      rootCauses: ["接口缺校验"],
    });
    const a2 = await call(base, "POST", `/v1/reviews/${encodeURIComponent(caseId)}/annotations`, {
      reviewer: "qc-b",
      rootCauses: ["接口缺校验"],
    });
    assert.equal(a1.json.status, "pending_second");
    assert.equal(a2.json.status, "agreed");
  });
});

test("在诊(open)个案：可同步但任何质控写操作返回 409", async () => {
  await withServer(async (base) => {
    const open = closedJourney("FD-OPEN");
    open.status = "open";
    open.events.push({ type: "arrival", at: "2026-09-10T09:00:00+08:00" });
    assert.equal((await call(base, "POST", "/v1/journeys", open)).status, 202);

    const conclusion = await call(base, "GET", "/v1/journeys/FD-OPEN/conclusion");
    assert.equal(conclusion.status, 409);
    assert.equal(conclusion.json.code, "OPEN_READONLY");

    const correction = await call(base, "POST", "/v1/journeys/FD-OPEN/corrections", { journey: closedJourney("FD-OPEN") });
    assert.equal(correction.status, 409);

    // 不进入审查队列
    const q = await call(base, "POST", "/v1/review-queues", { name: "q", sampleSize: 10 });
    assert.equal(q.json.candidates, 0);
  });
});

test("含直接标识字段的数据在入口 400 拒绝", async () => {
  await withServer(async (base) => {
    const bad = closedJourney("FD-PII");
    bad.events[1] = { ...bad.events[1], phone: "13800000000" };
    const r = await call(base, "POST", "/v1/journeys", bad);
    assert.equal(r.status, 400);
    assert.match(r.json.error, /必须脱敏/);
  });
});

test("整改无复测证据时关闭返回 422，消息列出具体缺失", async () => {
  await withServer(async (base) => {
    await call(base, "POST", "/v1/journeys", closedJourney("FD-H9"));
    const action = await call(base, "POST", "/v1/actions", {
      title: "接口整改",
      metric: "materials_ready",
      origin: "太姥山镇卫生院",
      owner: "王工",
      dueAt: "2026-10-20T00:00:00Z",
      requiredSample: 5,
    });
    assert.equal(action.status, 201);
    const close = await call(base, "POST", `/v1/actions/${action.json.id}/close`, {});
    assert.equal(close.status, 422);
    assert.ok(close.json.details.failures.includes("缺少整改证据"));
    assert.ok(close.json.details.failures.some((f) => f.includes("复测")));
  });
});

test("月报发布后重放一致；未知路由 404", async () => {
  await withServer(async (base) => {
    await call(base, "POST", "/v1/journeys", closedJourney("FD-M1"));
    const pub = await call(base, "POST", "/v1/reports/2026-09/publish", { ruleVersion: "qc-rules-2026-09" });
    assert.equal(pub.status, 201);
    assert.ok(pub.json.reportHash);

    const replay = await call(base, "POST", "/v1/reports/2026-09/replay");
    assert.equal(replay.status, 200);
    assert.equal(replay.json.consistent, true);

    assert.equal((await call(base, "GET", "/nope")).status, 404);
  });
});

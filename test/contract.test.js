import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { healthPayload, serviceId } from "../src/service.js";
import { healthPayload as qualityHealth, qualityServiceId } from "../src/quality/http.js";

test("服务身份稳定", () => {
  assert.equal(healthPayload().service, serviceId);
});

test("领域样例与服务一致", async () => {
  const raw = await readFile(new URL("../contracts/referral_order.json", import.meta.url), "utf8");
  const data = JSON.parse(raw);
  assert.equal(data.service, serviceId);
  assert.ok(data.sample);
});

test("质控旅程样例与质量服务一致且脱敏", async () => {
  const raw = await readFile(new URL("../contracts/quality_journey.json", import.meta.url), "utf8");
  const data = JSON.parse(raw);
  assert.equal(data.service, qualityServiceId);
  assert.equal(qualityHealth().service, qualityServiceId);
  assert.equal(data.sample.status, "closed");
  assert.ok(Array.isArray(data.sample.events) && data.sample.events.length > 0);
  const serialized = JSON.stringify(data.sample);
  for (const forbidden of ["name", "id_card", "phone", "mobile", "address"]) {
    assert.ok(!serialized.includes(`"${forbidden}"`), `样例不得含 ${forbidden}`);
  }
});

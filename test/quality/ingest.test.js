import assert from "node:assert/strict";
import test from "node:test";

import { validateJourney, validateReferral } from "../../src/quality/ingest.js";
import { makeJourney } from "../helpers/fixtures.js";

test("接收合规脱敏旅程并生成稳定内容指纹", () => {
  const j1 = validateJourney(makeJourney({ id: "X1", offsets: { first_contact: 5 } }));
  const j2 = validateJourney(makeJourney({ id: "X1", offsets: { first_contact: 5 } }));
  assert.equal(j1.contentHash, j2.contentHash);
  const j3 = validateJourney(makeJourney({ id: "X1", offsets: { first_contact: 6 } }));
  assert.notEqual(j1.contentHash, j3.contentHash, "事件时间变化应改变指纹");
});

test("含直接标识字段的转诊单在入口被拒绝", () => {
  for (const forbidden of [
    { name: "张三" },
    { id_card: "352203..." },
    { patient: { phone: "13800000000" } },
  ]) {
    assert.throws(
      () => validateReferral({ referral_id: "X", origin: "O", ...forbidden }),
      /必须脱敏/,
      JSON.stringify(forbidden)
    );
  }
  assert.throws(
    () => validateJourney({ ...makeJourney({ id: "X" }), inpatient_no: "Z001" }),
    /必须脱敏/
  );
  assert.throws(
    () => validateJourney({ ...makeJourney({ id: "X" }), events: [
      ...makeJourney({ id: "X" }).events,
      { type: "handoff", at: "2026-09-10T09:00:00+08:00", actor: "护士", note: "x" },
      { type: "handoff", at: "2026-09-10T09:00:00+08:00", actor: "护士", bed_no: "12" },
    ] }),
    /必须脱敏/
  );
});

test("交接/联系类事件缺少 actor 被拒绝（必须可追责）", () => {
  const j = makeJourney({ id: "X2", offsets: { handoff: 60 } });
  delete j.events.find((e) => e.type === "handoff").actor;
  assert.throws(() => validateJourney(j), /actor/);
});

test("缺少 order_created 锚点、未知事件类型、重复事件均被拒绝", () => {
  const noAnchor = makeJourney({ id: "X3" });
  noAnchor.events = noAnchor.events.filter((e) => e.type !== "order_created");
  noAnchor.events.push({ type: "arrival", at: "2026-09-10T09:00:00+08:00" });
  assert.throws(() => validateJourney(noAnchor), /order_created/);

  const badType = makeJourney({ id: "X4" });
  badType.events.push({ type: "teleported", at: badType.events[0].at });
  assert.throws(() => validateJourney(badType), /未知事件类型/);

  const dup = makeJourney({ id: "X5" });
  dup.events.push({ ...dup.events[0] });
  assert.throws(() => validateJourney(dup), /重复事件/);
});

test("open 与 closed 状态合法，其余状态非法", () => {
  assert.equal(validateJourney(makeJourney({ id: "X6", status: "open" })).status, "open");
  assert.equal(validateJourney(makeJourney({ id: "X7", status: "closed" })).status, "closed");
  assert.throws(() => validateJourney(makeJourney({ id: "X8", status: "discharged" })), /closed\/open/);
});

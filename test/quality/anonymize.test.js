import assert from "node:assert/strict";
import test from "node:test";

import { deidentifyObject, deidentifyTimeline, pseudonymizeId } from "../../src/quality/anonymize.js";
import { goodJourney } from "./helpers.js";

test("去标识移除患者身份与病情文本，转诊号变为稳定假名", () => {
  const out = deidentifyObject({
    referral_id: "FD-1",
    patient_name: "张三",
    patient_id: "352203xxxx",
    phone: "13800000000",
    reason: "胸闷待查",
    origin: "太姥山镇卫生院",
  });
  assert.equal(out.patient_name, undefined);
  assert.equal(out.patient_id, undefined);
  assert.equal(out.phone, undefined);
  assert.equal(out.reason, undefined);
  assert.equal(out.has_reason, true);
  assert.equal(out.origin, "太姥山镇卫生院");
  assert.match(out.case_ref, /^REF-[0-9a-f]{12}$/);
  // 相同输入+盐 → 相同假名（可跨报告关联），不同盐 → 不同假名
  assert.equal(pseudonymizeId("FD-1", "s"), pseudonymizeId("FD-1", "s"));
  assert.notEqual(pseudonymizeId("FD-1", "s"), pseudonymizeId("FD-1", "t"));
});

test("时间轴仅含事件类型与时间，不含病情自由文本", () => {
  const tl = deidentifyTimeline(goodJourney());
  assert.ok(tl.every((e) => e.type && e.at));
  assert.ok(tl.some((e) => e.type === "handover"));
  const json = JSON.stringify(tl);
  assert.doesNotMatch(json, /胸闷|转诊单$/); // document 类型是枚举，允许类型名
});

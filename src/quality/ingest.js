// 脱敏转诊单与已关闭旅程的接收与校验。
// 本系统只接收去标识数据；在诊个案(open)只读，且任何写操作都被服务层拒绝。
import { ValidationError } from "./errors.js";
import { hashOf, parseTs } from "./time.js";

const RISK_LEVELS = ["low", "medium", "high", "critical", "unknown"];
const STATUSES = ["closed", "open"];

// 任何疑似直接标识字段都拒绝，从入口阻断 PII。
const FORBIDDEN_KEYS = [
  "name",
  "patient_name",
  "id_card",
  "idcard",
  "phone",
  "mobile",
  "address",
  "bed_no",
  "inpatient_no",
  "insurance_no",
];

const EVENT_DEFS = {
  order_created: { terminal: false, requiresActor: false },
  materials_complete: { terminal: false, requiresActor: true },
  first_contact: { terminal: false, requiresActor: true },
  arrival: { terminal: false, requiresActor: false },
  handoff: { terminal: false, requiresActor: true },
  escalation: { terminal: false, requiresActor: true },
  rerouted: { terminal: false, requiresActor: true },
  down_transfer: { terminal: false, requiresActor: true },
  down_confirmed: { terminal: false, requiresActor: true },
  followup_complete: { terminal: false, requiresActor: true },
  materials_requested: { terminal: false, requiresActor: true },
};

function assertNoForbidden(obj, path = "$") {
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => assertNoForbidden(item, `${path}[${i}]`));
    return;
  }
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) {
      throw new ValidationError("转诊单必须脱敏，检测到直接标识字段", { field: `${path}.${key}` });
    }
    assertNoForbidden(obj[key], `${path}.${key}`);
  }
}

function requireString(obj, key, ctx) {
  if (typeof obj[key] !== "string" || obj[key].trim() === "") {
    throw new ValidationError(`${ctx}缺少必填字段: ${key}`);
  }
  return obj[key];
}

export function validateReferral(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("转诊单必须为对象");
  }
  assertNoForbidden(input);
  const referralId = requireString(input, "referral_id", "转诊单");
  const origin = requireString(input, "origin", "转诊单");
  if (typeof input.risk === "string" && !RISK_LEVELS.includes(input.risk)) {
    throw new ValidationError(`未知风险层级: ${input.risk}`, { field: "risk" });
  }
  if (input.arrival_window) {
    if (
      !Array.isArray(input.arrival_window) ||
      input.arrival_window.length !== 2 ||
      parseTs(input.arrival_window[0], "arrival_window[0]") >
        parseTs(input.arrival_window[1], "arrival_window[1]")
    ) {
      throw new ValidationError("arrival_window 必须为按时间升序的两个 ISO 时间");
    }
  }
  return true;
}

export function validateJourney(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("旅程必须为对象");
  }
  assertNoForbidden(input);
  const ctx = `旅程 ${input.referral_id ?? ""}`;
  const referralId = requireString(input, "referral_id", ctx);
  const origin = requireString(input, "origin", ctx);
  const status = requireString(input, "status", ctx);
  if (!STATUSES.includes(status)) {
    throw new ValidationError(`旅程状态必须为 closed/open: ${status}`);
  }
  const risk = typeof input.risk === "string" ? input.risk : "unknown";
  if (!RISK_LEVELS.includes(risk)) {
    throw new ValidationError(`未知风险层级: ${risk}`);
  }
  if (!Array.isArray(input.events) || input.events.length === 0) {
    throw new ValidationError(`${ctx} 至少包含一个事件`);
  }

  const seen = new Set();
  const events = input.events.map((raw, idx) => {
    if (raw === null || typeof raw !== "object") {
      throw new ValidationError(`${ctx} 事件[${idx}] 必须为对象`);
    }
    const type = requireString(raw, "type", `${ctx} 事件[${idx}]`);
    if (!EVENT_DEFS[type]) {
      throw new ValidationError(`${ctx} 未知事件类型: ${type}`);
    }
    const at = parseTs(raw.at, `${ctx} 事件[${idx}].at`);
    const actor = typeof raw.actor === "string" ? raw.actor : null;
    if (EVENT_DEFS[type].requiresActor && !actor) {
      throw new ValidationError(`${ctx} 事件[${idx}](${type}) 缺少 actor（交接/联系类事件必须可追责）`);
    }
    const code = `${type}@${at}`;
    if (seen.has(code)) {
      throw new ValidationError(`${ctx} 存在重复事件: ${type}@${raw.at}`);
    }
    seen.add(code);
    return { type, at, atIso: raw.at, actor, note: typeof raw.note === "string" ? raw.note : null };
  });

  events.sort((a, b) => a.at - b.at || a.type.localeCompare(b.type));
  for (let i = 1; i < events.length; i += 1) {
    if (events[i].at < events[0].at) {
      throw new ValidationError(`${ctx} 事件时间早于首个事件`);
    }
  }

  const firstAt = events[0].at;
  if (!events.some((e) => e.type === "order_created")) {
    throw new ValidationError(`${ctx} 缺少 order_created 锚点事件`);
  }

  const arrivalWindow = Array.isArray(input.arrival_window)
    ? input.arrival_window.map((v) => parseTs(v, "arrival_window"))
    : null;

  const journey = {
    referral_id: referralId,
    origin,
    risk,
    status,
    reason: typeof input.reason === "string" ? input.reason : null,
    arrival_window: arrivalWindow,
    events,
    // 内容指纹：事件序列一旦补正，指纹变化，月报冻结的是「当时那一版」
    contentHash: hashOf({
      referral_id: referralId,
      origin,
      risk,
      status,
      arrival_window: arrivalWindow,
      events: events.map((e) => ({ t: e.type, at: e.atIso, a: e.actor })),
    }),
    receivedAt: firstAt,
  };
  return journey;
}

export const EVENT_TYPES = Object.keys(EVENT_DEFS);

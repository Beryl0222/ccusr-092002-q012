import { createHash } from "node:crypto";

// 去标识：供下钻与事件流查看。保留机构、时间结构与指标所需字段，
// 去除患者标识与自由文本病情，转诊号替换为不可逆稳定假名。

export function pseudonymizeId(referralId, salt = "") {
  const digest = createHash("sha256").update(`${salt}:${referralId}`).digest("hex");
  return `REF-${digest.slice(0, 12)}`;
}

const STRIPPED_KEYS = new Set([
  "patient_name",
  "patient_id",
  "id_card",
  "phone",
  "mobile",
  "contact_name",
  "contact_phone",
  "address",
  "birth_date",
]);

export function deidentifyObject(value, salt = "") {
  if (Array.isArray(value)) return value.map((v) => deidentifyObject(v, salt));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (STRIPPED_KEYS.has(key.toLowerCase())) continue;
      if (key === "reason") {
        // 自由文本病情不带出质控视图，仅保留是否有主诉
        out.has_reason = Boolean(v);
        continue;
      }
      if (key === "referral_id" && typeof v === "string") {
        out.case_ref = pseudonymizeId(v, salt);
        continue;
      }
      out[key] = deidentifyObject(v, salt);
    }
    return out;
  }
  return value;
}

// 从旅程生成仅含时间点与类型的去标识事件序列（不含病情文本）
export function deidentifyTimeline(journey, salt = "") {
  const ev = [];
  const push = (type, at, extra = {}) => {
    if (at) ev.push({ type, at: new Date(at).toISOString(), ...extra });
  };
  push("created", journey.created_at);
  for (const d of journey.documents ?? []) {
    push("document_uploaded", d.uploaded_at, { document: d.type });
  }
  push("first_contact", journey.first_contact_at);
  push("arrived", journey.arrived_at);
  push("handover", journey.handover_at);
  push("escalation_requested", journey.escalation?.requested_at);
  push("rerouted", journey.escalation?.rerouted_at, {
    to: journey.escalation?.channel,
  });
  push("downgrade_sent", journey.downgrade_sent_at);
  push("downgrade_confirmed", journey.downgrade_confirmed_at);
  push("closed", journey.closed_at);
  push("followup_completed", journey.followup_completed_at);
  return ev
    .filter((e) => e.at)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((e, i) => ({ seq: i, ...e }));
}

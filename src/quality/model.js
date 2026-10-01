// 指标引擎：把脱敏转诊单与已关闭旅程，按指定规则版本折算为时间指标。
// 本模块只读，绝不产出“改道/变更路线”指令。

import {
  ESCALATION_REQUIRED_RISKS,
  METRIC_KEYS,
  getRule,
  ruleAt,
  shiftOf,
} from "./rules.js";

const MIN = 60_000;

function minutes(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / MIN);
}
function hours(a, b) {
  return (Date.parse(b) - Date.parse(a)) / (60 * MIN);
}
function days(a, b) {
  return (Date.parse(b) - Date.parse(a)) / (24 * 60 * MIN);
}

// 旅程结构（见 contracts/referral_quality_journey.json）：
// { referral_id, origin, risk, created_at, arrival_window:[start,end],
//   documents:[{type,uploaded_at}], first_contact_at, arrived_at, handover_at,
//   escalation:{requested_at, rerouted_at, channel},
//   downgrade_sent_at, downgrade_confirmed_at, closed_at, followup_completed_at,
//   status: "closed"|"active" }

export function documentsCompleteAt(journey, rule) {
  const byType = new Map();
  for (const d of journey.documents ?? []) {
    const prev = byType.get(d.type);
    if (!prev || Date.parse(d.uploaded_at) > Date.parse(prev)) {
      byType.set(d.type, d.uploaded_at);
    }
  }
  let completeAt = journey.created_at;
  for (const required of rule.required_documents) {
    const at = byType.get(required);
    if (!at) {
      return { complete: false, missing: rule.required_documents.filter((t) => !byType.has(t)) };
    }
    if (Date.parse(at) > Date.parse(completeAt)) completeAt = at;
  }
  // 齐备时刻为“最后一份必备资料”的上传时刻
  return { complete: true, completeAt, missing: [] };
}

function record(value, target, met, note) {
  return { value, target, met, ...(note ? { note } : {}) };
}

// 计算单个旅程的全部指标。opts.ruleVersion 可显式指定（重放用），
// 否则按转诊创建时间选当时生效的版本。
export function computeMetrics(journey, opts = {}) {
  if (!journey || !journey.referral_id) throw new Error("旅程缺少 referral_id");
  const rule = opts.ruleVersion ? getRule(opts.ruleVersion) : ruleAt(journey.created_at);

  const metrics = {};

  // 1) 资料齐备
  const docs = documentsCompleteAt(journey, rule);
  if (!docs.complete) {
    metrics.docs_ready = record(null, "by_arrival", false, `缺失资料: ${docs.missing.join("、")}`);
  } else {
    const arrivalStart = journey.arrival_window?.[0];
    const readyBeforeArrival = arrivalStart
      ? Date.parse(docs.completeAt) <= Date.parse(arrivalStart)
      : true;
    metrics.docs_ready = record(
      minutes(journey.created_at, docs.completeAt),
      "by_arrival",
      readyBeforeArrival,
      arrivalStart ? undefined : "无到院窗口，仅统计时长"
    );
  }

  // 2) 首次联系
  metrics.first_contact = journey.first_contact_at
    ? record(
        minutes(journey.created_at, journey.first_contact_at),
        rule.sla.first_contact_minutes,
        minutes(journey.created_at, journey.first_contact_at) <= rule.sla.first_contact_minutes
      )
    : record(null, rule.sla.first_contact_minutes, false, "未记录首次联系");

  // 3) 到院交接等待
  if (journey.arrived_at && journey.handover_at) {
    const wait = minutes(journey.arrived_at, journey.handover_at);
    metrics.handover_wait = record(wait, rule.sla.handover_wait_minutes, wait <= rule.sla.handover_wait_minutes);
  } else if (journey.arrived_at) {
    metrics.handover_wait = record(null, rule.sla.handover_wait_minutes, false, "到院后未完成交接");
  } else {
    metrics.handover_wait = { value: null, target: rule.sla.handover_wait_minutes, applicable: false, note: "未到院" };
  }

  // 4) 危急升级响应（高风险/危重才适用；升级是否真缩短等待由此显形）
  const esc = journey.escalation ?? {};
  const escalationRequired = ESCALATION_REQUIRED_RISKS.includes(journey.risk);
  if (esc.requested_at && esc.rerouted_at) {
    const resp = minutes(esc.requested_at, esc.rerouted_at);
    metrics.escalation_response = record(
      resp,
      rule.sla.escalation_response_minutes,
      resp <= rule.sla.escalation_response_minutes
    );
  } else if (esc.requested_at) {
    metrics.escalation_response = record(null, rule.sla.escalation_response_minutes, false, "升级后未记录改道启动");
  } else if (escalationRequired) {
    metrics.escalation_response = record(null, rule.sla.escalation_response_minutes, false, "应升级而未发起");
  } else {
    metrics.escalation_response = {
      value: null,
      target: rule.sla.escalation_response_minutes,
      applicable: false,
      note: "风险层级无需升级",
    };
  }

  // 5) 下转确认
  if (journey.downgrade_sent_at && journey.downgrade_confirmed_at) {
    const h = hours(journey.downgrade_sent_at, journey.downgrade_confirmed_at);
    metrics.downgrade_confirm = record(
      Math.round(h * 10) / 10,
      rule.sla.downgrade_confirm_hours,
      h <= rule.sla.downgrade_confirm_hours
    );
  } else if (journey.downgrade_sent_at) {
    metrics.downgrade_confirm = record(null, rule.sla.downgrade_confirm_hours, false, "下转发起未获确认");
  } else {
    metrics.downgrade_confirm = { value: null, target: rule.sla.downgrade_confirm_hours, applicable: false, note: "未发起下转" };
  }

  // 6) 随访完成（须在旅程关闭后的随访窗口内）
  if (journey.closed_at && journey.followup_completed_at) {
    const d = days(journey.closed_at, journey.followup_completed_at);
    metrics.followup_completion = record(
      Math.round(d * 10) / 10,
      rule.sla.followup_window_days,
      d >= 0 && d <= rule.sla.followup_window_days
    );
  } else if (journey.closed_at) {
    metrics.followup_completion = record(null, rule.sla.followup_window_days, false, "关闭后未完成随访");
  } else {
    metrics.followup_completion = { value: null, target: rule.sla.followup_window_days, applicable: false, note: "旅程未关闭" };
  }

  return {
    referral_id: journey.referral_id,
    origin: journey.origin,
    risk: journey.risk ?? "unknown",
    status: journey.status ?? "closed",
    rule_version: rule.version,
    shift: journey.arrived_at ? shiftOf(journey.arrived_at) : null,
    metrics,
  };
}

export function metricKeys() {
  return [...METRIC_KEYS];
}

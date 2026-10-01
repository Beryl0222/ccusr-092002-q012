// 按规则版本计算的时间指标。纯函数：输入旅程数组 + 规则书 + 排除清单，输出可复算的结果。
// 状态约定：
//   ok       有起止事件且未超 SLA
//   breach   有起止事件但超过 SLA
//   missing  起点存在但缺少完成事件（漏传资料 / 无人接应 / 升级后未改道…）
//   n/a      该旅程不适用此指标（如未发生升级、未下转）
import { METRIC_KEYS, METRIC_LABELS } from "./rules.js";
import { median, minutesBetween, monthOf, percentile, shiftOf } from "./time.js";

function eventTime(events, type) {
  return events.find((e) => e.type === type)?.at ?? null;
}

function has(events, type) {
  return events.some((e) => e.type === type);
}

function classify(rule, key, minutes, applicable, missing) {
  if (!applicable) return { status: "n/a", minutes: null };
  if (missing) return { status: "missing", minutes: null };
  const sla = rule.slaMinutes[key];
  return { status: minutes > sla ? "breach" : "ok", minutes };
}

// 指标口径：起点 / 完成事件 / 适用性判定。集中在此，规则版本切换 SLA 与阈值即可改口径。
function computeJourneyMetrics(journey, rule) {
  const t0 = eventTime(journey.events, "order_created");
  const materialsComplete = eventTime(journey.events, "materials_complete");
  const firstContact = eventTime(journey.events, "first_contact");
  const arrival = eventTime(journey.events, "arrival");
  const handoff = eventTime(journey.events, "handoff");
  const escalation = eventTime(journey.events, "escalation");
  const rerouted = eventTime(journey.events, "rerouted");
  const downTransfer = eventTime(journey.events, "down_transfer");
  const downConfirmed = eventTime(journey.events, "down_confirmed");
  const followup = eventTime(journey.events, "followup_complete");

  const followupAnchor = downConfirmed ?? t0; // 有下转则以下转确认为随访计时锚点

  const defs = {
    materials_ready: {
      applicable: true,
      missing: materialsComplete === null,
      minutes: materialsComplete === null ? null : minutesBetween(t0, materialsComplete),
    },
    first_contact: {
      applicable: true,
      missing: firstContact === null,
      minutes: firstContact === null ? null : minutesBetween(t0, firstContact),
    },
    arrival_handoff: {
      applicable: arrival !== null,
      missing: arrival !== null && handoff === null,
      minutes: arrival !== null && handoff !== null ? minutesBetween(arrival, handoff) : null,
    },
    escalation_wait: {
      applicable: escalation !== null,
      missing: escalation !== null && rerouted === null,
      minutes: escalation !== null && rerouted !== null ? minutesBetween(escalation, rerouted) : null,
    },
    down_confirmation: {
      applicable: downTransfer !== null,
      missing: downTransfer !== null && downConfirmed === null,
      minutes: downTransfer !== null && downConfirmed !== null ? minutesBetween(downTransfer, downConfirmed) : null,
    },
    followup_completion: {
      applicable: true,
      missing: followup === null,
      minutes: followup === null ? null : minutesBetween(followupAnchor, followup),
    },
  };

  const metrics = {};
  for (const key of METRIC_KEYS) {
    const d = defs[key];
    metrics[key] = { label: METRIC_LABELS[key], ...classify(rule, key, d.minutes, d.applicable, d.missing) };
  }

  // 到院时段：用于发现"哪些到院时段最容易无人接应"
  const arrivalHour = arrival === null ? null : new Date(arrival + 8 * 3600_000).getUTCHours();
  const anchorMs = arrival ?? t0;
  return {
    referral_id: journey.referral_id,
    origin: journey.origin,
    risk: journey.risk,
    status: journey.status,
    shift: shiftOf(anchorMs, rule),
    arrivalHour,
    month: monthOf(t0),
    contentHash: journey.contentHash,
    metrics,
    flags: {
      arrivalNoHandoff: arrival !== null && handoff === null,
      materialsMissing: materialsComplete === null,
      escalatedWithoutReroute: escalation !== null && rerouted === null,
      escalated: escalation !== null,
      downTransferred: downTransfer !== null,
    },
  };
}

function emptyMetricStat(label) {
  return {
    label,
    n: 0, // 适用样本数（含缺失）
    measured: 0, // 有起止、可计时的样本数
    missing: 0,
    breach: 0,
    ok: 0,
    breachRate: null, // breach / measured
    missingRate: null, // missing / n
    failureRate: null, // (breach + missing) / n —— 漏传与无人接应必须计入，不能只看均值
    medianMinutes: null,
    p90Minutes: null,
  };
}

function fold(stat, cell) {
  stat.n += 1;
  if (cell.status === "missing") {
    stat.missing += 1;
    return;
  }
  stat.measured += 1;
  stat[cell.status] += 1;
  stat._values = stat._values ?? [];
  stat._values.push(cell.minutes);
}

function finalize(stat) {
  if (stat.n > 0) stat.missingRate = Number((stat.missing / stat.n).toFixed(4));
  if (stat.measured > 0) {
    stat.breachRate = Number((stat.breach / stat.measured).toFixed(4));
    const sorted = stat._values.sort((a, b) => a - b);
    stat.medianMinutes = median(sorted);
    stat.p90Minutes = percentile(sorted, 0.9);
  }
  stat.failureRate = stat.n > 0 ? Number((stat.breach + stat.missing) / stat.n).toFixed(4) : null;
  stat.failureRate = stat.failureRate === null ? null : Number(stat.failureRate);
  delete stat._values;
  return stat;
}

function metricStatsFor(rows, key) {
  const stat = emptyMetricStat(METRIC_LABELS[key]);
  for (const row of rows) {
    const cell = row.metrics[key];
    if (cell.status === "n/a") continue;
    fold(stat, cell);
  }
  return finalize(stat);
}

function allMetricStats(rows) {
  const out = {};
  for (const key of METRIC_KEYS) out[key] = metricStatsFor(rows, key);
  return out;
}

function groupBy(rows, fn) {
  const map = new Map();
  for (const row of rows) {
    const k = fn(row);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
}

// 分段统计：origin / risk / shift / origin×shift / 到院小时×是否无人接应
function segmentStats(rows) {
  const segments = {};
  for (const dim of ["origin", "risk", "shift"]) {
    segments[dim] = {};
    for (const [value, group] of groupBy(rows, (r) => r[dim])) {
      segments[dim][value] = { count: group.length, metrics: allMetricStats(group) };
    }
  }
  segments.origin_shift = {};
  for (const [value, group] of groupBy(rows, (r) => `${r.origin}|${r.shift}`)) {
    const [origin, shift] = value.split("|");
    segments.origin_shift[value] = { origin, shift, count: group.length, metrics: allMetricStats(group) };
  }
  return segments;
}

// 到院时段接应曲线：按小时统计到院量与无人接应数
function arrivalCoverage(rows) {
  const arrived = rows.filter((r) => r.arrivalHour !== null);
  const byHour = new Map();
  for (const row of arrived) {
    if (!byHour.has(row.arrivalHour)) {
      byHour.set(row.arrivalHour, { hour: row.arrivalHour, arrivals: 0, noHandoff: 0 });
    }
    const bucket = byHour.get(row.arrivalHour);
    bucket.arrivals += 1;
    if (row.flags.arrivalNoHandoff) bucket.noHandoff += 1;
  }
  return [...byHour.values()]
    .map((b) => ({ ...b, noHandoffRate: Number((b.noHandoff / b.arrivals).toFixed(4)) }))
    .sort((a, b) => a.hour - b.hour);
}

// 机构排名：样本不足 minRankSample 的机构只给计数、不公开名次
function rankOrigins(rows, rule) {
  const scored = [];
  const suppressed = [];
  for (const [origin, group] of groupBy(rows, (r) => r.origin)) {
    const stats = allMetricStats(group);
    const failureSum = METRIC_KEYS.reduce((acc, k) => acc + (stats[k].failureRate ?? 0), 0);
    const entry = { origin, sample: group.length, score: Number(failureSum.toFixed(4)), stats };
    if (group.length < rule.minRankSample) suppressed.push(entry);
    else scored.push(entry);
  }
  scored.sort((a, b) => b.score - a.score || a.origin.localeCompare(b.origin));
  const ranking = scored.map((entry, i) => ({ rank: i + 1, ...entry }));
  suppressed.sort((a, b) => a.origin.localeCompare(b.origin));
  return { ranking, suppressed: suppressed.map(({ origin, sample }) => ({ origin, sample, ranked: false })) };
}

// 异常发现：分段（机构×班次 为主）失败率显著高于总体，或缺失率超阈值
function detectAnomalies(overall, segments, rule) {
  const anomalies = [];
  for (const key of METRIC_KEYS) {
    const overallStat = overall[key];
    for (const [cellKey, cell] of Object.entries(segments.origin_shift)) {
      const stat = cell.metrics[key];
      if (stat.n < rule.anomaly.minCellN) continue;
      const reasons = [];
      if (
        stat.measured > 0 &&
        overallStat.breachRate !== null &&
        overallStat.breachRate > 0 &&
        stat.breachRate >= overallStat.breachRate * rule.anomaly.breachRatio
      ) {
        reasons.push("breach_ratio");
      }
      if ((stat.missingRate ?? 0) >= rule.anomaly.missingRate) reasons.push("missing_rate");
      if (reasons.length > 0) {
        anomalies.push({
          metric: key,
          origin: cell.origin,
          shift: cell.shift,
          n: stat.n,
          breachRate: stat.breachRate,
          missingRate: stat.missingRate,
          medianMinutes: stat.medianMinutes,
          reasons,
        });
      }
    }
  }
  anomalies.sort(
    (a, b) =>
      (b.missingRate ?? 0) - (a.missingRate ?? 0) ||
      (b.breachRate ?? 0) - (a.breachRate ?? 0) ||
      a.metric.localeCompare(b.metric)
  );
  return anomalies;
}

/**
 * 计算一整套指标。
 * @param journeys 已校验旅程（closed 才计入；open 仅在 openCount 中体现）
 * @param rule     规则书版本
 * @param options  { exclusions: Map<referral_id, {code, reason}> }
 */
export function computeMetrics(journeys, rule, options = {}) {
  const exclusions = options.exclusions ?? new Map();
  const closed = journeys.filter((j) => j.status === "closed");
  const openCount = journeys.length - closed.length;

  const excludedRows = [];
  const included = [];
  for (const j of closed) {
    const exclusion = exclusions.get(j.referral_id);
    if (exclusion) excludedRows.push({ referral_id: j.referral_id, ...exclusion });
    else included.push(j);
  }

  const rows = included.map((j) => computeJourneyMetrics(j, rule));
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const overall = allMetricStats(rows);
  const segments = segmentStats(rows);
  const anomalies = detectAnomalies(overall, segments, rule);
  const ranks = rankOrigins(rows, rule);

  return {
    ruleVersion: rule.version,
    generatedFrom: { closed: closed.length, open: openCount, excluded: excludedRows.length, included: rows.length },
    months,
    overall,
    segments,
    arrivalCoverage: arrivalCoverage(rows),
    anomalies,
    ranking: ranks.ranking,
    suppressedOrigins: ranks.suppressed,
    exclusions: excludedRows.sort((a, b) => a.referral_id.localeCompare(b.referral_id)),
    rows,
  };
}

export { computeJourneyMetrics, allMetricStats, metricStatsFor };

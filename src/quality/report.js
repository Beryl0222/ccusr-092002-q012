// 月度质控报告：冻结输入与排除清单、按规则版本计算、小样本机构不公开排名、
// 历史重放校验（重放到冻结事件位置须得到一致报告）。

import { computeMetrics } from "./model.js";
import { METRIC_KEYS, METRIC_META, RULE_VERSIONS, getRule } from "./rules.js";
import { canonicalHash, effectiveJourney } from "./store.js";

function monthKey(dateInput) {
  return dateInput.slice(0, 7);
}

// 汇总单个切片（机构/风险/班次）。不适用指标不纳入达标率分母。
function summarize(computedList) {
  const metrics = {};
  for (const key of METRIC_KEYS) {
    const applicable = computedList.filter((c) => c.metrics[key].applicable !== false);
    const evaluable = applicable.filter((m) => m.metrics[key].value !== null);
    const met = evaluable.filter((m) => m.metrics[key].met === true);
    const values = evaluable.map((m) => m.metrics[key].value);
    metrics[key] = {
      label: METRIC_META[key].label,
      unit: METRIC_META[key].unit,
      applicable_n: applicable.length,
      evaluated_n: evaluable.length,
      missing_n: applicable.length - evaluable.length,
      pass_rate: evaluable.length ? Math.round((met.length / evaluable.length) * 1000) / 1000 : null,
      mean: values.length ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10 : null,
    };
  }
  return { sample_n: computedList.length, metrics };
}

// 构建某月“数据集视图”：冻结的是输入与排除清单，口径由规则版本决定。
export function buildMonthDataset(state, month) {
  const exclusions = [...state.exclusions.values()]
    .filter((e) => e.active)
    .map((e) => ({ id: e.id, referral_id: e.referral_id, reason: e.reason, by: e.by }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const excludedIds = new Set(exclusions.map((e) => e.referral_id));

  const included = [];
  for (const [id, entry] of state.journeys) {
    const journey = effectiveJourney(state, id);
    if (journey.status !== "closed") continue;
    if (monthKey(journey.created_at) !== month) continue;
    if (excludedIds.has(id)) continue;
    included.push(journey);
  }
  included.sort((a, b) => a.referral_id.localeCompare(b.referral_id));
  return { included, exclusions };
}

// 冻结输入的指纹：纳入病例的原始内容（含补正链）+ 排除清单 + 规则版本表。
// 规则版本表入哈希，确保口径若被误改，重放立即不一致。
export function datasetFingerprint(state, month) {
  const includedInputs = [...state.journeys.entries()]
    .filter(([, e]) => monthKey(e.raw.created_at) === month)
    .map(([id, e]) => ({
      referral_id: id,
      raw: e.raw,
      amendments: e.amendments.map((a) => {
        const { seq, at, ...rest } = a;
        return rest;
      }),
    }))
    .sort((a, b) => a.referral_id.localeCompare(b.referral_id));
  const { exclusions } = buildMonthDataset(state, month);
  return canonicalHash({
    month,
    included_inputs: includedInputs,
    exclusions,
    rule_versions: RULE_VERSIONS.map((r) => r.version),
  });
}

function rankedOrigins(byOrigin, minSample) {
  // 仅对样本量达标的机构公开排名；小样本机构列入 suppressed，不排名。
  const eligible = Object.entries(byOrigin).filter(([, s]) => s.sample_n >= minSample);
  const suppressed = Object.entries(byOrigin)
    .filter(([, s]) => s.sample_n < minSample)
    .map(([origin, s]) => ({ origin, sample_n: s.sample_n, reason: `样本量<${minSample}，不予公开排名` }));
  // 以六项指标平均达标率排序（任一指标无数据按 null 跳过），仅用于相对比较
  const score = (s) => {
    const rates = METRIC_KEYS.map((k) => s.metrics[k].pass_rate).filter((v) => v !== null);
    return rates.reduce((a, b) => a + b, 0) / (rates.length || 1);
  };
  const ranking = eligible
    .map(([origin, s]) => ({ origin, sample_n: s.sample_n, score: Math.round(score(s) * 1000) / 1000 }))
    .sort((a, b) => b.score - a.score)
    .map((r, i) => ({ rank: i + 1, ...r }));
  return { ranking, suppressed };
}

export function buildReport(state, month, { asOfSeq = Infinity } = {}) {
  const { included, exclusions } = buildMonthDataset(state, month);
  const computed = included.map((j) => computeMetrics(j));

  // 该月病例可能跨口径（如 9 月单 v1，10 月单 v2），按实际生效版本分组声明
  const ruleVersionsUsed = [...new Set(computed.map((c) => c.rule_version))].sort();

  const overall = summarize(computed);

  const groupBy = (fn) => {
    const buckets = {};
    for (const c of computed) {
      const key = fn(c) ?? "unknown";
      (buckets[key] ??= []).push(c);
    }
    return Object.fromEntries(Object.entries(buckets).map(([k, list]) => [k, summarize(list)]));
  };
  const byRisk = groupBy((c) => c.risk);
  const byShift = groupBy((c) => c.shift);
  const byOrigin = groupBy((c) => c.origin);

  // 各机构适用阈值取决于其病例所用规则版本；同一切片单一版本时直接给出阈值说明
  const minSample = Math.min(
    ...ruleVersionsUsed.map((v) => getRule(v).min_sample_for_ranking)
  );
  const { ranking, suppressed } = rankedOrigins(byOrigin, minSample);

  return {
    month,
    generated_at: new Date().toISOString(),
    as_of_seq: asOfSeq === Infinity ? null : asOfSeq,
    rule_versions_used: ruleVersionsUsed,
    cohort: {
      closed_n: computed.length,
      excluded_n: exclusions.length,
      exclusions,
    },
    overall,
    by_risk: byRisk,
    by_shift: byShift,
    by_origin: byOrigin,
    ranking,
    suppressed_orgs: suppressed,
    ranking_note: `样本量<${minSample}的基层点不公开排名`,
  };
}

// 冻结月报：记录事件流位置、输入指纹与报告快照。
export function freezeMonth(store, app, month, { by } = {}) {
  const state = store.replay();
  if (state.freezes.has(month)) {
    const err = new Error("该月已冻结，不得重复冻结（如需修订请走口径版本升级）");
    err.status = 409;
    throw err;
  }
  const fingerprint = datasetFingerprint(state, month);
  const report = buildReport(state, month);
  const payload = {
    month,
    by,
    frozen_at: new Date().toISOString(),
    head_seq: store.headSeq(),
    input_fingerprint: fingerprint,
    rule_versions_snapshot: RULE_VERSIONS.map((r) => ({
      version: r.version,
      effective_from: r.effective_from,
      required_documents: r.required_documents,
      sla: r.sla,
      min_sample_for_ranking: r.min_sample_for_ranking,
    })),
    report,
  };
  store.append("month_frozen", payload);
  return payload;
}

// 重放历史月份：在冻结事件位置重算，校验指纹与报告是否一致。
export function replayMonth(store, month) {
  const state = store.replay();
  const freeze = state.freezes.get(month);
  if (!freeze) {
    const err = new Error(`月份 ${month} 未冻结，无法重放`);
    err.status = 404;
    throw err;
  }
  // 重放到“冻结事件本身”所在位置，排除冻结事件后的所有变化
  const atFreeze = store.replay(freeze.frozen_seq - 1);
  const recomputedFingerprint = datasetFingerprint(atFreeze, month);
  const recomputedReport = buildReport(atFreeze, month, { asOfSeq: freeze.frozen_seq - 1 });

  return {
    month,
    frozen_at: freeze.frozen_at,
    frozen_seq: freeze.frozen_seq,
    consistent: recomputedFingerprint === freeze.input_fingerprint,
    fingerprint: { frozen: freeze.input_fingerprint, replayed: recomputedFingerprint },
    frozen_report: freeze.report,
    replayed_report: recomputedReport,
  };
}

// 质控应用层：审查队列、双人标注、申诉、整改闭环、下钻。
// 只写质控侧记录；对在诊个案拒绝任何变更路线类操作。

import { createHash } from "node:crypto";

import { deidentifyTimeline, pseudonymizeId } from "./anonymize.js";
import { computeMetrics } from "./model.js";
import { METRIC_KEYS, getRule, ruleAt, shiftOf } from "./rules.js";
import { canonicalHash, effectiveJourney } from "./store.js";

export const ACTIVE_STATUSES = new Set(["active", "in_treatment"]);

export class QualityError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 确定性抽样：相同队列（月份+维度+比例+盐）重放得到相同样本，
// 不依赖随机数状态，便于复测与审计。
export function sampleCases(caseIds, { ratio, salt = "" }) {
  const r = Number(ratio);
  if (!Number.isFinite(r) || r <= 0 || r > 1) throw new QualityError(400, "抽样比例须在 (0,1]");
  const scored = caseIds
    .map((id) => {
      const h = createHash("sha256").update(`${salt}:${id}`).digest();
      const bucket = h.readUInt32BE(0) / 0x1_0000_0000;
      return { id, bucket };
    })
    .sort((a, b) => (a.bucket - b.bucket || a.id.localeCompare(b.id)));
  const count = Math.max(1, Math.round(caseIds.length * r));
  return scored.slice(0, Math.min(count, scored.length)).map((s) => s.id);
}

function monthKey(dateInput) {
  return dateInput.slice(0, 7);
}

export function createQualityApp(store, { salt = "fuding-qi", now = () => new Date() } = {}) {
  const requireClosed = (state, referralId) => {
    const entry = state.journeys.get(referralId);
    if (!entry) throw new QualityError(404, "转诊单不存在");
    const journey = effectiveJourney(state, referralId);
    if (ACTIVE_STATUSES.has(journey.status)) {
      throw new QualityError(409, "在诊个案只读接入，质控系统不得变更其路线");
    }
    return journey;
  };

  // ---- 录入脱敏转诊单/已关闭旅程 ----
  const recordJourney = (journey) => {
    const state = store.replay();
    if (state.journeys.has(journey.referral_id)) throw new QualityError(409, "转诊单已存在");
    return store.append("journey_recorded", journey);
  };

  // 资料补正：叠加，不覆盖；可追溯前后
  const amendDocuments = (referralId, { documents, patch, reason, by }) => {
    const state = store.replay();
    if (!state.journeys.has(referralId)) throw new QualityError(404, "转诊单不存在");
    return store.append("journey_amended", { referral_id: referralId, documents, patch, reason, by });
  };

  // ---- 排除清单（冻结时一并固定）----
  const addExclusion = (id, { referral_id, reason, by }) =>
    store.append("exclusion_added", { id, referral_id, reason, by });
  const revokeExclusion = (id, { reason, by }) =>
    store.append("exclusion_revoked", { id, reason, by });

  // ---- 审查队列：按来源机构 / 风险层级 / 班次 ----
  const buildCohort = (state, { month, origin, risk, shift }) => {
    const ids = [];
    for (const [id] of state.journeys) {
      const journey = effectiveJourney(state, id);
      if (journey.status !== "closed") continue;
      if (month && monthKey(journey.created_at) !== month) continue;
      if (origin && journey.origin !== origin) continue;
      if (risk && (journey.risk ?? "unknown") !== risk) continue;
      if (shift) {
        if (!journey.arrived_at || shiftOf(journey.arrived_at) !== shift) continue;
      }
      const excluded = [...state.exclusions.values()].some(
        (e) => e.active && e.referral_id === id
      );
      if (excluded) continue;
      ids.push(id);
    }
    return ids.sort();
  };

  const createQueue = ({ month, origin, risk, shift, ratio, by }) => {
    const state = store.replay();
    const cohort = buildCohort(state, { month, origin, risk, shift });
    const salt = `${month}|${origin ?? ""}|${risk ?? ""}|${shift ?? ""}`;
    const sampled = sampleCases(cohort, { ratio, salt });
    const queue_id = canonicalHash({ month, origin, risk, shift, ratio, cohort }).slice(0, 16);
    const payload = {
      queue_id,
      month,
      origin: origin ?? null,
      risk: risk ?? null,
      shift: shift ?? null,
      ratio,
      cohort_size: cohort.length,
      cohort,
      sampled,
      by,
    };
    store.append("queue_sampled", payload);
    return payload;
  };

  // ---- 双人标注根因 + 分歧仲裁，前后结论都保留 ----
  const openReview = ({ queue_id, referral_id, metric, by }) => {
    const state = store.replay();
    requireClosed(state, referral_id);
    if (!METRIC_KEYS.includes(metric)) throw new QualityError(400, `未知指标: ${metric}`);
    const review_id = canonicalHash({ queue_id, referral_id, metric }).slice(0, 16);
    if (state.reviews.has(review_id)) throw new QualityError(409, "该病例指标已建立审查");
    store.append("review_opened", { review_id, queue_id, referral_id, metric, opened_by: by });
    return review_id;
  };

  const annotate = ({ review_id, reviewer, root_cause, metric_verdict }) => {
    const state = store.replay();
    const r = state.reviews.get(review_id);
    if (!r) throw new QualityError(404, "审查不存在");
    if (r.annotations.some((a) => a.reviewer === reviewer)) {
      throw new QualityError(409, "同一审查员不得重复标注（如需更正请追加仲裁说明）");
    }
    if (r.annotations.length >= 2) throw new QualityError(409, "双人标注已齐");
    if (!["met", "missed"].includes(metric_verdict)) throw new QualityError(400, "结论须为 met/missed");
    store.append("annotation_added", { review_id, reviewer, root_cause, metric_verdict });
    return reviewStatus(store.replay(), review_id);
  };

  const adjudicate = ({ review_id, arbiter, final_root_cause, final_verdict, note }) => {
    const state = store.replay();
    const r = state.reviews.get(review_id);
    if (!r) throw new QualityError(404, "审查不存在");
    if (r.annotations.length < 2) throw new QualityError(409, "须双人标注后方可仲裁");
    const verdicts = r.annotations.map((a) => a.metric_verdict);
    if (verdicts[0] === verdicts[1]) throw new QualityError(409, "双人标注已达成一致，无需仲裁");
    if (r.adjudication) throw new QualityError(409, "该审查已仲裁");
    if (!["met", "missed"].includes(final_verdict)) throw new QualityError(400, "结论须为 met/missed");
    store.append("adjudication_added", { review_id, arbiter, final_root_cause, final_verdict, note });
    return reviewStatus(store.replay(), review_id);
  };

  function reviewStatus(state, review_id) {
    const r = state.reviews.get(review_id);
    const verdicts = r.annotations.map((a) => a.metric_verdict);
    const consensus = verdicts.length === 2 && verdicts[0] === verdicts[1] ? verdicts[0] : null;
    return {
      review_id,
      metric: r.metric,
      annotations: r.annotations.map((a) => ({
        reviewer: a.reviewer,
        root_cause: a.root_cause,
        metric_verdict: a.metric_verdict,
      })),
      consensus,
      needs_adjudication: verdicts.length === 2 && !consensus,
      adjudication: r.adjudication
        ? {
            arbiter: r.adjudication.arbiter,
            final_root_cause: r.adjudication.final_root_cause,
            final_verdict: r.adjudication.final_verdict,
            note: r.adjudication.note,
          }
        : null,
      final_verdict: r.adjudication?.final_verdict ?? consensus,
    };
  }

  // ---- 机构申诉：保留申诉前后结论 ----
  const fileAppeal = ({ review_id, origin, justification, by }) => {
    const state = store.replay();
    const r = state.reviews.get(review_id);
    if (!r) throw new QualityError(404, "审查不存在");
    const appeal_id = `AP-${review_id}`;
    if (state.appeals.has(appeal_id)) throw new QualityError(409, "该审查已申诉");
    store.append("appeal_filed", {
      appeal_id,
      review_id,
      origin,
      justification,
      by,
      prior_verdict: reviewStatus(state, review_id).final_verdict,
    });
    return appeal_id;
  };

  const resolveAppeal = (appeal_id, { upheld, decision_note, by }) => {
    const state = store.replay();
    const a = state.appeals.get(appeal_id);
    if (!a) throw new QualityError(404, "申诉不存在");
    store.append("appeal_resolved", { appeal_id, upheld, decision_note, by });
    return appealView(store.replay(), appeal_id);
  };

  function appealView(state, appeal_id) {
    const a = state.appeals.get(appeal_id);
    return {
      appeal_id,
      review_id: a.review_id,
      origin: a.origin,
      justification: a.justification,
      prior_verdict: a.prior_verdict,
      status: a.status,
      final_verdict: a.status === "upheld" ? overturn(a.prior_verdict) : a.prior_verdict,
      decision_note: a.resolution?.decision_note ?? null,
    };
  }
  const overturn = (v) => (v === "missed" ? "met" : "missed");

  // ---- 整改：负责人 + 期限 + 复测样本，达标方可关闭 ----
  const createAction = ({ review_id, owner, due_date, intervention, retest, by }) => {
    const state = store.replay();
    const r = state.reviews.get(review_id);
    if (!r) throw new QualityError(404, "审查不存在");
    if (!owner) throw new QualityError(400, "整改须指定负责人");
    if (!due_date) throw new QualityError(400, "整改须设定期限");
    if (!retest?.sample_size || retest.sample_size < 1) throw new QualityError(400, "整改须定义复测样本量");
    if (!retest?.target_pass_rate) throw new QualityError(400, "整改须定义复测达标率");
    const action_id = `ACT-${review_id}`;
    if (state.actions.has(action_id)) throw new QualityError(409, "该审查已有整改项");
    store.append("action_created", {
      action_id,
      review_id,
      owner,
      due_date,
      intervention, // 培训/排班/接口整改
      retest,
      created_by: by,
    });
    return action_id;
  };

  const addEvidence = (action_id, { kind, url, note, by }) => {
    const state = store.replay();
    if (!state.actions.has(action_id)) throw new QualityError(404, "整改项不存在");
    store.append("evidence_added", { action_id, kind, url, note, by });
  };

  const recordRetest = (action_id, { sample_size, pass_count, period, by }) => {
    const state = store.replay();
    const a = state.actions.get(action_id);
    if (!a) throw new QualityError(404, "整改项不存在");
    if (sample_size < a.retest.sample_size) {
      throw new QualityError(400, `复测样本不足：要求≥${a.retest.sample_size}，实际${sample_size}`);
    }
    const pass_rate = pass_count / sample_size;
    store.append("retest_recorded", {
      action_id,
      sample_size,
      pass_count,
      pass_rate,
      period,
      target_pass_rate: a.retest.target_pass_rate,
      by,
    });
  };

  const closeAction = (action_id, { by }) => {
    const state = store.replay();
    const a = state.actions.get(action_id);
    if (!a) throw new QualityError(404, "整改项不存在");
    const latest = a.retests[a.retests.length - 1];
    if (!latest) throw new QualityError(409, "无复测结果，不能仅凭总体平均值关闭");
    if (latest.sample_size < a.retest.sample_size) {
      throw new QualityError(409, `复测样本量不足（≥${a.retest.sample_size}）`);
    }
    if (latest.pass_rate < a.retest.target_pass_rate) {
      throw new QualityError(409, `复测达标率 ${(latest.pass_rate * 100).toFixed(0)}% 未达目标 ${(a.retest.target_pass_rate * 100).toFixed(0)}%，不得关闭`);
    }
    if (!a.evidence.length) throw new QualityError(409, "缺少整改证据，不得关闭");
    store.append("action_closed", { action_id, by, basis: `复测${latest.sample_size}例达标率${(latest.pass_rate * 100).toFixed(0)}%` });
    return actionView(store.replay(), action_id);
  };

  const reopenAction = (action_id, { reason, by }) =>
    store.append("action_reopened", { action_id, reason, by });

  function actionView(state, action_id) {
    const a = state.actions.get(action_id);
    const overdue = new Date(a.due_date) < now();
    return {
      action_id,
      review_id: a.review_id,
      owner: a.owner,
      due_date: a.due_date,
      overdue,
      intervention: a.intervention,
      retest_plan: a.retest,
      evidence: a.evidence.map((e) => ({ kind: e.kind, url: e.url, note: e.note, by: e.by, at: e.at })),
      retests: a.retests.map((t) => ({
        sample_size: t.sample_size,
        pass_count: t.pass_count,
        pass_rate: t.pass_rate,
        period: t.period,
      })),
      status: a.status,
      closure: a.closure ? { at: a.closure.at, basis: a.closure.basis, by: a.closure.by } : null,
    };
  }

  // ---- 下钻：异常指标 → 去标识事件 → 审查意见 → 整改证据 ----
  const drilldown = (referralId, metric, { asOfSeq = Infinity } = {}) => {
    const state = store.replay(asOfSeq);
    const journey = effectiveJourney(state, referralId);
    if (!journey) throw new QualityError(404, "转诊单不存在");
    const computed = computeMetrics(journey);
    const reviews = [...state.reviews.values()]
      .filter((r) => r.referral_id === referralId && r.metric === metric)
      .map((r) => {
        const rs = reviewStatus(state, r.review_id);
        const appeal = [...state.appeals.values()].find((x) => x.review_id === r.review_id);
        const action = state.actions.get(`ACT-${r.review_id}`);
        return {
          ...rs,
          appeal: appeal ? appealView(state, appeal.appeal_id) : null,
          action: action ? actionView(state, action.action_id) : null,
        };
      });
    return {
      case_ref: pseudonymizeId(referralId, salt),
      origin: journey.origin,
      risk: journey.risk ?? "unknown",
      rule_version: computed.rule_version,
      metric,
      metric_value: computed.metrics[metric],
      events: deidentifyTimeline(journey, salt),
      reviews,
    };
  };

  return {
    recordJourney,
    amendDocuments,
    addExclusion,
    revokeExclusion,
    createQueue,
    buildCohort,
    openReview,
    annotate,
    adjudicate,
    reviewStatus: (id) => reviewStatus(store.replay(), id),
    fileAppeal,
    resolveAppeal,
    createAction,
    addEvidence,
    recordRetest,
    closeAction,
    reopenAction,
    actionView: (id) => actionView(store.replay(), id),
    drilldown,
    sampleCases,
  };
}

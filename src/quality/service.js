// 转诊质量改进服务（referral-quality）
// 边界：只消费脱敏数据；open（在诊）旅程只读，质控动作不得作用于在诊个案；本系统不改临床路线。
import { validateJourney, validateReferral } from "./ingest.js";
import {
  computeJourneyMetrics,
  computeMetrics,
} from "./metrics.js";
import { ConflictError, NotFoundError, RuleViolationError, ValidationError } from "./errors.js";
import { getRule, latestRuleVersion, METRIC_KEYS } from "./rules.js";
import { deterministicSample, stratifiedSample } from "./sampling.js";
import { hashOf, monthOf, parseTs } from "./time.js";

const OPEN_READONLY_MESSAGE = "在诊个案为只读接入，质控系统不得对其采取任何动作";

function nowIso() {
  return new Date().toISOString();
}

export class QualityService {
  constructor(clock = nowIso) {
    this.clock = clock;
    // referral_id -> { current: journey, versions: [{journey, at, reason, submittedBy}] }
    this.journeys = new Map();
    this.rawReferrals = new Map();
    this.exclusions = new Map(); // referral_id -> {code, reason, month, by, at}
    this.queues = new Map();
    this.reviews = new Map(); // caseId -> review record
    this.appeals = [];
    this.actions = [];
    this.reports = new Map(); // month -> frozen report
    this.caliberChanges = [];
    this.counters = { appeal: 0, action: 0, queue: 0 };
  }

  // ---------- 摄取 ----------

  ingestReferral(input) {
    validateReferral(input);
    this.rawReferrals.set(input.referral_id, { data: input, at: this.clock() });
    return { referral_id: input.referral_id, accepted: true, readonly: input.status === "open" };
  }

  ingestJourney(input, { reason = "上报", submittedBy = "upstream" } = {}) {
    const journey = validateJourney(input);
    const existing = this.journeys.get(journey.referral_id);

    // 在诊个案：允许同步（只读接入），但不得产生任何新版本以外的质控写操作
    if (journey.status === "open") {
      this.journeys.set(journey.referral_id, {
        current: journey,
        versions: [...(existing?.versions ?? []), { journey, at: this.clock(), reason, submittedBy }],
      });
      return { referral_id: journey.referral_id, status: "open", version: journey.contentHash, readonly: true };
    }

    if (existing && existing.current.status === "closed" && existing.current.contentHash === journey.contentHash) {
      return { referral_id: journey.referral_id, status: "closed", version: journey.contentHash, duplicated: true };
    }

    const versions = [...(existing?.versions ?? []), { journey, at: this.clock(), reason, submittedBy }];
    this.journeys.set(journey.referral_id, { current: journey, versions });
    return {
      referral_id: journey.referral_id,
      status: "closed",
      version: journey.contentHash,
      superseded: existing ? existing.current.contentHash : null,
      versions: versions.length,
    };
  }

  // 资料补正：登记新版本，旧版本保留，并给出该个案补正前后的指标结论
  submitCorrection(referralId, correctedJourney, { submittedBy = "origin", note = "" } = {}) {
    const existing = this.journeys.get(referralId);
    if (!existing) throw new NotFoundError(`旅程不存在: ${referralId}`);
    if (existing.current.status === "open") throw new ConflictError(OPEN_READONLY_MESSAGE, "OPEN_READONLY");
    if (correctedJourney.referral_id !== referralId) {
      throw new ValidationError("补正数据 referral_id 与目标不一致");
    }
    const before = this.caseConclusion(referralId);
    const result = this.ingestJourney(correctedJourney, {
      reason: `资料补正: ${note}`.trim(),
      submittedBy,
    });
    const after = this.caseConclusion(referralId);
    return { ...result, correction: { before: before.cells, after: after.cells, changed: before.hash !== after.hash } };
  }

  getJourney(referralId) {
    const entry = this.journeys.get(referralId);
    if (!entry) throw new NotFoundError(`旅程不存在: ${referralId}`);
    return entry.current;
  }

  assertClosed(referralId) {
    const journey = this.getJourney(referralId);
    if (journey.status === "open") throw new ConflictError(OPEN_READONLY_MESSAGE, "OPEN_READONLY");
    return journey;
  }

  // ---------- 排除清单 ----------

  addExclusion(referralId, { code, reason, by = "qc" }) {
    const journey = this.getJourney(referralId);
    const rule = getRule(latestRuleVersion());
    if (!rule.allowedExclusions.includes(code)) {
      throw new ValidationError(`不允许的排除代码: ${code}`, { allowed: rule.allowedExclusions });
    }
    const record = { referral_id: referralId, code, reason, month: monthOf(journey.events[0].at), by, at: this.clock() };
    this.exclusions.set(referralId, record);
    return record;
  }

  removeExclusion(referralId, { by = "qc" } = {}) {
    const existed = this.exclusions.get(referralId);
    if (!existed) throw new NotFoundError(`该转诊不在排除清单: ${referralId}`);
    this.exclusions.delete(referralId);
    return { removed: true, referral_id: referralId, previous: existed, by, at: this.clock() };
  }

  // ---------- 指标（内存即席计算，始终显式指定或默认当前规则版本） ----------

  caseConclusion(referralId, ruleVersion = latestRuleVersion()) {
    const journey = this.assertClosed(referralId);
    const row = computeJourneyMetrics(journey, getRule(ruleVersion));
    const exclusion = this.exclusions.get(referralId) ?? null;
    const cells = Object.fromEntries(
      METRIC_KEYS.map((k) => [k, { status: row.metrics[k].status, minutes: row.metrics[k].minutes }])
    );
    return {
      referral_id: referralId,
      ruleVersion,
      contentHash: journey.contentHash,
      excluded: Boolean(exclusion),
      exclusion,
      cells,
      // 结论指纹覆盖：旅程版本 + 口径版本 + 是否被排除。任一项变化都视为结论变化。
      hash: hashOf({ contentHash: journey.contentHash, ruleVersion, excluded: Boolean(exclusion) }),
      row,
    };
  }

  currentMetrics({ ruleVersion = latestRuleVersion(), month = null } = {}) {
    const rule = getRule(ruleVersion);
    let journeys = [...this.journeys.values()].map((e) => e.current);
    if (month) {
      journeys = journeys.filter((j) => monthOf(j.events[0].at) === month);
    }
    return computeMetrics(journeys, rule, { exclusions: this.exclusions });
  }

  // ---------- 审查队列 ----------

  createReviewQueue({ name, origin = null, risk = null, shift = null, month = null, sampleSize = 10,
    perOrigin = false, ruleVersion = latestRuleVersion(), createdBy = "qc" }) {
    const rule = getRule(ruleVersion);
    const basis = [...this.journeys.values()]
      .map((e) => e.current)
      .filter((j) => j.status === "closed")
      .filter((j) => (origin ? j.origin === origin : true))
      .filter((j) => (risk ? j.risk === risk : true))
      .filter((j) => (month ? monthOf(j.events[0].at) === month : true))
      .map((j) => {
        const row = computeJourneyMetrics(j, rule);
        return { key: j.referral_id, referral_id: j.referral_id, origin: j.origin, risk: j.risk, shift: row.shift, hash: j.contentHash };
      })
      .filter((c) => (shift ? c.shift === shift : true));

    const salt = `queue|${name}|${ruleVersion}|${origin ?? ""}|${risk ?? ""}|${shift ?? ""}|${month ?? ""}`;
    const picked = perOrigin
      ? stratifiedSample(basis, { sizePerStratum: sampleSize, strataOf: (c) => c.origin, salt })
      : deterministicSample(basis, { size: sampleSize, salt });

    const id = `Q-${String(++this.counters.queue).padStart(3, "0")}`;
    const queue = {
      id,
      name,
      ruleVersion,
      criteria: { origin, risk, shift, month, sampleSize, perOrigin },
      createdAt: this.clock(),
      createdBy,
      basisHash: hashOf(basis.map((c) => `${c.referral_id}@${c.hash}`).sort()),
      candidates: basis.length,
      cases: picked.map((c) => {
        const caseId = `${id}:${c.referral_id}`;
        this.reviews.set(caseId, {
          caseId,
          queueId: id,
          referral_id: c.referral_id,
          origin: c.origin,
          risk: c.risk,
          shift: c.shift,
          basisHash: c.hash,
          status: "pending_first",
          annotations: [],
          adjudication: null,
          history: [],
        });
        return { caseId, referral_id: c.referral_id, origin: c.origin, risk: c.risk, shift: c.shift };
      }),
    };
    this.queues.set(id, queue);
    return queue;
  }

  getReview(caseId) {
    const review = this.reviews.get(caseId);
    if (!review) throw new NotFoundError(`审查样本不存在: ${caseId}`);
    return review;
  }

  // 双人标注根因：两名不同审查人独立标注；一致即成立，不一致进入裁定
  annotateRootCause(caseId, { reviewer, rootCauses, comment = "" }) {
    if (!reviewer) throw new ValidationError("缺少 reviewer");
    if (!Array.isArray(rootCauses) || rootCauses.length === 0) {
      throw new ValidationError("至少标注一个根因代码");
    }
    const review = this.getReview(caseId);
    this.assertClosed(review.referral_id);
    if (review.annotations.some((a) => a.reviewer === reviewer)) {
      throw new ConflictError(`审查人已独立标注，禁止覆盖: ${reviewer}`, "ALREADY_ANNOTATED");
    }
    if (review.annotations.length >= 2) {
      throw new ConflictError("双人标注已满，如有分歧请走裁定", "ANNOTATION_FULL");
    }
    const annotation = { reviewer, rootCauses: [...rootCauses].sort(), comment, at: this.clock() };
    review.history.push({ type: "annotate", at: annotation.at, payload: annotation });
    review.annotations.push(annotation);

    if (review.annotations.length === 1) {
      review.status = "pending_second";
    } else {
      const [a, b] = review.annotations;
      const same = a.rootCauses.length === b.rootCauses.length && a.rootCauses.every((c, i) => c === b.rootCauses[i]);
      review.status = same ? "agreed" : "disagreement";
      review.agreedRootCauses = same ? a.rootCauses : null;
    }
    return { caseId: caseId, status: review.status, annotations: review.annotations };
  }

  adjudicate(caseId, { adjudicator, rootCauses, comment = "" }) {
    const review = this.getReview(caseId);
    this.assertClosed(review.referral_id);
    if (review.status !== "disagreement") {
      throw new RuleViolationError("仅双人标注不一致的样本可裁定", { status: review.status });
    }
    if (review.annotations.some((a) => a.reviewer === adjudicator)) {
      throw new ConflictError("裁定人不得为原审标注人之一", "ADJUDICATOR_CONFLICT");
    }
    review.adjudication = { adjudicator, rootCauses: [...rootCauses].sort(), comment, at: this.clock() };
    review.status = "adjudicated";
    review.history.push({ type: "adjudicate", at: review.adjudication.at, payload: review.adjudication });
    return { caseId: caseId, status: review.status, finalRootCauses: review.adjudication.rootCauses };
  }

  finalRootCauses(caseId) {
    const review = this.getReview(caseId);
    if (review.status === "agreed") return review.agreedRootCauses;
    if (review.status === "adjudicated") return review.adjudication.rootCauses;
    return null;
  }

  // ---------- 机构申诉：保留前后结论 ----------

  appeal(caseIdOrReferralId, { origin, grounds, requestedAction, by = "origin_user" }) {
    // 允许按样本 id 或转诊 id 发起（未入抽样队列的个案，机构仍可申诉）
    let review = this.reviews.get(caseIdOrReferralId);
    if (!review) {
      const byReferral = [...this.reviews.values()].find((r) => r.referral_id === caseIdOrReferralId);
      if (byReferral) review = byReferral;
    }
    const referralId = review ? review.referral_id : caseIdOrReferralId;
    const journey = this.journeys.has(referralId) ? this.assertClosed(referralId) : null;
    if (!review && !journey) throw new NotFoundError(`申诉对象不存在: ${caseIdOrReferralId}`);
    const before = this.caseConclusion(referralId);
    const record = {
      id: `A-${String(++this.counters.appeal).padStart(3, "0")}`,
      caseId: review?.caseId ?? null,
      referral_id: referralId,
      origin: origin ?? review?.origin ?? journey.origin,
      grounds,
      requestedAction,
      by,
      at: this.clock(),
      status: "open",
      before: { ruleVersion: before.ruleVersion, hash: before.hash, cells: before.cells },
      response: null,
      after: null,
    };
    this.appeals.push(record);
    return record;
  }

  respondAppeal(appealId, { decision, response, by = "qc", addExclusionCode = null, exclusionReason = null }) {
    const appeal = this.appeals.find((a) => a.id === appealId);
    if (!appeal) throw new NotFoundError(`申诉不存在: ${appealId}`);
    if (!["upheld", "partial", "rejected"].includes(decision)) {
      throw new ValidationError("decision 必须为 upheld / partial / rejected");
    }
    if (addExclusionCode) {
      this.addExclusion(appeal.referral_id, {
        code: addExclusionCode,
        reason: exclusionReason ?? `申诉成立: ${appeal.id}`,
        by,
      });
    }
    const after = this.caseConclusion(appeal.referral_id);
    appeal.response = { decision, response, by, at: this.clock(), exclusionAdded: Boolean(addExclusionCode) };
    appeal.after = {
      ruleVersion: after.ruleVersion,
      hash: after.hash,
      cells: after.cells,
      excluded: after.excluded,
      exclusion: after.exclusion,
    };
    appeal.status = "closed";
    return appeal;
  }

  // ---------- 指标口径调整：前后结论并存 ----------

  recordCaliberChange({ month, fromVersion, toVersion, reason, by = "qc" }) {
    getRule(fromVersion);
    getRule(toVersion);
    const before = this.currentMetrics({ ruleVersion: fromVersion, month });
    const after = this.currentMetrics({ ruleVersion: toVersion, month });
    const digest = (m) =>
      Object.fromEntries(METRIC_KEYS.map((k) => [k, {
        n: m.overall[k].n,
        ok: m.overall[k].ok,
        breach: m.overall[k].breach,
        missing: m.overall[k].missing,
        breachRate: m.overall[k].breachRate,
        missingRate: m.overall[k].missingRate,
        medianMinutes: m.overall[k].medianMinutes,
      }]));
    const record = {
      id: `C-${this.caliberChanges.length + 1}`,
      month,
      fromVersion,
      toVersion,
      reason,
      by,
      at: this.clock(),
      before: { ruleVersion: fromVersion, overall: digest(before), reportHash: hashOf(before.rows) },
      after: { ruleVersion: toVersion, overall: digest(after), reportHash: hashOf(after.rows) },
    };
    this.caliberChanges.push(record);
    return record;
  }

  // ---------- 整改：负责人 / 期限 / 复测样本，未达标不得关闭 ----------

  createAction({ title, metric, origin = null, shift = null, owner, dueAt, requiredSample,
    ruleVersion = latestRuleVersion(), sourceAppealId = null, sourceAnomaly = null, evidence = [] }) {
    if (!METRIC_KEYS.includes(metric)) throw new ValidationError(`未知指标: ${metric}`);
    if (!owner) throw new ValidationError("整改必须有负责人");
    const due = parseTs(dueAt, "dueAt");
    if (!Number.isInteger(requiredSample) || requiredSample <= 0) {
      throw new ValidationError("整改必须声明复测样本量");
    }
    const action = {
      id: `P-${String(++this.counters.action).padStart(3, "0")}`,
      title,
      metric,
      origin,
      shift,
      owner,
      dueAt: dueAt,
      requiredSample,
      ruleVersion,
      sourceAppealId,
      sourceAnomaly,
      status: "open",
      createdAt: this.clock(),
      evidence: [], // {type, ref, note, by, at}
      reaudit: null,
      closure: null,
    };
    for (const e of evidence) this.addEvidence(action.id, e);
    this.actions.push(action);
    return action;
  }

  addEvidence(actionId, { type, ref, note = "", by = "qc" }) {
    const action = this.requireAction(actionId);
    const record = { type, ref, note, by, at: this.clock() };
    action.evidence.push(record);
    return record;
  }

  requireAction(actionId) {
    const action = this.actions.find((a) => a.id === actionId);
    if (!action) throw new NotFoundError(`整改不存在: ${actionId}`);
    return action;
  }

  // 复测：只能用针对该问题分段（机构×班次×指标）的新样本，不得引用总体平均值
  submitReaudit(actionId, { sampleReferralIds, by = "qc", note = "" }) {
    const action = this.requireAction(actionId);
    if (action.status === "closed") throw new ConflictError("整改已关闭", "ACTION_CLOSED");
    const rule = getRule(action.ruleVersion);
    const samples = [];
    for (const id of sampleReferralIds) {
      const journey = this.getJourney(id);
      if (journey.status === "open") continue; // 在诊个案不得进入复测
      if (action.origin && journey.origin !== action.origin) {
        throw new RuleViolationError(`复测样本不属于责任机构: ${id}`, { expectedOrigin: action.origin });
      }
      const row = computeJourneyMetrics(journey, rule);
      if (action.shift && row.shift !== action.shift) {
        throw new RuleViolationError(`复测样本不属于目标班次: ${id}`, { expectedShift: action.shift });
      }
      samples.push({ referral_id: id, cell: row.metrics[action.metric], shift: row.shift });
    }
    const applicable = samples.filter((s) => s.cell.status !== "n/a");
    const measured = applicable.filter((s) => s.cell.status !== "missing");
    const breaches = measured.filter((s) => s.cell.status === "breach").length;
    const missing = applicable.length - measured.length;
    action.reaudit = {
      by,
      note,
      at: this.clock(),
      n: applicable.length,
      measured: measured.length,
      breaches,
      missing,
      failureRate: applicable.length ? Number(((breaches + missing) / applicable.length).toFixed(4)) : null,
      samples: applicable.map((s) => ({
        referral_id: s.referral_id,
        status: s.cell.status,
        minutes: s.cell.minutes,
      })),
    };
    return action.reaudit;
  }

  closeAction(actionId, { by = "qc", closureNote = "" } = {}) {
    const action = this.requireAction(actionId);
    if (action.status === "closed") throw new ConflictError("整改已关闭", "ACTION_CLOSED");
    const failures = [];
    if (action.evidence.length === 0) failures.push("缺少整改证据");
    if (!action.reaudit) failures.push("尚未提交针对该问题分段的复测");
    if (action.reaudit) {
      const rule = getRule(action.ruleVersion);
      if (action.reaudit.n < Math.max(action.requiredSample, rule.reaudit.minSample)) {
        failures.push(`复测样本不足: ${action.reaudit.n} < 要求 ${Math.max(action.requiredSample, rule.reaudit.minSample)}`);
      }
      if ((action.reaudit.failureRate ?? 1) > rule.reaudit.maxBreachRate) {
        failures.push(`复测失败率 ${action.reaudit.failureRate} 高于阈值 ${rule.reaudit.maxBreachRate}`);
      }
    }
    if (failures.length > 0) {
      throw new RuleViolationError(
        `整改不满足关闭条件，禁止仅凭总体平均值关闭: ${failures.join("；")}`,
        { failures }
      );
    }
    action.status = "closed";
    action.closure = {
      by,
      at: this.clock(),
      note: closureNote,
      overdue: this.clock() > new Date(action.dueAt).toISOString(),
      reauditSnapshot: action.reaudit,
    };
    return action;
  }
}

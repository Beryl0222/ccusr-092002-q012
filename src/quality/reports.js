// 月度发布：冻结输入与排除清单；小样本机构不排名；异常指标可下钻到去标识事件、审查意见与整改证据；
// 历史月份按冻结的旅程版本 + 冻结规则书 + 冻结排除清单重放，必须得到同一 reportHash。
import { computeMetrics } from "./metrics.js";
import { ConflictError, NotFoundError } from "./errors.js";
import { getRule } from "./rules.js";
import { hashOf, minutesBetween, monthOf, shiftOf } from "./time.js";

// 从版本历史中精确取回冻结时那一版旅程；补正只会新增版本，旧版保留，故历史可重放。
function journeyVersionAt(svc, referralId, contentHash) {
  const entry = svc.journeys.get(referralId);
  if (!entry) return null;
  const hit = entry.versions.find((v) => v.journey.contentHash === contentHash);
  return hit ? hit.journey : null;
}

function pseudonymTable(ids) {
  const map = new Map();
  [...ids].sort().forEach((id, i) => map.set(id, `J${String(i + 1).padStart(3, "0")}`));
  return map;
}

function deidentifyEvents(journey, rule, refPseudo, actorPseudo) {
  const t0 = journey.events.find((e) => e.type === "order_created").at;
  return journey.events.map((e) => ({
    case: refPseudo.get(journey.referral_id),
    type: e.type,
    offsetMinutes: minutesBetween(t0, e.at),
    shift: shiftOf(e.at, rule),
    actor: e.actor ? actorPseudo(e.actor) : null,
  }));
}

// 去标识事件流：无姓名/证件/联系方式，转诊号与执行者全部伪名化，只保留相对时序与班次
function buildDrilldown(svc, frozenJourneys, rule, inputs, month) {
  const refPseudo = pseudonymTable(frozenJourneys.map((j) => j.referral_id));
  const actorCodes = new Map();
  const actorPseudo = (actor) => {
    if (!actorCodes.has(actor)) actorCodes.set(actor, `S${String(actorCodes.size + 1).padStart(2, "0")}`);
    return actorCodes.get(actor);
  };

  const byOriginShift = new Map();
  for (const j of frozenJourneys) {
    const anchor = j.events.find((e) => e.type === "arrival") ?? j.events.find((e) => e.type === "order_created");
    const key = `${j.origin}|${shiftOf(anchor.at, rule)}`;
    if (!byOriginShift.has(key)) byOriginShift.set(key, []);
    byOriginShift.get(key).push(j);
  }

  const drilldown = {};
  for (const [key, group] of byOriginShift) {
    const [origin, shift] = key.split("|");
    const ids = new Set(group.map((j) => j.referral_id));
    drilldown[key] = {
      origin,
      shift,
      cases: group.map((j) => ({
        case: refPseudo.get(j.referral_id),
        referralRef: j.referral_id, // 内部追溯用；对外导出时可剥离
        risk: j.risk,
        events: deidentifyEvents(j, rule, refPseudo, actorPseudo),
      })),
      reviews: [...svc.reviews.values()]
        .filter((r) => ids.has(r.referral_id))
        .map((r) => ({
          case: refPseudo.get(r.referral_id),
          status: r.status,
          annotations: r.annotations,
          adjudication: r.adjudication,
        })),
      appeals: svc.appeals
        .filter((a) => ids.has(a.referral_id))
        .map((a) => ({
          id: a.id,
          case: refPseudo.get(a.referral_id),
          grounds: a.grounds,
          status: a.status,
          decision: a.response?.decision ?? null,
          conclusionChanged: a.after ? a.after.hash !== a.before.hash : null,
        })),
      actions: svc.actions
        .filter((p) => p.origin === origin && (!p.shift || p.shift === shift))
        .map((p) => ({
          id: p.id,
          title: p.title,
          owner: p.owner,
          dueAt: p.dueAt,
          status: p.status,
          evidenceCount: p.evidence.length,
          evidence: p.evidence,
          reaudit: p.reaudit
            ? {
                n: p.reaudit.n,
                breaches: p.reaudit.breaches,
                missing: p.reaudit.missing,
                failureRate: p.reaudit.failureRate,
              }
            : null,
        })),
    };
  }
  return { drilldown, pseudonyms: { referrals: Object.fromEntries(refPseudo), actors: Object.fromEntries(actorCodes) } };
}

// 组装（或重放）某月报告。frozen 为 null 表示首次发布；重放时传入冻结清单。
function assemble(svc, month, ruleVersion, frozen) {
  const rule = getRule(ruleVersion);
  const all = [...svc.journeys.values()].map((e) => e.current).filter((j) => j.status === "closed");

  let inputs;
  let journeys;
  if (frozen) {
    inputs = frozen.inputs;
    journeys = frozen.inputs
      .map((spec) => journeyVersionAt(svc, spec.referral_id, spec.contentHash))
      .filter(Boolean);
    const missing = frozen.inputs.filter(
      (spec) => !journeyVersionAt(svc, spec.referral_id, spec.contentHash)
    );
    if (missing.length > 0) {
      throw new ConflictError("冻结的旅程版本已缺失，无法如实重放", { missing });
    }
  } else {
    journeys = all.filter((j) => monthOf(j.events[0].at) === month);
    inputs = journeys
      .map((j) => {
        const anchor = j.events.find((e) => e.type === "arrival") ?? j.events.find((e) => e.type === "order_created");
        return {
          referral_id: j.referral_id,
          contentHash: j.contentHash,
          origin: j.origin,
          risk: j.risk,
          shift: shiftOf(anchor.at, rule),
        };
      })
      .sort((a, b) => a.referral_id.localeCompare(b.referral_id));
  }

  const exclusions = frozen
    ? frozen.exclusions
    : [...svc.exclusions.values()]
        .filter((x) => x.month === month)
        .sort((a, b) => a.referral_id.localeCompare(b.referral_id));
  const exclusionMap = new Map(exclusions.map((x) => [x.referral_id, { code: x.code, reason: x.reason }]));

  const metrics = computeMetrics(journeys, rule, { exclusions: exclusionMap });
  const { drilldown, pseudonyms } = buildDrilldown(svc, journeys, rule, inputs, month);

  const freeze = {
    inputs,
    inputHash: hashOf(inputs),
    exclusions,
    exclusionHash: hashOf(exclusions),
  };
  const reportHash = hashOf({
    month,
    ruleVersion,
    inputHash: freeze.inputHash,
    exclusionHash: freeze.exclusionHash,
    rows: metrics.rows,
  });

  return {
    month,
    ruleVersion,
    freeze,
    metrics: {
      generatedFrom: metrics.generatedFrom,
      overall: metrics.overall,
      segments: metrics.segments,
      arrivalCoverage: metrics.arrivalCoverage,
      anomalies: metrics.anomalies,
      ranking: metrics.ranking,
      suppressedOrigins: metrics.suppressedOrigins,
      exclusions: metrics.exclusions,
      rows: metrics.rows,
    },
    drilldown,
    pseudonyms,
    reportHash,
  };
}

export function publishMonthlyReport(svc, month, { ruleVersion, publishedBy = "qc" } = {}) {
  if (svc.reports.has(month)) {
    throw new ConflictError(`月份报告已冻结发布，不可覆写: ${month}`, "REPORT_FROZEN");
  }
  const report = assemble(svc, month, ruleVersion, null);
  report.publishedAt = svc.clock();
  report.publishedBy = publishedBy;
  svc.reports.set(month, report);
  return report;
}

export function replayReport(svc, month) {
  const frozen = svc.reports.get(month);
  if (!frozen) throw new NotFoundError(`无已冻结的月报: ${month}`);
  const recomputed = assemble(svc, month, frozen.ruleVersion, frozen.freeze);
  return {
    month,
    frozenHash: frozen.reportHash,
    replayedHash: recomputed.reportHash,
    consistent: frozen.reportHash === recomputed.reportHash,
    frozenAt: frozen.publishedAt,
    ruleVersion: frozen.ruleVersion,
    report: recomputed,
  };
}

export function getReport(svc, month) {
  const report = svc.reports.get(month);
  if (!report) throw new NotFoundError(`无已冻结的月报: ${month}`);
  return report;
}

// 运行时下钻（未发布也可对当前数据下钻）；发布后下钻请使用报告内冻结的 drilldown。
export function liveDrilldown(svc, { origin, shift, metric = null, ruleVersion } = {}) {
  const rule = getRule(ruleVersion);
  const journeys = [...svc.journeys.values()]
    .map((e) => e.current)
    .filter((j) => j.status === "closed")
    .filter((j) => j.origin === origin)
    .filter((j) => {
      if (!shift) return true;
      const anchor = j.events.find((e) => e.type === "arrival") ?? j.events.find((e) => e.type === "order_created");
      return shiftOf(anchor.at, rule) === shift;
    });
  const { drilldown } = buildDrilldown(svc, journeys, rule, null, null);
  const cells = Object.values(drilldown).filter(
    (d) => d.origin === origin && (!shift || d.shift === shift)
  );
  if (metric) return { metric, cells };
  return { cells };
}

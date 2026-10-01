// referral-quality 独立 HTTP 服务。所有质控写操作对在诊(open)个案返回 409。
import http from "node:http";
import { URL } from "node:url";
import { QualityService } from "./service.js";
import { latestRuleVersion, METRIC_KEYS, RULEBOOKS } from "./rules.js";
import {
  getReport,
  liveDrilldown,
  publishMonthlyReport,
  replayReport,
} from "./reports.js";

export const qualityServiceId = "referral-quality";
export const qualityServiceName = "转诊质量改进服务";

export function healthPayload() {
  return {
    status: "ok",
    service: qualityServiceId,
    name: qualityServiceName,
    boundary: "只读消费脱敏转诊单与已关闭旅程，不干预临床路线",
  };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(Object.assign(new Error("请求体过大"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("JSON 无法解析"), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function errorStatus(err) {
  return err.statusCode ?? 500;
}

function errorBody(err) {
  return {
    error: err.message,
    code: err.code ?? err.name,
    ...(err.details ? { details: err.details } : {}),
  };
}

export function createQualityServer(service = new QualityService()) {
  // 路由：[method, pattern(matcher 返回 params 或 null), handler]
  const routes = [];
  const route = (method, matcher, handler) => routes.push({ method, matcher, handler });

  const seg = (path) => path.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  const exact = (p) => {
    const target = seg(p);
    return (parts) => (target.length === parts.length && target.every((t, i) => t.startsWith(":") || t === parts[i])
      ? Object.fromEntries(target.map((t, i) => [t.slice(1), parts[i]]).filter(([t]) => t))
      : null);
  };

  route("GET", exact("/health"), async () => [200, healthPayload()]);
  route("GET", exact("/v1/rulebook"), async (p, q) => {
    const v = q.get("version");
    if (v) {
      const book = RULEBOOKS[v];
      if (!book) return [404, { error: `未知规则版本: ${v}`, known: Object.keys(RULEBOOKS) }];
      return [200, book];
    }
    return [200, { versions: Object.keys(RULEBOOKS), latest: latestRuleVersion() }];
  });

  route("POST", exact("/v1/referrals"), async (p, q, body) => [202, service.ingestReferral(body)]);
  route("POST", exact("/v1/journeys"), async (p, q, body) => [202, service.ingestJourney(body)]);
  route("POST", exact("/v1/journeys/:id/corrections"), async (p, q, body) => [
    200,
    service.submitCorrection(p.id, body.journey ?? body, { submittedBy: body.submittedBy, note: body.note }),
  ]);
  route("GET", exact("/v1/journeys/:id"), async (p) => [200, service.getJourney(p.id)]);
  route("GET", exact("/v1/journeys/:id/conclusion"), async (p, q) => {
    const result = service.caseConclusion(p.id, q.get("ruleVersion") ?? latestRuleVersion());
    return [200, { referral_id: result.referral_id, ruleVersion: result.ruleVersion, contentHash: result.contentHash, cells: result.cells }];
  });

  route("GET", exact("/v1/metrics"), async (p, q) => [
    200,
    service.currentMetrics({ ruleVersion: q.get("ruleVersion") ?? latestRuleVersion(), month: q.get("month") }),
  ]);

  route("POST", exact("/v1/exclusions"), async (p, q, body) => [
    201,
    service.addExclusion(body.referral_id, { code: body.code, reason: body.reason, by: body.by }),
  ]);
  route("DELETE", exact("/v1/exclusions/:id"), async (p, q, body) => [
    200,
    service.removeExclusion(p.id, { by: body?.by }),
  ]);

  route("POST", exact("/v1/review-queues"), async (p, q, body) => [201, service.createReviewQueue(body)]);
  route("GET", exact("/v1/review-queues/:id"), async (p) => {
    const queue = service.queues.get(p.id);
    if (!queue) return [404, { error: `队列不存在: ${p.id}` }];
    return [200, queue];
  });
  route("POST", exact("/v1/reviews/:caseId/annotations"), async (p, q, body) => [
    200,
    service.annotateRootCause(p.caseId, body),
  ]);
  route("POST", exact("/v1/reviews/:caseId/adjudication"), async (p, q, body) => [
    200,
    service.adjudicate(p.caseId, body),
  ]);

  route("POST", exact("/v1/appeals"), async (p, q, body) => [201, service.appeal(body.case_id ?? body.referral_id, body)]);
  route("POST", exact("/v1/appeals/:id/response"), async (p, q, body) => [200, service.respondAppeal(p.id, body)]);
  route("GET", exact("/v1/appeals"), async () => [200, service.appeals]);

  route("POST", exact("/v1/caliber-changes"), async (p, q, body) => [201, service.recordCaliberChange(body)]);
  route("GET", exact("/v1/caliber-changes"), async () => [200, service.caliberChanges]);

  route("POST", exact("/v1/actions"), async (p, q, body) => [201, service.createAction(body)]);
  route("GET", exact("/v1/actions"), async () => [200, service.actions]);
  route("POST", exact("/v1/actions/:id/evidence"), async (p, q, body) => [201, service.addEvidence(p.id, body)]);
  route("POST", exact("/v1/actions/:id/reaudit"), async (p, q, body) => [200, service.submitReaudit(p.id, body)]);
  route("POST", exact("/v1/actions/:id/close"), async (p, q, body) => [200, service.closeAction(p.id, body)]);

  route("POST", exact("/v1/reports/:month/publish"), async (p, q, body) => [
    201,
    publishMonthlyReport(service, p.month, { ruleVersion: body.ruleVersion ?? latestRuleVersion(), publishedBy: body.publishedBy }),
  ]);
  route("GET", exact("/v1/reports/:month"), async (p) => [200, getReport(service, p.month)]);
  route("POST", exact("/v1/reports/:month/replay"), async (p) => [200, replayReport(service, p.month)]);
  route("GET", exact("/v1/drilldown"), async (p, q) => [
    200,
    liveDrilldown(service, {
      origin: q.get("origin"),
      shift: q.get("shift"),
      metric: q.get("metric") && METRIC_KEYS.includes(q.get("metric")) ? q.get("metric") : null,
      ruleVersion: q.get("ruleVersion") ?? latestRuleVersion(),
    }),
  ]);

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const parts = seg(url.pathname);
      let body;
      if (request.method === "POST" || request.method === "DELETE" || request.method === "PUT") {
        body = await readJson(request);
      }
      for (const r of routes) {
        if (r.method !== request.method) continue;
        const params = r.matcher(parts);
        if (params === null) continue;
        const [status, payload] = await r.handler(params, url.searchParams, body ?? {});
        send(response, status, payload);
        return;
      }
      send(response, 404, { error: "未找到资源" });
    } catch (err) {
      send(response, errorStatus(err), errorBody(err));
    }
  });
}

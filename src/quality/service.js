// 转诊质量改进服务（质控科，独立于 referral-concierge）。
// 边界：临床旅程只读接入；本服务不提供任何改道/变更路线端点，
// 所有写操作都落在质控侧（补正、审查、申诉、整改、冻结）。

import http from "node:http";
import { pathToFileURL } from "node:url";

import { createQualityApp, QualityError } from "./quality.js";
import { buildReport, freezeMonth, replayMonth } from "./report.js";
import { SERVICE_ID } from "./rules.js";
import { createStore } from "./store.js";

export const serviceId = SERVICE_ID;
export const serviceName = "转诊质量改进服务";

export function healthPayload() {
  return { status: "ok", service: serviceId, name: serviceName, scope: "quality-control" };
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  if (!raw) return {};
  return JSON.parse(raw);
}

export function createQualityServer({ store, app, now } = {}) {
  const dataStore = store ?? createStore();
  const quality = app ?? createQualityApp(dataStore, now ? { now } : {});

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const p = url.pathname;
    const method = request.method;

    try {
      // GET /health
      if (method === "GET" && p === "/health") return json(response, 200, healthPayload());

      // GET /report?month=YYYY-MM —— 当月（未冻结）实时视图
      if (method === "GET" && p === "/report") {
        const month = url.searchParams.get("month");
        if (!month) throw new QualityError(400, "需要 month=YYYY-MM");
        return json(response, 200, buildReport(dataStore.replay(), month));
      }

      // POST /months/:month/freeze —— 冻结输入与排除清单
      const freezeMatch = p.match(/^\/months\/(\d{4}-\d{2})\/freeze$/);
      if (method === "POST" && freezeMatch) {
        const body = await readJson(request);
        return json(response, 201, freezeMonth(dataStore, quality, freezeMatch[1], { by: body.by }));
      }

      // GET /months/:month/replay —— 重放历史月份并校验一致性
      const replayMatch = p.match(/^\/months\/(\d{4}-\d{2})\/replay$/);
      if (method === "GET" && replayMatch) {
        return json(response, 200, replayMonth(dataStore, replayMatch[1]));
      }

      // POST /journeys —— 录入脱敏转诊单/已关闭旅程
      if (method === "POST" && p === "/journeys") {
        const body = await readJson(request);
        const ev = quality.recordJourney(body);
        return json(response, 201, { recorded: true, seq: ev.seq });
      }

      // POST /journeys/:id/amendments —— 资料补正（保留前后）
      const amendMatch = p.match(/^\/journeys\/([^/]+)\/amendments$/);
      if (method === "POST" && amendMatch) {
        const body = await readJson(request);
        quality.amendDocuments(decodeURIComponent(amendMatch[1]), body);
        return json(response, 201, { amended: true });
      }

      // 排除清单
      if (method === "POST" && p === "/exclusions") {
        const body = await readJson(request);
        quality.addExclusion(body.id, body);
        return json(response, 201, { excluded: true });
      }
      const exclRevoke = p.match(/^\/exclusions\/([^/]+)\/revoke$/);
      if (method === "POST" && exclRevoke) {
        const body = await readJson(request);
        quality.revokeExclusion(decodeURIComponent(exclRevoke[1]), body);
        return json(response, 200, { revoked: true });
      }

      // 审查队列
      if (method === "POST" && p === "/queues") {
        const body = await readJson(request);
        return json(response, 201, quality.createQueue(body));
      }
      if (method === "POST" && p === "/reviews") {
        const body = await readJson(request);
        const review_id = quality.openReview(body);
        return json(response, 201, { review_id });
      }
      if (method === "POST" && p === "/annotations") {
        const body = await readJson(request);
        return json(response, 201, quality.annotate(body));
      }
      if (method === "POST" && p === "/adjudications") {
        const body = await readJson(request);
        return json(response, 201, quality.adjudicate(body));
      }

      // 申诉
      if (method === "POST" && p === "/appeals") {
        const body = await readJson(request);
        const appeal_id = quality.fileAppeal(body);
        return json(response, 201, { appeal_id });
      }
      const appealResolve = p.match(/^\/appeals\/([^/]+)\/resolve$/);
      if (method === "POST" && appealResolve) {
        const body = await readJson(request);
        return json(response, 200, quality.resolveAppeal(decodeURIComponent(appealResolve[1]), body));
      }

      // 整改闭环
      if (method === "POST" && p === "/actions") {
        const body = await readJson(request);
        const action_id = quality.createAction(body);
        return json(response, 201, { action_id });
      }
      const evidenceMatch = p.match(/^\/actions\/([^/]+)\/evidence$/);
      if (method === "POST" && evidenceMatch) {
        const body = await readJson(request);
        quality.addEvidence(decodeURIComponent(evidenceMatch[1]), body);
        return json(response, 201, { evidence_added: true });
      }
      const retestMatch = p.match(/^\/actions\/([^/]+)\/retests$/);
      if (method === "POST" && retestMatch) {
        const body = await readJson(request);
        quality.recordRetest(decodeURIComponent(retestMatch[1]), body);
        return json(response, 201, { retest_recorded: true });
      }
      const closeMatch = p.match(/^\/actions\/([^/]+)\/close$/);
      if (method === "POST" && closeMatch) {
        const body = await readJson(request);
        return json(response, 200, quality.closeAction(decodeURIComponent(closeMatch[1]), body));
      }

      // 下钻：异常指标 → 去标识事件 → 审查意见 → 整改证据
      const drillMatch = p.match(/^\/drilldown\/([^/]+)\/([a-z_]+)$/);
      if (method === "GET" && drillMatch) {
        const asOf = url.searchParams.get("as_of_seq");
        return json(
          response,
          200,
          quality.drilldown(decodeURIComponent(drillMatch[1]), drillMatch[2], {
            asOfSeq: asOf ? Number(asOf) : Infinity,
          })
        );
      }

      return json(response, 404, { error: "未找到资源" });
    } catch (err) {
      if (err instanceof QualityError) return json(response, err.status, { error: err.message });
      if (err instanceof SyntaxError) return json(response, 400, { error: "请求体不是合法 JSON" });
      if (err.status) return json(response, err.status, { error: err.message });
      return json(response, 500, { error: `内部错误: ${err.message}` });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== serviceId) process.exit(1);
    console.log("质量服务检查通过");
  } else {
    const portIndex = process.argv.indexOf("--port");
    const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8001;
    const dataDirIndex = process.argv.indexOf("--data");
    const dataDir = dataDirIndex >= 0 ? process.argv[dataDirIndex + 1] : "data/quality";
    const store = createStore({ dir: dataDir });
    createQualityServer({ store }).listen(port, "0.0.0.0");
    console.log(`${serviceName} 监听 ${port}（数据目录 ${dataDir}）`);
  }
}

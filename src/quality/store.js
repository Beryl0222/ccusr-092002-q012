// 追加式事件存储（JSONL）。任何更正都以新事件叠加，不修改既往记录；
// 月报记录事件流位置与输入/排除清单哈希，重放至该位置即得当时一致的报告。

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

export function canonicalHash(value) {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

export function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---- 旅程归约：原始单 + 叠加补正，补正不覆盖原值 ----

export function applyAmendments(raw, amendments) {
  const docs = [...(raw.documents ?? [])];
  const patch = {};
  for (const a of amendments) {
    for (const d of a.documents ?? []) docs.push(d);
    Object.assign(patch, a.patch ?? {});
  }
  // 同类资料取最晚上传版本，但历史版本仍保留在 raw/amendments 中可查
  const latest = new Map();
  for (const d of docs) {
    const prev = latest.get(d.type);
    if (!prev || Date.parse(d.uploaded_at) > Date.parse(prev.uploaded_at)) latest.set(d.type, d);
  }
  return {
    ...raw,
    ...patch,
    documents: [...latest.values()].sort(
      (a, b) => Date.parse(a.uploaded_at) - Date.parse(b.uploaded_at)
    ),
  };
}

function reduce(state, event) {
  const { type, seq, ts, payload } = event;
  switch (type) {
    case "journey_recorded": {
      state.journeys.set(payload.referral_id, {
        raw: payload,
        recorded_seq: seq,
        recorded_at: ts,
        amendments: [],
      });
      break;
    }
    case "journey_amended": {
      const j = state.journeys.get(payload.referral_id);
      if (j) j.amendments.push({ seq, at: ts, ...payload });
      break;
    }
    case "exclusion_added": {
      state.exclusions.set(payload.id, { ...payload, active: true, seq });
      break;
    }
    case "exclusion_revoked": {
      const ex = state.exclusions.get(payload.id);
      if (ex) {
        ex.active = false;
        ex.revoked_at = ts;
        ex.revoked_seq = seq;
      }
      break;
    }
    case "appeal_filed": {
      state.appeals.set(payload.appeal_id, { ...payload, seq, status: "filed" });
      break;
    }
    case "appeal_resolved": {
      const a = state.appeals.get(payload.appeal_id);
      if (a) {
        a.status = payload.upheld ? "upheld" : "rejected";
        a.resolution = payload;
        a.resolved_at = ts;
      }
      break;
    }
    case "queue_sampled": {
      state.queues.set(payload.queue_id, { ...payload, seq });
      break;
    }
    case "review_opened": {
      state.reviews.set(payload.review_id, {
        ...payload,
        annotations: [],
        adjudication: null,
        opened_seq: seq,
      });
      break;
    }
    case "annotation_added": {
      const r = state.reviews.get(payload.review_id);
      if (r) r.annotations.push({ seq, at: ts, ...payload });
      break;
    }
    case "adjudication_added": {
      const r = state.reviews.get(payload.review_id);
      if (r) r.adjudication = { seq, at: ts, ...payload };
      break;
    }
    case "action_created": {
      state.actions.set(payload.action_id, {
        ...payload,
        evidence: [],
        retests: [],
        status: "open",
        created_seq: seq,
      });
      break;
    }
    case "evidence_added": {
      const a = state.actions.get(payload.action_id);
      if (a) a.evidence.push({ seq, at: ts, ...payload });
      break;
    }
    case "retest_recorded": {
      const a = state.actions.get(payload.action_id);
      if (a) a.retests.push({ seq, at: ts, ...payload });
      break;
    }
    case "action_closed": {
      const a = state.actions.get(payload.action_id);
      if (a) {
        a.status = "closed";
        a.closure = { seq, at: ts, ...payload };
      }
      break;
    }
    case "action_reopened": {
      const a = state.actions.get(payload.action_id);
      if (a) {
        a.status = "open";
        a.closure = null;
        a.reopen = { seq, at: ts, ...payload };
      }
      break;
    }
    case "month_frozen": {
      state.freezes.set(payload.month, { ...payload, frozen_seq: seq });
      break;
    }
    default:
      break;
  }
  return state
}

function emptyState() {
  return {
    journeys: new Map(),
    exclusions: new Map(),
    appeals: new Map(),
    queues: new Map(),
    reviews: new Map(),
    actions: new Map(),
    freezes: new Map(),
  };
}

export function createStore({ dir = "data/quality", file = "events.jsonl" } = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);

  const readEvents = () => {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };

  const replay = (uptoSeq = Infinity) => {
    const state = emptyState();
    for (const e of readEvents()) {
      if (e.seq > uptoSeq) break;
      reduce(state, e);
    }
    return state;
  };

  const append = (type, payload, { at } = {}) => {
    const events = readEvents();
    const seq = events.length ? events[events.length - 1].seq + 1 : 1;
    const event = { seq, ts: at ?? new Date().toISOString(), type, payload };
    appendFileSync(path, `${JSON.stringify(event)}\n`);
    return event;
  };

  return { path, append, replay, headSeq: () => readEvents().length };
}

// 组装某转诊在给定状态下的有效旅程（应用全部补正）
export function effectiveJourney(state, referralId) {
  const entry = state.journeys.get(referralId);
  if (!entry) return null;
  return applyAmendments(entry.raw, entry.amendments);
}

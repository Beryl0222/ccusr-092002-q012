// 测试夹具：用相对偏移构造脱敏旅程，集中管理事件与执行者。
import { validateJourney } from "../../src/quality/ingest.js";
const ACTORS = {
  materials_requested: "转诊管家",
  materials_complete: "基层联络员",
  first_contact: "转诊管家",
  handoff: "急诊护士",
  escalation: "急诊医生",
  rerouted: "专科医生",
  down_transfer: "随访护士",
  down_confirmed: "基层联络员",
  followup_complete: "随访护士",
};

const NO_ACTOR = new Set(["arrival"]);

function isoAt(baseMs, offsetMinutes) {
  return new Date(baseMs + offsetMinutes * 60000).toISOString();
}

// offsets: { 事件类型: 距 order_created 的分钟数 }；值为 null/缺省即该事件未发生
export function makeJourney({
  id,
  origin = "太姥山镇卫生院",
  risk = "low",
  status = "closed",
  t0 = "2026-09-10T08:00:00+08:00",
  offsets = {},
  reason = "测试病例",
  withWindow = false,
}) {
  const base = Date.parse(t0);
  const events = [{ type: "order_created", at: new Date(base).toISOString() }];
  for (const [type, offset] of Object.entries(offsets)) {
    if (offset === null || offset === undefined) continue;
    const event = { type, at: isoAt(base, offset) };
    if (!NO_ACTOR.has(type)) event.actor = ACTORS[type] ?? "经办人";
    events.push(event);
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const journey = { referral_id: id, origin, risk, status, reason, events };
  if (withWindow) {
    const arrivalOffset = offsets.arrival ?? 60;
    journey.arrival_window = [isoAt(base, arrivalOffset), isoAt(base, arrivalOffset + 60)];
  }
  return journey;
}

// 指标引擎消费校验后的旅程（at 已解析为毫秒、带内容指纹）
export const validated = (j) => validateJourney(j);

// 一套九月数据：A 机构多数正常；B 机构夜班反复漏传资料、到院无人交接；C 机构样本过少。
export function septemberDataset() {
  const journeys = [];
  // A 机构：3 个白班良好病例（交接均在 15 分钟内）
  for (let i = 1; i <= 3; i += 1) {
    journeys.push(
      makeJourney({
        id: `FD-A${i}`,
        origin: "太姥山镇卫生院",
        risk: i === 3 ? "high" : "medium",
        t0: `2026-09-0${i + 2}T08:00:00+08:00`,
        offsets: {
          materials_requested: 2,
          materials_complete: 30,
          first_contact: 20,
          arrival: 40,
          handoff: 48,
          down_transfer: 3 * 24 * 60,
          down_confirmed: 3 * 24 * 60 + 60,
          followup_complete: 6 * 24 * 60,
        },
      })
    );
  }
  // A 机构：1 例危急升级，20 分钟完成改道
  journeys.push(
    makeJourney({
      id: "FD-A4",
      origin: "太姥山镇卫生院",
      risk: "critical",
      t0: "2026-09-08T09:00:00+08:00",
      offsets: {
        materials_complete: 25,
        first_contact: 10,
        arrival: 30,
        handoff: 35,
        escalation: 50,
        rerouted: 70,
      },
    })
  );

  // A 机构：再补 2 个白班良好病例，使其达到公开排名样本门槛
  for (const [i, day] of [
    [5, "2026-09-10T08:00:00+08:00"],
    [6, "2026-09-11T08:00:00+08:00"],
  ]) {
    journeys.push(
      makeJourney({
        id: `FD-A${i}`,
        origin: "太姥山镇卫生院",
        risk: "medium",
        t0: day,
        offsets: {
          materials_complete: 25,
          first_contact: 15,
          arrival: 35,
          handoff: 42,
          down_transfer: 3 * 24 * 60,
          down_confirmed: 3 * 24 * 60 + 40,
          followup_complete: 5 * 24 * 60,
        },
      })
    );
  }

  // B 机构：3 个夜班病例，反复漏传资料 + 到院无人交接
  for (let i = 1; i <= 3; i += 1) {
    journeys.push(
      makeJourney({
        id: `FD-B${i}`,
        origin: "店下镇卫生院",
        risk: "high",
        t0: `2026-09-0${i + 4}T21:00:00+08:00`,
        offsets: {
          first_contact: 45, // 超过 30 分钟 SLA
          arrival: 30,
          // 无 materials_complete、无 handoff
        },
      })
    );
  }
  // B 机构：1 例夜班危急升级，50 分钟才改道
  journeys.push(
    makeJourney({
      id: "FD-B4",
      origin: "店下镇卫生院",
      risk: "critical",
      t0: "2026-09-09T22:00:00+08:00",
      offsets: {
        materials_complete: 20,
        first_contact: 15,
        arrival: 25,
        escalation: 40,
        rerouted: 90,
      },
    })
  );

  // B 机构：第 5 例夜班，漏资料、无人接应，使其达到公开排名样本门槛
  journeys.push(
    makeJourney({
      id: "FD-B5",
      origin: "店下镇卫生院",
      risk: "high",
      t0: "2026-09-12T20:30:00+08:00",
      offsets: {
        first_contact: 40,
        arrival: 20,
      },
    })
  );

  // C 机构：仅 2 例，样本过少不公开排名
  for (let i = 1; i <= 2; i += 1) {
    journeys.push(
      makeJourney({
        id: `FD-C${i}`,
        origin: "嵛山岛卫生院",
        risk: "low",
        t0: `2026-09-1${i}T08:30:00+08:00`,
        offsets: { materials_complete: 40, first_contact: 25, arrival: 50, handoff: 58 },
      })
    );
  }
  return journeys;
}

// 十月数据：首次联系多在 21~25 分钟（9 月口径达标、10 月收紧后超标）
export function octoberDataset() {
  const journeys = [];
  for (let i = 1; i <= 6; i += 1) {
    journeys.push(
      makeJourney({
        id: `FD-O${i}`,
        origin: i % 2 ? "太姥山镇卫生院" : "店下镇卫生院",
        risk: "medium",
        t0: `2026-10-0${i}T08:00:00+08:00`,
        offsets: {
          materials_complete: 30,
          first_contact: 25, // 9 月 SLA 30 达标；10 月 SLA 20 超标
          arrival: 40,
          handoff: 55, // 15 分钟；10 月口径 10 分钟超标
        },
      })
    );
  }
  return journeys;
}

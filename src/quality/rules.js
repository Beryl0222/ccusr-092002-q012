// 转诊质量指标口径，按规则版本计算。
// 新版本只能追加，不得修改已发布版本——历史月份重放必须得到当时一致的结论。

export const SERVICE_ID = "referral-quality-improvement";

// 班次按到院时刻（东八区）划分
export const SHIFTS = {
  day: { label: "白班", fromHour: 8, toHour: 16 },
  evening: { label: "小夜班", fromHour: 16, toHour: 24 },
  night: { label: "大夜班", fromHour: 0, toHour: 8 },
};

// 需要升级响应的风险层级（其余层级无升级事件记为不适用而非缺失）
export const ESCALATION_REQUIRED_RISKS = ["high", "critical"];

// 六个时间指标的稳定标识，冻结报告与下钻均以此为准，禁止改名
export const METRIC_KEYS = [
  "docs_ready", // 资料齐备
  "first_contact", // 首次联系
  "handover_wait", // 到院交接
  "escalation_response", // 风险改道（危急升级）
  "downgrade_confirm", // 下转确认
  "followup_completion", // 随访完成
];

export const METRIC_META = {
  docs_ready: {
    label: "资料齐备时长",
    description: "转诊下单到必备资料全部上传；须在预计到院起点前齐备。",
    unit: "minute",
    start: "created_at",
  },
  first_contact: {
    label: "首次联系时延",
    description: "转诊下单到转诊管家首次联系患者/基层。",
    unit: "minute",
    start: "created_at",
  },
  handover_wait: {
    label: "到院交接等待",
    description: "患者到院到完成交接，用于识别到院时段无人接应。",
    unit: "minute",
    start: "arrived",
  },
  escalation_response: {
    label: "危急升级响应",
    description: "危急升级请求到启动改道的时长。",
    unit: "minute",
    start: "escalation.requested_at",
  },
  downgrade_confirm: {
    label: "下转确认时长",
    description: "发起下转到基层接收确认。",
    unit: "hour",
    start: "downgrade_sent",
  },
  followup_completion: {
    label: "随访完成时长",
    description: "旅程关闭到完成随访，须在规则窗口内完成。",
    unit: "day",
    start: "closed_at",
  },
};

// 仅允许追加新版本。effective_from 为该口径生效的转诊创建起点（含）。
export const RULE_VERSIONS = [
  {
    version: "v1",
    label: "首版口径",
    effective_from: "2026-09-01T00:00:00+08:00",
    required_documents: ["转诊单", "检查资料", "用药记录"],
    sla: {
      docs_ready: "by_arrival", // 特殊阈值：到达窗口起点前齐备
      first_contact_minutes: 30,
      handover_wait_minutes: 20,
      escalation_response_minutes: 30,
      downgrade_confirm_hours: 48,
      followup_window_days: 14,
    },
    // 机构公开排名所需的最小已关闭样本量，不足者只列数据不排名
    min_sample_for_ranking: 5,
  },
  {
    version: "v2",
    label: "收紧接应与升级口径",
    effective_from: "2026-10-01T00:00:00+08:00",
    // 新增“风险评估表”，基层反复漏传可被直接识别
    required_documents: ["转诊单", "检查资料", "用药记录", "风险评估表"],
    sla: {
      docs_ready: "by_arrival",
      first_contact_minutes: 15,
      handover_wait_minutes: 10,
      escalation_response_minutes: 15,
      downgrade_confirm_hours: 24,
      followup_window_days: 7,
    },
    min_sample_for_ranking: 5,
  },
];

export function ruleAt(dateInput) {
  const t = Date.parse(dateInput);
  if (Number.isNaN(t)) throw new Error(`无法解析时间: ${dateInput}`);
  let chosen = RULE_VERSIONS[0];
  for (const rule of RULE_VERSIONS) {
    if (Date.parse(rule.effective_from) <= t) chosen = rule;
  }
  return chosen;
}

export function getRule(version) {
  const rule = RULE_VERSIONS.find((r) => r.version === version);
  if (!rule) throw new Error(`未知规则版本: ${version}`);
  return rule;
}

// 东八区班次（样例时间均带 +08:00，按本地时钟划班）
export function shiftOf(dateInput) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) throw new Error(`无法解析时间: ${dateInput}`);
  const hour = (d.getUTCHours() + 8) % 24;
  if (hour >= 8 && hour < 16) return "day";
  if (hour >= 16) return "evening";
  return "night";
}

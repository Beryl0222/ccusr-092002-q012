// 指标口径规则书。口径调整 = 新增规则版本，绝不就地改旧版本；
// 月报按发布时冻结的版本计算，历史月份重放仍得到当时结论。

export const METRIC_KEYS = [
  "materials_ready", // 资料齐备时长
  "first_contact", // 首次联系时长
  "arrival_handoff", // 到院交接等待
  "escalation_wait", // 危急升级后改道等待
  "down_confirmation", // 下转确认时长
  "followup_completion", // 随访完成时长
];

export const METRIC_LABELS = {
  materials_ready: "资料齐备时长",
  first_contact: "首次联系时长",
  arrival_handoff: "到院交接等待",
  escalation_wait: "危急改道等待",
  down_confirmation: "下转确认时长",
  followup_completion: "随访完成时长",
};

export const RULEBOOKS = {
  "qc-rules-2026-09": {
    version: "qc-rules-2026-09",
    predecessor: null,
    effectiveFrom: "2026-09-01",
    shifts: [
      { code: "day", label: "白班", startHour: 8, endHour: 20 },
      { code: "night", label: "夜班", startHour: 20, endHour: 32 },
    ],
    slaMinutes: {
      materials_ready: 60,
      first_contact: 30,
      arrival_handoff: 15,
      escalation_wait: 30,
      down_confirmation: 1440,
      followup_completion: 4320,
    },
    // 少于该样本量的基层点不公开排名
    minRankSample: 5,
    anomaly: {
      minCellN: 3,
      breachRatio: 1.5, // 分段 breach_rate ≥ 总体 1.5 倍
      missingRate: 0.3, // 或分段缺失率 ≥ 30%（反复漏传/无人接应）
    },
    // 整改复测：必须用该分段自身的复测样本，不得引用总体平均值
    reaudit: { minSample: 5, maxBreachRate: 0.2 },
    allowedExclusions: ["patient_cancelled", "duplicate_order", "test_record", "outside_period"],
  },

  // 口径调整示例版：10 月起首次联系 SLA 由 30 分钟收紧到 20 分钟，
  // 到院交接 SLA 由 15 分钟收紧到 10 分钟；公开排名最小样本由 5 提到 8。
  // 旧版保留：9 月已冻结报告仍按 2026-09 口径重放，新结论只作用于 10 月及以后。
  "qc-rules-2026-10": {
    version: "qc-rules-2026-10",
    predecessor: "qc-rules-2026-09",
    effectiveFrom: "2026-10-01",
    shifts: [
      { code: "day", label: "白班", startHour: 8, endHour: 20 },
      { code: "night", label: "夜班", startHour: 20, endHour: 32 },
    ],
    slaMinutes: {
      materials_ready: 60,
      first_contact: 20,
      arrival_handoff: 10,
      escalation_wait: 30,
      down_confirmation: 1440,
      followup_completion: 4320,
    },
    minRankSample: 8,
    anomaly: {
      minCellN: 3,
      breachRatio: 1.5,
      missingRate: 0.3,
    },
    reaudit: { minSample: 5, maxBreachRate: 0.2 },
    allowedExclusions: ["patient_cancelled", "duplicate_order", "test_record", "outside_period"],
  },
};

export function getRule(version) {
  const rule = RULEBOOKS[version];
  if (!rule) {
    const known = Object.keys(RULEBOOKS).join(", ");
    throw new RangeError(`未知规则版本: ${version}（已知: ${known}）`);
  }
  return rule;
}

export function latestRuleVersion() {
  return Object.keys(RULEBOOKS).sort().at(-1);
}

// 时间与确定性工具：全部使用显式时区偏移的 ISO 字符串，班次按北京时间(+08:00)切分。

export function parseTs(value, field = "时间") {
  if (typeof value !== "string") {
    throw new TypeError(`${field}必须为 ISO 8601 字符串`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new RangeError(`${field}无法解析: ${value}`);
  }
  return ms;
}

export function minutesBetween(start, end) {
  return Math.round((end - start) / 60000);
}

function beijingParts(ms) {
  const d = new Date(ms + 8 * 3600_000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
  };
}

export function monthOf(ms) {
  const p = beijingParts(ms);
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
}

function withinHourWindow(hour, startHour, endHour) {
  // endHour 允许超过 24，用于跨午夜班次，例如 night: 20 -> 32
  if (hour >= startHour && hour < endHour) return true;
  const wrapped = hour + 24;
  return wrapped >= startHour && wrapped < endHour;
}

export function shiftOf(ms, rule) {
  const { hour } = beijingParts(ms);
  for (const shift of rule.shifts) {
    if (withinHourWindow(hour, shift.startHour, shift.endHour)) return shift.code;
  }
  return rule.shifts[0]?.code ?? "unknown";
}

export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const rank = Math.min(sortedValues.length, Math.max(1, Math.ceil(p * sortedValues.length)));
  return sortedValues[rank - 1];
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// FNV-1a 32 位哈希，用于旅程版本指纹、抽样与报告一致性校验（非密码学用途）。
export function fnv1a(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function hashOf(value) {
  return fnv1a(canonicalJson(value));
}

// 审查队列的确定性抽样：同一队列条件 + 同一期次 + 同一批内容指纹，必抽出同一样本集。
// 不依赖随机种子状态，便于重放与向机构解释抽中原因。
import { fnv1a } from "./time.js";

export function deterministicSample(items, { size, salt = "" }) {
  if (!Number.isInteger(size) || size <= 0) return [];
  const scored = items.map((item) => ({
    item,
    score: fnv1a(`${salt}|${item.key ?? JSON.stringify(item)}`),
  }));
  // 分数相同（极少见）时用 key 兜底排序，保证全序
  scored.sort((a, b) => a.score.localeCompare(b.score) || String(a.item.key).localeCompare(String(b.item.key)));
  return scored.slice(0, Math.min(size, scored.length)).map((s) => s.item);
}

// 分层抽样：每个来源机构独立抽 n 个，避免大机构占满样本
export function stratifiedSample(items, { sizePerStratum, strataOf, salt = "" }) {
  const strata = new Map();
  for (const item of items) {
    const s = strataOf(item);
    if (!strata.has(s)) strata.set(s, []);
    strata.get(s).push(item);
  }
  const out = [];
  for (const [s, group] of [...strata.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(...deterministicSample(group, { size: sizePerStratum, salt: `${salt}|${s}` }));
  }
  return out;
}

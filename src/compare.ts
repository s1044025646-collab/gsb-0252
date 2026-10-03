import { SortKey } from "./types";

/**
 * 确定性字符串比较:按 UTF-16 码元逐位比较(即 JavaScript 的 < 关系),
 * 不依赖本机语言环境,同一输入在任何机器上得到相同顺序。
 */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export type KeyValue = number | string | null;

/** 空值(缺字段或 null)位置固定,不随升降序反转 */
export function compareKeyValues(a: KeyValue, b: KeyValue, key: SortKey): number {
  const aNull = a === null;
  const bNull = b === null;
  if (aNull || bNull) {
    if (aNull && bNull) return 0;
    const nullsFirst = key.nulls === "first";
    return aNull ? (nullsFirst ? -1 : 1) : nullsFirst ? 1 : -1;
  }
  let cmp: number;
  if (key.type === "number") {
    cmp = (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  } else {
    cmp = compareStrings(a as string, b as string);
  }
  return key.direction === "desc" ? -cmp : cmp;
}

export function compareRows(
  aKeys: KeyValue[],
  aLine: number,
  bKeys: KeyValue[],
  bLine: number,
  keys: SortKey[]
): number {
  for (let i = 0; i < keys.length; i++) {
    const c = compareKeyValues(aKeys[i], bKeys[i], keys[i]);
    if (c !== 0) return c;
  }
  // 稳定性:所有键相等时按原始行号升序
  return aLine < bLine ? -1 : aLine > bLine ? 1 : 0;
}

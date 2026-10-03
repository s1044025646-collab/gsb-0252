import type { SortKey } from './types.js';

/**
 * 空值标记：缺字段与 JSON null 统一归一化为 null。
 * 使用普通 null 也使临时段序列化（JSON）前后表示一致。
 */
export const NULL_KEY = null;
export type KeyValue = number | string | null;

/**
 * 字符串的公开确定性序关系：按 UTF-16 码元逐元素比较。
 *
 * 说明：
 * - 不依赖本机语言环境（不使用 Intl / localeCompare），任何机器上结果一致。
 * - JavaScript 字符串为 UTF-16，码元逐元素比较等价于对有效 Unicode 标量值
 *   按码点排序（代理对中高代理项小于低代理项，顺序确定）。
 */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return a.length < b.length ? -1 : 1;
}

export class KeyTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyTypeError';
  }
}

/**
 * 提取一行的所有键值，类型不符抛出 KeyTypeError（含字段名信息）。
 */
export function extractKeys(record: Record<string, unknown>, keys: SortKey[]): KeyValue[] {
  const values: KeyValue[] = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (!Object.prototype.hasOwnProperty.call(record, key.field) || record[key.field] === null) {
      values[i] = null;
      continue;
    }
    const raw = record[key.field];
    if (key.type === 'number') {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        throw new KeyTypeError(`字段 "${key.field}" 声明为 number，但实际不是有限 JSON 数值`);
      }
      values[i] = raw;
    } else {
      if (typeof raw !== 'string') {
        throw new KeyTypeError(`字段 "${key.field}" 声明为 string，但实际不是字符串`);
      }
      values[i] = raw;
    }
  }
  return values;
}

/**
 * 比较两条记录的键数组。
 *
 * 空值位置规则（nulls=first / last）不随升降序反转：
 * - first：空值恒在非空值之前，空值之间视为相等（交由行号决胜）；
 * - last ：空值恒在非空值之后。
 */
export function compareKeyRows(
  a: KeyValue[],
  b: KeyValue[],
  keys: SortKey[]
): number {
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const av = a[i]!;
    const bv = b[i]!;
    const aNull = av === null;
    const bNull = bv === null;

    if (aNull || bNull) {
      if (aNull && bNull) continue;
      // 空值位置独立于 dir
      return aNull ? (key.nulls === 'first' ? -1 : 1) : key.nulls === 'first' ? 1 : -1;
    }

    let cmp: number;
    if (key.type === 'number') {
      cmp = (av as number) < (bv as number) ? -1 : (av as number) > (bv as number) ? 1 : 0;
    } else {
      cmp = compareStrings(av as string, bv as string);
    }
    if (cmp !== 0) return key.dir === 'asc' ? cmp : -cmp;
  }
  return 0;
}

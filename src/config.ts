import type { KeyType, NullsPos, SortDir, SortKey, SortOptions } from './types.js';
import { ErrorCode, SortError } from './errors.js';

/** 硬上限：防止用户配置导致 fs 打开过多句柄或缓冲无限增长。 */
export const LIMITS = {
  minBufferSize: 1,
  maxBufferSize: 1_000_000,
  minFanIn: 2,
  maxFanIn: 1024,
  minMaxLineBytes: 1,
  maxMaxLineBytes: 64 * 1024 * 1024,
  maxKeys: 64,
  defaultBufferSize: 1000,
  defaultFanIn: 8,
  defaultMaxLineBytes: 1024 * 1024
} as const;

function fail(message: string): never {
  throw new SortError(ErrorCode.INVALID_ARGS, message);
}

function isPlainString(value: unknown): value is string {
  return typeof value === 'string';
}

function positiveInt(raw: unknown, name: string, min: number, max: number, dflt: number): number {
  if (raw === undefined || raw === null) return dflt;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max) {
    return raw;
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const parsed = Number(raw.trim());
    if (Number.isInteger(parsed) && parsed >= min && parsed <= max) return parsed;
  }
  fail(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
}

function validateKey(raw: unknown, index: number): SortKey {
  if (typeof raw !== 'object' || raw === null) {
    fail(`排序键 #${index + 1} 必须是对象`);
  }
  const obj = raw as Record<string, unknown>;
  if (!isPlainString(obj.field) || obj.field.length === 0) {
    fail(`排序键 #${index + 1} 的 field 必须是非空字符串`);
  }
  if (obj.field.includes('\n') || obj.field.includes('\r') || obj.field.includes('\t')) {
    fail(`排序键 #${index + 1} 的 field 不能包含换行或制表符`);
  }
  const type = obj.type as KeyType;
  if (type !== 'number' && type !== 'string') {
    fail(`排序键 #${index + 1} 的 type 必须是 "number" 或 "string"`);
  }
  const dir: SortDir = obj.dir === undefined ? 'asc' : (obj.dir as SortDir);
  if (dir !== 'asc' && dir !== 'desc') {
    fail(`排序键 #${index + 1} 的 dir 必须是 "asc" 或 "desc"`);
  }
  const nulls: NullsPos = obj.nulls === undefined ? (dir === 'asc' ? 'first' : 'last') : (obj.nulls as NullsPos);
  if (nulls !== 'first' && nulls !== 'last') {
    fail(`排序键 #${index + 1} 的 nulls 必须是 "first" 或 "last"`);
  }
  return { field: obj.field, type, dir, nulls };
}

/**
 * 校验并规范化排序配置。
 * 输入可以是已解析对象，也可以是 JSON 字符串（CLI 传参场景）。
 */
export function parseSortOptions(input: unknown): SortOptions {
  let body: Record<string, unknown>;
  if (typeof input === 'string') {
    try {
      body = JSON.parse(input) as Record<string, unknown>;
    } catch {
      fail('排序配置必须是合法 JSON');
    }
  } else if (typeof input === 'object' && input !== null) {
    body = input as Record<string, unknown>;
  } else {
    fail('排序配置必须是对象');
  }

  const rawKeys = body.keys;
  if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
    fail('keys 必须是非空数组（至少指定一个顶层排序字段）');
  }
  if (rawKeys.length > LIMITS.maxKeys) {
    fail(`排序键数量不能超过 ${LIMITS.maxKeys}`);
  }
  const keys = rawKeys.map((raw, index) => validateKey(raw, index));

  const fields = new Set<string>();
  for (const key of keys) {
    if (fields.has(key.field)) fail(`排序字段重复: ${key.field}`);
    fields.add(key.field);
  }

  const bufferSize = positiveInt(
    body.bufferSize,
    'bufferSize（缓冲记录条数）',
    LIMITS.minBufferSize,
    LIMITS.maxBufferSize,
    LIMITS.defaultBufferSize
  );
  const fanIn = positiveInt(
    body.fanIn,
    'fanIn（归并扇入）',
    LIMITS.minFanIn,
    LIMITS.maxFanIn,
    LIMITS.defaultFanIn
  );
  const maxLineBytes = positiveInt(
    body.maxLineBytes,
    'maxLineBytes（单行最大字节数）',
    LIMITS.minMaxLineBytes,
    LIMITS.maxMaxLineBytes,
    LIMITS.defaultMaxLineBytes
  );

  return { keys, bufferSize, fanIn, maxLineBytes };
}

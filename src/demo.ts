import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Writable } from 'node:stream';
import { parseSortOptions } from './config.js';
import { compareKeyRows, extractKeys } from './compare.js';

/**
 * 确定性 32 位 PRNG（mulberry32）。相同种子永远产出相同序列，
 * 使演示数据可重现、可跨机器逐字节对比。
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DemoRecord {
  /** 同分组键，用于验证稳定性：该字段有大量重复值 */
  grp: number;
  /** 中文字符串键（确定性，含重复） */
  city: string;
  /** 可能为 null 的数字字段（演示空值规则） */
  score: number | null;
  /** 输入次序编号，仅用于人工核对稳定性；不参与排序 */
  idx: number;
}

const CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '西安', '南京'];

/**
 * 生成演示 NDJSON。
 * @param count 记录行数
 * @param seed 确定种子（默认固定）
 */
export function generateDemoRecords(count = 127, seed = 20260252): DemoRecord[] {
  const rand = mulberry32(seed);
  const records: DemoRecord[] = [];
  // grp 只有 5 个取值 => 大量同键记录，必须依赖行号稳定决胜。
  for (let i = 0; i < count; i++) {
    const grp = Math.floor(rand() * 5);
    const city = CITIES[Math.floor(rand() * CITIES.length)]!;
    const score = rand() < 0.12 ? null : Math.floor(rand() * 1000);
    records.push({ grp, city, score, idx: i });
  }
  return records;
}

/** 以指定行终止风格写出演示文件；unterminatedLast=true 时末行不加换行。 */
export async function writeDemoNdjson(
  path: string,
  records: DemoRecord[],
  options: { unterminatedLast?: boolean } = {}
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream: Writable = createWriteStream(path);
    stream.on('error', rejectPromise);
    stream.on('finish', resolvePromise);
    records.forEach((record, index) => {
      const isLast = index === records.length - 1;
      const suffix = options.unterminatedLast && isLast ? '' : '\n';
      stream.write(`${JSON.stringify(record)}${suffix}`);
    });
    stream.end();
  });
}

/**
 * 独立内存基准：直接按与外部排序相同的比较规则在内存中排序，
 * 用于与外部排序结果逐行比较。与 sorter 共享 compareKeyRows，
 * 但不使用任何临时段，作为“小样本独立校验”。
 */
export function referenceSort(lines: string[], keysJson: unknown): string[] {
  const options = parseSortOptions(keysJson);
  const parsed = lines.map((text, index) => {
    const record = JSON.parse(text) as Record<string, unknown>;
    return { keys: extractKeys(record, options.keys), lineNo: index + 1, text };
  });
  parsed.sort((a, b) => {
    const cmp = compareKeyRows(a.keys, b.keys, options.keys);
    return cmp !== 0 ? cmp : a.lineNo - b.lineNo;
  });
  return parsed.map((row) => row.text);
}

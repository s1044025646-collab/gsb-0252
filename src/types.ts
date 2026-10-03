export type KeyType = "number" | "string";
export type Direction = "asc" | "desc";
export type NullsOrder = "first" | "last";

export interface SortKey {
  field: string;
  type: KeyType;
  direction: Direction;
  nulls: NullsOrder;
}

export interface SortConfig {
  keys: SortKey[];
  /** 记录缓冲上限(条数),非进程硬内存上限 */
  bufferRecords: number;
  /** 单轮归并最大扇入(同时打开的段文件数上限) */
  fanIn: number;
  /** 单行最大字节数 */
  maxLineBytes: number;
}

export const DEFAULTS = {
  bufferRecords: 100_000,
  fanIn: 64,
  maxLineBytes: 4 * 1024 * 1024,
} as const;

export interface SortStats {
  inputLines: number;
  runs: number;
  mergeRounds: number;
  bufferRecords: number;
  fanIn: number;
  maxLineBytes: number;
  outputLines: number;
}

export type JobStatus = "pending" | "running" | "done" | "failed";

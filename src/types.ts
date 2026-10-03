/**
 * 共享类型定义。
 */

export type KeyType = 'number' | 'string';
export type SortDir = 'asc' | 'desc';
export type NullsPos = 'first' | 'last';

/** 单个排序键：仅支持顶层字段。 */
export interface SortKey {
  /** 顶层字段名 */
  field: string;
  /** 声明的字段类型；实际值类型不符即报错 */
  type: KeyType;
  /** 升序 / 降序 */
  dir: SortDir;
  /** 空值位置；空值位置不随升降序反转 */
  nulls: NullsPos;
}

/** 一次排序任务的全部参数。 */
export interface SortOptions {
  keys: SortKey[];
  /** 内存中同时缓冲的记录条数上限（记录缓冲上限，非进程内存硬上限） */
  bufferSize: number;
  /** 多路归并每轮同时打开的段文件数上限 */
  fanIn: number;
  /** 单行最大字节数 */
  maxLineBytes: number;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

/** 排序完成后的统计报告。 */
export interface SortStats {
  inputRows: number;
  segmentCount: number;
  mergeRounds: number;
  bufferSize: number;
  fanIn: number;
  maxLineBytes: number;
}

export interface JobError {
  code: string;
  message: string;
  /** 出错的源文件行号（1 基），与坏数据相关时存在 */
  line?: number;
}

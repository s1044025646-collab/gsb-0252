import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Writable } from 'node:stream';
import { compareKeyRows, extractKeys, KeyTypeError, type KeyValue } from './compare.js';
import { ErrorCode, SortError } from './errors.js';
import { MinHeap } from './heap.js';
import { LineReader, type RawLine } from './lineReader.js';
import { SegmentReader, SegmentWriter } from './segment.js';
import type { SortOptions, SortStats } from './types.js';

interface BufferedRecord {
  keys: KeyValue[];
  lineNo: number;
  rawText: string;
}

export interface SortRunProgress {
  onStatus?: (phase: string, info?: Record<string, number>) => void;
}

/**
 * 执行稳定的受限内存外部排序。
 *
 * 阶段：
 * 1) 分块（run production）：流式读取，内存中最多保留 bufferSize 条记录，
 *    填满后在内存排序并整体落盘成一个有序临时段；
 * 2) 分轮多路归并：每轮每个归并组最多合并 fanIn 个段；
 *    段数超过 fanIn 时需要多轮，直到只剩一个有序段；
 * 3) 发布：结果先写项目内临时结果文件，成功结束后原子 rename 到最终路径，
 *    任何失败都不会覆盖已有成功结果。
 *
 * 稳定性：所有排序键全部相等时，按原始行号（源文件 1 基行号）决胜，
 * 因此完全重复记录也保持输入相对次序并全部保留。
 */
export async function runExternalSort(
  inputPath: string,
  finalOutputPath: string,
  tempDir: string,
  options: SortOptions,
  progress: SortRunProgress = {}
): Promise<SortStats> {
  const { keys, bufferSize, fanIn, maxLineBytes } = options;
  await mkdir(tempDir, { recursive: true });
  await mkdir(dirname(finalOutputPath), { recursive: true });

  const segmentFiles: string[] = [];
  let inputRows = 0;
  let mergeRounds = 0;

  const compareRecords = (a: BufferedRecord, b: BufferedRecord): number => {
    const cmp = compareKeyRows(a.keys, b.keys, keys);
    return cmp !== 0 ? cmp : a.lineNo - b.lineNo;
  };

  /** 将一个内存缓冲排序并落盘为段。 */
  const flushChunk = async (buffer: BufferedRecord[], index: number): Promise<string> => {
    buffer.sort(compareRecords);
    const path = `${tempDir}/seg_0_${index}.ndjsonseg`;
    const writer = await SegmentWriter.create(path);
    try {
      for (const record of buffer) {
        await writer.write(record);
      }
    } finally {
      await writer.close();
    }
    segmentFiles.push(path);
    progress.onStatus?.('chunk-written', { segments: segmentFiles.length });
    return path;
  };

  // ---- 阶段 1：分块读取、校验、内存排序、落盘 ----
  let buffer: BufferedRecord[] = [];
  let chunkIndex = 0;
  const reader = new LineReader(inputPath, maxLineBytes);
  try {
    for await (const line of reader) {
      const record = parseLineOrThrow(line);
      let extracted: KeyValue[];
      try {
        extracted = extractKeys(record, keys);
      } catch (err) {
        if (err instanceof KeyTypeError) {
          throw new SortError(ErrorCode.TYPE_MISMATCH, `${err.message}（第 ${line.lineNo} 行）`, line.lineNo);
        }
        throw err;
      }
      inputRows += 1;
      buffer.push({ keys: extracted, lineNo: line.lineNo, rawText: line.text });
      if (buffer.length >= bufferSize) {
        await flushChunk(buffer, chunkIndex++);
        buffer = [];
      }
    }
  } catch (err) {
    await cleanupCurrentTemp(segmentFiles, tempDir, finalOutputPath);
    throw mapReadError(err);
  } finally {
    await reader[Symbol.asyncDispose]();
  }

  // 尾部缓冲：若全程不足一个缓冲块，则形成唯一的第 0 段（即使为空输入：无段）。
  if (buffer.length > 0) {
    await flushChunk(buffer, chunkIndex++);
  }
  buffer = [];

  const initialSegmentCount = segmentFiles.length;

  // ---- 阶段 2：分轮多路归并 ----
  let currentSegments = [...segmentFiles];
  let roundNo = 0;
  const producedRounds: string[] = [];

  while (currentSegments.length > 1) {
    roundNo += 1;
    mergeRounds = roundNo;
    const nextSegments: string[] = [];
    for (let start = 0, group = 0; start < currentSegments.length; start += fanIn, group++) {
      const batch = currentSegments.slice(start, start + fanIn);
      if (batch.length === 1) {
        // 整轮只有一个段且无需合并时，直接透传，避免无意义拷贝；
        // 这种情况只会在 currentSegments.length === 1 时出现，循环已排除，
        // 这里保留防御性处理。
        nextSegments.push(batch[0]!);
        continue;
      }
      const outPath = `${tempDir}/seg_${roundNo}_${group}.ndjsonseg`;
      await mergeSegments(batch, outPath, keys);
      nextSegments.push(outPath);
      producedRounds.push(outPath);
    }
    // 本轮输入段（含直接透传命名）不再需要；删除它们，仅保留最新一轮，
    // 保证“只清理由本次任务创建的临时段”且磁盘占用有界。
    for (const old of currentSegments) {
      if (!nextSegments.includes(old)) {
        await rm(old, { force: true });
      }
    }
    currentSegments = nextSegments;
    progress.onStatus?.('merge-round', { round: roundNo, segments: currentSegments.length });
  }

  // ---- 阶段 3：发布（先写临时结果，成功后原子替换） ----
  const stagingPath = `${tempDir}/result.staging.ndjson`;
  try {
    await publishResult(currentSegments[0], stagingPath, finalOutputPath, inputRows);
  } catch (err) {
    await cleanupCurrentTemp([...currentSegments, ...producedRounds], tempDir, finalOutputPath);
    throw mapReadError(err);
  }

  // 成功：删除临时目录中本任务的段与暂存文件（结果已发布）。
  await rm(tempDir, { recursive: true, force: true });

  return {
    inputRows,
    segmentCount: initialSegmentCount,
    mergeRounds,
    bufferSize,
    fanIn,
    maxLineBytes
  };
}

/** 解析并校验一行：必须是 JSON 对象（顶层、非数组、非原始值）。 */
function parseLineOrThrow(line: RawLine): Record<string, unknown> {
  const text = line.text;
  if (text.length === 0) {
    throw new SortError(ErrorCode.NOT_OBJECT, `第 ${line.lineNo} 行是空行，不是 JSON 对象`, line.lineNo);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SortError(ErrorCode.BAD_JSON, `第 ${line.lineNo} 行不是合法 JSON`, line.lineNo);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SortError(ErrorCode.NOT_OBJECT, `第 ${line.lineNo} 行不是 JSON 对象`, line.lineNo);
  }
  return parsed as Record<string, unknown>;
}

function mapReadError(err: unknown): Error {
  if (err instanceof SortError) return err;
  if (err instanceof Error) {
    return new SortError(ErrorCode.IO_ERROR, `排序过程中发生 IO 错误: ${err.message}`);
  }
  return new SortError(ErrorCode.INTERNAL, '排序过程中发生未知错误');
}

async function cleanupCurrentTemp(
  knownSegments: string[],
  tempDir: string,
  finalOutputPath: string
): Promise<void> {
  // 仅删除本任务 tempDir 内内容；绝不触碰最终结果路径。
  void knownSegments;
  void finalOutputPath;
  await rm(tempDir, { recursive: true, force: true });
}

interface HeapEntry {
  keys: KeyValue[];
  lineNo: number;
  rawText: string;
  source: number;
}

/**
 * k 路稳定归并（k <= fanIn）。
 * 每一路保持一个打开的段读取器；堆顶为当前最小行。
 * 比较在键相等时以原始行号决胜，保证全局稳定。
 */
async function mergeSegments(
  inputPaths: string[],
  outputPath: string,
  keys: SortOptions['keys']
): Promise<void> {
  const readers = inputPaths.map((path) => new SegmentReader(path));
  const iterators = readers.map((reader) => reader[Symbol.asyncIterator]());

  const heap = new MinHeap<HeapEntry>((a, b) => {
    const cmp = compareKeyRows(a.keys, b.keys, keys);
    return cmp !== 0 ? cmp : a.lineNo - b.lineNo;
  });

  const refill = async (source: number): Promise<void> => {
    const next = await iterators[source]!.next();
    if (!next.done && next.value) {
      const row = next.value;
      heap.push({ keys: row.keys, lineNo: row.lineNo, rawText: row.rawText, source });
    }
  };

  const writer = await SegmentWriter.create(outputPath);
  try {
    for (let i = 0; i < iterators.length; i++) {
      await refill(i);
    }
    while (heap.size > 0) {
      const top = heap.pop()!;
      await writer.write({ keys: top.keys, lineNo: top.lineNo, rawText: top.rawText });
      await refill(top.source);
    }
  } finally {
    await writer.close();
    for (const reader of readers) reader.close();
  }
}

/**
 * 把最终有序段（或无段的空输入）发布为正式输出 NDJSON。
 * 先写 staging 文件并等待落盘，再 rename 到最终路径，保证原子可见性。
 */
async function publishResult(
  finalSegmentPath: string | undefined,
  stagingPath: string,
  finalOutputPath: string,
  inputRows: number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const out: Writable = createWriteStream(stagingPath);
    out.on('error', reject);
    out.on('finish', resolve);

    if (!finalSegmentPath) {
      // 空输入：产出空文件。
      out.end();
      return;
    }

    const reader = new SegmentReader(finalSegmentPath);
    let written = 0;
    (async () => {
      try {
        for await (const row of reader) {
          if (!out.write(`${row.rawText}\n`)) {
            await new Promise<void>((drainResolve, drainReject) => {
              out.once('drain', drainResolve);
              out.once('error', drainReject);
            });
          }
          written++;
        }
        reader.close();
        if (written !== inputRows) {
          throw new SortError(
            ErrorCode.INTERNAL,
            `归并输出行数 ${written} 与输入行数 ${inputRows} 不一致`
          );
        }
        out.end();
      } catch (err) {
        reader.close();
        out.destroy();
        reject(err);
      }
    })();
  });

  // 原子发布：rename 在同卷内是原子的；旧成功结果只会在新文件完整写完后被替换，
  // 失败发生在此之前时旧结果保持可读（此处 rename 失败由调用方转 E_IO_ERROR）。
  await rename(stagingPath, finalOutputPath);
}

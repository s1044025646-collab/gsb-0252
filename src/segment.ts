import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Writable } from 'node:stream';
import type { KeyValue } from './compare.js';

/**
 * 有序临时段（sorted run）的二进制行格式（UTF-8 文本）：
 *
 *   <JSON.stringify(键数组)>\t<原始行号>\t<原始行文本>\n
 *
 * - 键数组仅含 number / string / null（null 即统一空值标记），
 *   JSON.stringify 不输出制表符与换行，可用 TAB 安全分隔；
 * - 原始行文本保证不含 \n（行终止符已剥离），也保证不含 \r\n，
 *   但可能含 \t，因此仅按前两个 TAB 切分，其余全部作为有效载荷；
 * - 这是本项目内部临时格式，不对外承诺兼容。
 */

export function serializeRow(keys: KeyValue[], lineNo: number, rawText: string): string {
  const keyJson = JSON.stringify(keys);
  return `${keyJson}\t${lineNo}\t${rawText}\n`;
}

export interface SegmentRow {
  keys: KeyValue[];
  lineNo: number;
  rawText: string;
}

export function parseSegmentLine(line: string): SegmentRow {
  const firstTab = line.indexOf('\t');
  const secondTab = line.indexOf('\t', firstTab + 1);
  if (firstTab === -1 || secondTab === -1) {
    throw new Error('临时段行格式损坏');
  }
  const keyJson = line.slice(0, firstTab);
  const lineNoText = line.slice(firstTab + 1, secondTab);
  const rawText = line.slice(secondTab + 1);
  const parsed = JSON.parse(keyJson) as unknown[];
  const keys = parsed as KeyValue[];
  return { keys, lineNo: Number(lineNoText), rawText };
}

/** 段写入器：缓冲写，按块落盘。 */
export class SegmentWriter {
  private stream: Writable;
  private closed = false;
  private drainError: Error | null = null;

  private constructor(stream: Writable) {
    this.stream = stream;
    this.stream.on('error', (err) => {
      this.drainError = err;
    });
  }

  static async create(path: string): Promise<SegmentWriter> {
    await mkdir(dirname(path), { recursive: true });
    const stream = createWriteStream(path, { highWaterMark: 1024 * 1024 });
    return new SegmentWriter(stream);
  }

  async write(row: { keys: KeyValue[]; lineNo: number; rawText: string }): Promise<void> {
    const payload = serializeRow(row.keys, row.lineNo, row.rawText);
    if (!this.stream.write(payload)) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          this.stream.removeListener('error', onError);
          this.drainError ? reject(this.drainError) : resolve();
        };
        const onError = (err: Error) => {
          this.stream.removeListener('drain', onDrain);
          reject(err);
        };
        this.stream.once('drain', onDrain);
        this.stream.once('error', onError);
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve, reject) => {
      this.stream.end(() => resolve());
      this.stream.on('error', reject);
    });
  }
}

/**
 * 顺序读取一个段文件并逐行解析；用于归并阶段。
 * 调用方通过 close 释放 fd（每个归并路保持一个打开的段读取器）。
 */
export class SegmentReader implements AsyncIterable<SegmentRow> {
  private leftover = '';
  private stream: ReturnType<typeof createReadStream>;

  constructor(path: string) {
    this.stream = createReadStream(path, { highWaterMark: 256 * 1024, encoding: 'utf8' });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SegmentRow> {
    let leftover = '';
    for await (const chunk of this.stream) {
      leftover += chunk as string;
      let idx: number;
      while ((idx = leftover.indexOf('\n')) !== -1) {
        const line = leftover.slice(0, idx);
        leftover = leftover.slice(idx + 1);
        if (line.length > 0) yield parseSegmentLine(line);
      }
    }
    if (leftover.length > 0) yield parseSegmentLine(leftover);
  }

  close(): void {
    this.stream.destroy();
  }
}

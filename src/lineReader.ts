import { createReadStream } from 'node:fs';
import type { ReadStream } from 'node:fs';
import { ErrorCode, SortError } from './errors.js';

export interface RawLine {
  /** 1 基源行号 */
  lineNo: number;
  /** 去掉行终止符后的原始文本（不做任何数据清洗） */
  text: string;
  /** 该行（含终止符）在文件中的起始字节偏移 */
  startOffset: number;
  /** 是否为文件最后一行且结尾没有 \n */
  unterminated: boolean;
}

/**
 * 按行流式读取 UTF-8 NDJSON 文件。
 *
 * - 逐块读取，缓冲中只保留跨块的半行，不会把整个文件放入内存；
 * - 单行（不含行终止符）字节数超过 maxLineBytes 时抛出 E_LINE_TOO_LONG，
 *   错误携带源行号；
 * - \n 与 \r\n 都识别为行终止符；单独的 \r 不当作换行（NDJSON 约定）；
 * - 末尾无换行的最后一行作为 unterminated 行照常返回；
 * - 空文件返回零行；仅含空白/换行的行按内容校验阶段处理（非空但非对象会报错）。
 */
export class LineReader implements AsyncIterable<RawLine>, AsyncDisposable {
  private stream: ReadStream;
  private leftover: Buffer = Buffer.alloc(0);
  private lineNo = 0;
  private byteOffset = 0;
  private pendingEnd = false;
  private error: Error | null = null;
  private queue: RawLine[] = [];
  private wait: ((v: unknown) => void) | null = null;
  private static readonly HIGH_WATER = 64;

  constructor(
    path: string,
    private readonly maxLineBytes: number
  ) {
    this.stream = createReadStream(path, { highWaterMark: 64 * 1024 });
    this.stream.on('error', (err) => {
      this.error = new SortError(ErrorCode.IO_ERROR, `读取输入文件失败: ${err.message}`);
    });
  }

  private shiftLine(): RawLine | null {
    const idx = this.leftover.indexOf(0x0a);
    if (idx === -1) {
      if (this.pendingEnd) {
        if (this.leftover.length === 0) return null;
        return this.finalize(this.leftover, false);
      }
      if (this.leftover.length > this.maxLineBytes) {
        throw new SortError(
          ErrorCode.LINE_TOO_LONG,
          `第 ${this.lineNo + 1} 行超过单行大小上限 ${this.maxLineBytes} 字节`,
          this.lineNo + 1
        );
      }
      return null;
    }

    let lineBytes = idx;
    if (lineBytes > 0 && this.leftover[lineBytes - 1] === 0x0d) lineBytes -= 1;
    const chunk = this.leftover.subarray(0, lineBytes);
    const consumed = idx + 1;
    if (lineBytes > this.maxLineBytes) {
      throw new SortError(
        ErrorCode.LINE_TOO_LONG,
        `第 ${this.lineNo + 1} 行超过单行大小上限 ${this.maxLineBytes} 字节`,
        this.lineNo + 1
      );
    }
    const line = this.toLine(chunk, true);
    this.leftover = this.leftover.subarray(consumed);
    this.byteOffset += consumed;
    return line;
  }

  private finalize(chunk: Buffer, terminated: boolean): RawLine {
    const line = this.toLine(chunk, terminated);
    this.leftover = Buffer.alloc(0);
    return line;
  }

  private toLine(chunk: Buffer, terminated: boolean): RawLine {
    this.lineNo += 1;
    return {
      lineNo: this.lineNo,
      text: chunk.toString('utf8'),
      startOffset: this.byteOffset,
      unterminated: !terminated
    };
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RawLine> {
    const onData = (buf: Buffer) => {
      try {
        this.leftover = this.leftover.length === 0 ? buf : Buffer.concat([this.leftover, buf]);
        for (;;) {
          const line = this.shiftLine();
          if (!line) break;
          this.queue.push(line);
        }
        if (this.queue.length >= LineReader.HIGH_WATER) {
          this.stream.pause();
        }
      } catch (err) {
        this.error = err as Error;
        this.stream.destroy();
      }
      this.notify();
    };
    const onEnd = () => {
      try {
        this.pendingEnd = true;
        const tail = this.shiftLine();
        if (tail) this.queue.push(tail);
      } catch (err) {
        this.error = err as Error;
      }
      this.notify();
    };

    this.stream.on('data', onData);
    this.stream.on('end', onEnd);
    this.stream.on('error', (err) => {
      this.error = new SortError(ErrorCode.IO_ERROR, `读取输入文件失败: ${err.message}`);
      this.notify();
    });

    try {
      while (true) {
        if (this.error) throw this.error;
        if (this.queue.length > 0) {
          const line = this.queue.shift()!;
          if (this.queue.length < LineReader.HIGH_WATER && this.stream.isPaused()) {
            this.stream.resume();
          }
          yield line;
          continue;
        }
        if (this.pendingEnd) return;
        if (this.stream.isPaused()) this.stream.resume();
        await new Promise<unknown>((resolve) => {
          this.wait = resolve;
        });
      }
    } finally {
      this.stream.destroy();
    }
  }

  private notify(): void {
    if (this.wait) {
      const resolve = this.wait;
      this.wait = null;
      resolve(null);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.stream.destroy();
  }
}

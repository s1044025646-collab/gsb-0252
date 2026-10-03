import fs from "node:fs";
import path from "node:path";
import { compareRows, KeyValue } from "./compare";
import { SortError } from "./errors";
import { parseRecord } from "./keys";
import { readLines } from "./lineReader";
import { SortConfig, SortStats } from "./types";

function waitDrain(ws: fs.WriteStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      ws.off("error", onErr);
      resolve();
    };
    const onErr = (e: Error) => {
      ws.off("drain", onDrain);
      reject(e);
    };
    ws.once("drain", onDrain);
    ws.once("error", onErr);
  });
}

interface RunRecord {
  k: KeyValue[];
  n: number; // 原始行号,稳定性保证
  r: string; // 原始行内容
}

async function writeRun(filePath: string, records: RunRecord[]): Promise<void> {
  const ws = fs.createWriteStream(filePath, { encoding: "utf8" });
  try {
    for (const rec of records) {
      if (!ws.write(JSON.stringify(rec) + "\n")) {
        await waitDrain(ws);
      }
    }
  } finally {
    ws.end();
    await new Promise<void>((resolve) => ws.once("close", resolve));
  }
}

/** 最小堆,按排序键 + 原始行号比较 */
class Heap {
  private items: { rec: RunRecord; src: number }[] = [];
  constructor(private keys: SortConfig["keys"]) {}
  get size() {
    return this.items.length;
  }
  push(item: { rec: RunRecord; src: number }) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(a[i], a[p]) < 0) {
        [a[i], a[p]] = [a[p], a[i]];
        i = p;
      } else break;
    }
  }
  pop(): { rec: RunRecord; src: number } | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
  private cmp(
    x: { rec: RunRecord; src: number },
    y: { rec: RunRecord; src: number }
  ): number {
    const c = compareRows(x.rec.k, x.rec.n, y.rec.k, y.rec.n, this.keys);
    // 行号也相等(仅中间轮不同段可能同号?不会,行号全局唯一),再以段号兜底保证确定性
    return c !== 0 ? c : x.src - y.src;
  }
}

class RunReader {
  private buf = "";
  private offset = 0;
  private stream: fs.ReadStream;
  current: RunRecord | null = null;
  constructor(public filePath: string) {
    this.stream = fs.createReadStream(filePath, { encoding: "utf8" });
  }
  async open(): Promise<void> {
    await this.advance();
  }
  async advance(): Promise<void> {
    for (;;) {
      const nl = this.buf.indexOf("\n", this.offset);
      if (nl >= 0) {
        const line = this.buf.slice(this.offset, nl);
        this.offset = nl + 1;
        if (this.offset > 1 << 20) {
          this.buf = this.buf.slice(this.offset);
          this.offset = 0;
        }
        if (line.length === 0) continue;
        this.current = JSON.parse(line) as RunRecord;
        return;
      }
      const chunk = await this.readChunk();
      if (chunk === null) {
        const rest = this.buf.slice(this.offset).trim();
        this.current = rest.length > 0 ? (JSON.parse(rest) as RunRecord) : null;
        this.offset = this.buf.length;
        return;
      }
      this.buf += chunk;
    }
  }
  private readChunk(): Promise<string | null> {
    if (this.stream.readableEnded || this.stream.destroyed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      const onData = (c: string | Buffer) => {
        cleanup();
        resolve(typeof c === "string" ? c : c.toString("utf8"));
      };
      const onEnd = () => {
        cleanup();
        resolve(null);
      };
      const onErr = (e: Error) => {
        cleanup();
        reject(e);
      };
      const cleanup = () => {
        this.stream.off("data", onData);
        this.stream.off("end", onEnd);
        this.stream.off("error", onErr);
        this.stream.pause();
      };
      this.stream.on("data", onData);
      this.stream.on("end", onEnd);
      this.stream.on("error", onErr);
      this.stream.resume();
    });
  }
  async close(): Promise<void> {
    this.stream.destroy();
  }
}

export interface SortResult {
  stats: SortStats;
  /** 本次任务创建的全部临时段文件(由调用方负责清理) */
  tempFiles: string[];
}

/**
 * 稳定外部排序:分块读入 -> 内存排序 -> 写有序段 -> 分轮多路归并。
 * 输出写入 outPath(调用方保证是项目内临时文件,成功后再发布)。
 */
export async function externalSort(
  inputPath: string,
  outPath: string,
  config: SortConfig,
  tmpDir: string,
  jobId: string
): Promise<SortResult> {
  fs.mkdirSync(tmpDir, { recursive: true });
  const tempFiles: string[] = [];
  let inputLines = 0;
  let runCount = 0;
  let mergeRounds = 0;

  const newRunPath = (round: number, idx: number) => {
    const p = path.join(tmpDir, `run-${jobId}-r${round}-${idx}.tmp`);
    tempFiles.push(p);
    return p;
  };

  // 第一阶段:分块排序,生成有序段
  let runs: string[] = [];
  let buffer: RunRecord[] = [];
  for await (const { line, lineNo } of readLines(inputPath, config.maxLineBytes)) {
    inputLines = lineNo;
    if (line.trim().length === 0) {
      throw new SortError(
        "BAD_JSON",
        `第 ${lineNo} 行为空行,不是合法 JSON`,
        lineNo
      );
    }
    const keys = parseRecord(line, lineNo, config.keys);
    buffer.push({ k: keys, n: lineNo, r: line });
    if (buffer.length >= config.bufferRecords) {
      buffer.sort((a, b) => compareRows(a.k, a.n, b.k, b.n, config.keys));
      const p = newRunPath(0, runCount++);
      await writeRun(p, buffer);
      runs.push(p);
      buffer = [];
    }
  }
  if (buffer.length > 0) {
    buffer.sort((a, b) => compareRows(a.k, a.n, b.k, b.n, config.keys));
    const p = newRunPath(0, runCount++);
    await writeRun(p, buffer);
    runs.push(p);
    buffer = [];
  }

  // 第二阶段:分轮多路归并,直到只剩一个段
  let round = 1;
  while (runs.length > 1) {
    mergeRounds++;
    const next: string[] = [];
    for (let i = 0; i < runs.length; i += config.fanIn) {
      const group = runs.slice(i, i + config.fanIn);
      const out = newRunPath(round, next.length);
      await mergeRuns(group, out, config.keys, false);
      next.push(out);
    }
    // 只删除本次任务创建且已消费完的段
    for (const r of runs) await fs.promises.unlink(r).catch(() => {});
    runs = next;
    round++;
  }

  // 输出:单段时逐行提取原始行写正式输出;空输入写空文件
  let outputLines = 0;
  if (runs.length === 1) {
    outputLines = await mergeRuns(runs, outPath, config.keys, true);
  } else {
    fs.writeFileSync(outPath, "");
  }
  for (const r of runs) await fs.promises.unlink(r).catch(() => {});

  return {
    stats: {
      inputLines,
      runs: runCount,
      mergeRounds,
      bufferRecords: config.bufferRecords,
      fanIn: config.fanIn,
      maxLineBytes: config.maxLineBytes,
      outputLines,
    },
    tempFiles,
  };
}

/** 多路归并;raw=true 时只写原始行(最终输出),否则写中间段格式 */
async function mergeRuns(
  runPaths: string[],
  outPath: string,
  keys: SortConfig["keys"],
  raw: boolean
): Promise<number> {
  const readers: RunReader[] = [];
  try {
    for (const p of runPaths) {
      const r = new RunReader(p);
      await r.open();
      readers.push(r);
    }
    const heap = new Heap(keys);
    readers.forEach((r, i) => {
      if (r.current) heap.push({ rec: r.current, src: i });
    });
    const ws = fs.createWriteStream(outPath, { encoding: "utf8" });
    let count = 0;
    try {
      for (;;) {
        const top = heap.pop();
        if (!top) break;
        const line = raw
          ? top.rec.r + "\n"
          : JSON.stringify(top.rec) + "\n";
        if (!ws.write(line)) {
          await waitDrain(ws);
        }
        count++;
        await readers[top.src].advance();
        if (readers[top.src].current) {
          heap.push({ rec: readers[top.src].current!, src: top.src });
        }
      }
    } finally {
      ws.end();
      await new Promise<void>((resolve) => ws.once("close", resolve));
    }
    return count;
  } finally {
    for (const r of readers) await r.close();
  }
}

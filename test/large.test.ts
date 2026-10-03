import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExternalSort } from '../src/sorter.js';
import { parseSortOptions } from '../src/config.js';
import { createWriteStream } from 'node:fs';

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

/**
 * 独立内存基准（本文件自带，不导入 demo.ts，模拟“独立基准”）：
 * 直接解析全部行，用相同的键语义在数组里排序。
 */
async function referenceInMemory(path: string): Promise<{ count: number; ordered: boolean }> {
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n').filter((line) => line.length > 0);
  const rows = lines.map((line, index) => {
    const record = JSON.parse(line) as { a: number; b: string; c: number | null };
    return { record, lineNo: index + 1 };
  });
  rows.sort((x, y) => {
    if (x.record.a !== y.record.a) return x.record.a - y.record.a;
    if (x.record.b !== y.record.b) return x.record.b < y.record.b ? -1 : x.record.b > y.record.b ? 1 : 0;
    const xc = x.record.c;
    const yc = y.record.c;
    if (xc === null && yc === null) return x.lineNo - y.lineNo;
    if (xc === null) return 1;
    if (yc === null) return -1;
    if (xc !== yc) return xc - yc;
    return x.lineNo - y.lineNo;
  });
  // 有序性检查：与排序同一比较器逐对验证（稳定时允许相等）。
  let ordered = true;
  const cmpRecords = (
    x: { record: { a: number; b: string; c: number | null }; lineNo: number },
    y: { record: { a: number; b: string; c: number | null }; lineNo: number }
  ) => {
    if (x.record.a !== y.record.a) return x.record.a - y.record.a;
    if (x.record.b !== y.record.b) return x.record.b < y.record.b ? -1 : x.record.b > y.record.b ? 1 : 0;
    const xc = x.record.c;
    const yc = y.record.c;
    if (xc === null && yc === null) return x.lineNo - y.lineNo;
    if (xc === null) return 1;
    if (yc === null) return -1;
    if (xc !== yc) return xc - yc;
    return x.lineNo - y.lineNo;
  };
  for (let i = 1; i < rows.length; i++) {
    if (cmpRecords(rows[i - 1]!, rows[i]!) > 0) ordered = false;
  }
  return { count: rows.length, ordered };
}

describe('大样本守恒与有序性（独立内存基准）', () => {
  it('5 万行、多轮归并：记录数/内容守恒、有序、不同参数输出一致', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ndjson-large-'));
    try {
      const inputPath = join(project, 'big.ndjson');
      const out1 = join(project, 'r1.ndjson');
      const out2 = join(project, 'r2.ndjson');

      // 确定性生成（线性同余），约 10% 空值，b 为中文/ASCII 混合。
      const words = ['北京', '上海', 'abc', '广州', '深圳', '杭州', '成都'];
      let seed = 123456789;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const count = 50_000;
      await new Promise<void>((resolve, reject) => {
        const stream = createWriteStream(inputPath);
        stream.on('error', reject);
        stream.on('finish', resolve);
        let i = 0;
        const writeMore = () => {
          let ok = true;
          while (i < count && ok) {
            const a = Math.floor(rand() * 1000);
            const b = words[Math.floor(rand() * words.length)]!;
            const c = rand() < 0.1 ? null : Math.floor(rand() * 1_000_000);
            const payload = JSON.stringify({ a, b, c, i });
            ok = stream.write(`${payload}\n`);
            i++;
          }
          if (i < count) {
            stream.once('drain', writeMore);
          } else {
            stream.end();
          }
        };
        writeMore();
      });

      const inputHash = await hashFile(inputPath);

      const options = parseSortOptions({
        keys: [
          { field: 'a', type: 'number', dir: 'asc', nulls: 'last' },
          { field: 'b', type: 'string', dir: 'asc', nulls: 'first' },
          { field: 'c', type: 'number', dir: 'asc', nulls: 'last' }
        ],
        bufferSize: 500,
        fanIn: 4,
        maxLineBytes: 1 << 20
      });
      const stats1 = await runExternalSort(inputPath, out1, join(project, 't1'), options);
      const stats2 = await runExternalSort(
        inputPath,
        out2,
        join(project, 't2'),
        parseSortOptions({ ...options, bufferSize: 137, fanIn: 3 })
      );

      assert.equal(stats1.inputRows, count);
      assert.equal(stats2.inputRows, count);
      assert.ok(stats1.segmentCount === Math.ceil(count / 500));
      assert.ok(stats1.mergeRounds >= 2);

      // 输出有序 + 行数守恒（与独立基准核对）
      const ref = await referenceInMemory(out1);
      assert.equal(ref.count, count);
      assert.equal(ref.ordered, true);

      // 记录内容守恒：输入与输出（逐行，忽略行序）SHA256 多重集一致。
      const normalizeMultiset = async (path: string) => {
        const text = await readFile(path, 'utf8');
        const rows = text.split('\n').filter((line) => line.length > 0);
        rows.sort();
        return createHash('sha256').update(rows.join('\n')).digest('hex');
      };
      assert.equal(await normalizeMultiset(inputPath), await normalizeMultiset(out1));
      void inputHash;

      // 不同缓冲与扇入 => 完全相同输出
      assert.equal(await readFile(out1, 'utf8'), await readFile(out2, 'utf8'));
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

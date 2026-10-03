import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runExternalSort } from '../src/sorter.js';
import type { SortOptions } from '../src/types.js';
import {
  cleanup,
  expectReferenceEqual,
  linesOf,
  makeTempProject,
  sortFile,
  tinyOptions
} from './helpers.js';
import { ErrorCode } from '../src/errors.js';

let project: string;

before(async () => {
  project = await makeTempProject();
});

after(async () => {
  await cleanup(project);
});

describe('外部归并排序', () => {
  it('空文件：产出空文件，0 行 0 段 0 轮', async () => {
    const { outputText, stats } = await sortFile(join(project, 'empty'), '', tinyOptions(), 'empty.ndjson');
    assert.equal(outputText, '');
    assert.deepEqual(
      { rows: stats.inputRows, segments: stats.segmentCount, rounds: stats.mergeRounds },
      { rows: 0, segments: 0, rounds: 0 }
    );
  });

  it('单行且末尾无换行', async () => {
    const dir = join(project, 'single');
    const { outputText } = await sortFile(dir, '{"v":3,"n":"你好"}', tinyOptions());
    assert.equal(outputText, '{"v":3,"n":"你好"}\n');
  });

  it('多键方向 + 空值位置（缺字段与 null 统一）', async () => {
    const dir = join(project, 'keys');
    const records = [
      { a: 2, b: '北京' },
      { a: 1 },
      { a: 2, b: null },
      { a: 1, b: '上海' },
      { a: 2, b: '广州' }
    ];
    const input = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const options = {
      keys: [
        { field: 'a', type: 'number', dir: 'asc', nulls: 'last' },
        { field: 'b', type: 'string', dir: 'desc', nulls: 'first' }
      ],
      bufferSize: 2,
      fanIn: 2,
      maxLineBytes: 65536
    };
    const { outputText } = await sortFile(dir, input, options);
    const out = linesOf(outputText).map((line) => JSON.parse(line));
    // a 升序；同 a 时 b 降序；b 空值始终最前（nulls=first 独立于 dir）
    assert.deepEqual(out, [
      { a: 1 }, // b 空值 first
      { a: 1, b: '上海' },
      { a: 2, b: null },
      { a: 2, b: '广州' },
      { a: 2, b: '北京' }
    ]);
  });

  it('同键记录保持原始行号顺序（稳定性），含完全重复记录', async () => {
    const dir = join(project, 'stable');
    const records = [
      { v: 5, tag: 'x0' },
      { v: 5, tag: 'x1' },
      { v: 5, tag: 'x1' },
      { v: 2, tag: 'z' },
      { v: 5, tag: 'x2' }
    ];
    const input = records.map((r) => JSON.stringify(r)).join('\n');
    const { outputText } = await sortFile(dir, input, tinyOptions());
    const tags = linesOf(outputText).map((line) => (JSON.parse(line) as { tag: string }).tag);
    assert.deepEqual(tags, ['z', 'x0', 'x1', 'x1', 'x2']);
  });

  it('中文字符串按确定性码元序比较，不依赖本机语言环境', async () => {
    const dir = join(project, 'cjk');
    const words = ['中文', '上海', '北京', 'abc', '成都', '广州'];
    const input = words.map((w) => JSON.stringify({ s: w })).join('\n') + '\n';
    const options = {
      keys: [{ field: 's', type: 'string', dir: 'asc', nulls: 'last' }],
      bufferSize: 2,
      fanIn: 2,
      maxLineBytes: 65536
    };
    const { outputText } = await sortFile(dir, input, options);
    const result = linesOf(outputText).map((line) => (JSON.parse(line) as { s: string }).s);
    const expected = [...words].sort((a, b) => {
    const len = Math.min(a.length, b.length);
      for (let i = 0; i < len; i++) {
        if (a.charCodeAt(i) !== b.charCodeAt(i)) return a.charCodeAt(i) - b.charCodeAt(i);
      }
      return a.length - b.length;
    });
    assert.deepEqual(result, expected);
  });

  it('强制多段多轮：bufferSize=2 fanIn=2，段数与轮数正确', async () => {
    const dir = join(project, 'rounds');
    const values = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
    const input = values.map((v) => JSON.stringify({ v })).join('\n') + '\n';
    const { stats, outputText } = await sortFile(dir, input, tinyOptions());
    assert.equal(stats.segmentCount, 5); // 10 行 / 缓冲 2
    assert.ok(stats.mergeRounds >= 2, `至少两轮，实际 ${stats.mergeRounds}`);
    const outValues = linesOf(outputText).map((line) => (JSON.parse(line) as { v: number }).v);
    assert.deepEqual(outValues, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('不同 bufferSize 与 fanIn 产出完全相同的结果', async () => {
    const dir = join(project, 'invariant');
    const records = Array.from({ length: 37 }, (_, i) => ({
      v: ((i * 37) % 11) - 5,
      s: `项${(i * 7) % 13}`,
      n: i % 5 === 0 ? null : (i % 7)
    }));
    const input = records.map((r) => JSON.stringify(r)).join('\n');
    const options: Record<string, unknown> = {
      keys: [
        { field: 'v', type: 'number', dir: 'desc', nulls: 'last' },
        { field: 's', type: 'string', dir: 'asc', nulls: 'first' },
        { field: 'n', type: 'number', dir: 'asc', nulls: 'last' }
      ],
      bufferSize: 3,
      fanIn: 2,
      maxLineBytes: 65536
    };
    const a = await sortFile(join(dir, 'a'), input, options, 'a.ndjson');
    const b = await sortFile(
      join(dir, 'b'),
      input,
      { ...options, bufferSize: 10, fanIn: 4 },
      'b.ndjson'
    );
    assert.equal(a.outputText, b.outputText);
    expectReferenceEqual(linesOf(a.outputText), input, options);
  });

  it('中途坏 JSON 返回源行号并终止，不产出成功结果', async () => {
    const dir = join(project, 'badjson');
    const input = '{"v":1}\n{not json}\n{"v":2}\n';
    await assert.rejects(
      sortFile(dir, input, tinyOptions(), 'bad.ndjson'),
      (err: unknown) => {
        const sorted = err as { code: string; line?: number };
        assert.equal(sorted.code, ErrorCode.BAD_JSON);
        assert.equal(sorted.line, 2);
        return true;
      }
    );
  });

  it('类型不符（number 收到字符串/NaN）返回源行号', async () => {
    const dir = join(project, 'badtype');
    const input = '{"v":1}\n{"v":"oops"}\n';
    await assert.rejects(
      sortFile(dir, input, tinyOptions(), 't.ndjson'),
      (err: unknown) => {
        const sorted = err as { code: string; line?: number };
        assert.equal(sorted.code, ErrorCode.TYPE_MISMATCH);
        assert.equal(sorted.line, 2);
        return true;
      }
    );
  });

  it('顶层不是对象（数组/数字/空行）报错并给出行号', async () => {
    const dir = join(project, 'notobject');
    const input = '{"v":1}\n[1,2,3]\n';
    await assert.rejects(
      sortFile(dir, input, tinyOptions(), 'n.ndjson'),
      (err: unknown) => (err as { code: string }).code === ErrorCode.NOT_OBJECT
    );
  });

  it('超长行报 E_LINE_TOO_LONG 并携带行号', async () => {
    const dir = join(project, 'longline');
    const longLine = JSON.stringify({ v: 1, pad: 'x'.repeat(500) });
    const input = `${longLine}\n{"v":2}\n`;
    const options = { ...tinyOptions(), maxLineBytes: 64 };
    await assert.rejects(
      sortFile(dir, input, options as Record<string, unknown>, 'l.ndjson'),
      (err: unknown) => {
        const sorted = err as { code: string; line?: number };
        assert.equal(sorted.code, ErrorCode.LINE_TOO_LONG);
        assert.equal(sorted.line, 1);
        return true;
      }
    );
  });

  it('失败不覆盖已有成功结果，且清理本次临时目录', async () => {
    const dir = join(project, 'keepold');
    const good = '{"v":2}\n{"v":1}\n';
    const first = await sortFile(join(dir, 'f1'), good, tinyOptions());
    const oldContent = await readFile(first.outputPath, 'utf8');

    // 用同一输出路径再次跑一个坏输入，模拟失败发布。
    const badInputPath = join(dir, 'f1', 'input.ndjson');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(badInputPath, '{"v":1}\nBROKEN\n', 'utf8');
      await assert.rejects(
      runExternalSort(
        badInputPath,
        first.outputPath,
        join(dir, 'f1', 'tmpwork'),
        first.options
      )
    );
    const stillThere = await readFile(first.outputPath, 'utf8');
    assert.equal(stillThere, oldContent);
    // 临时目录已清理
    const entries = await readdir(join(dir, 'f1')).catch((): string[] => []);
    assert.ok(!entries.includes('tmpwork'));
  });
});

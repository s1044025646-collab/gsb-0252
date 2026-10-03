import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { externalSort } from "../src/sorter";
import { compareRows } from "../src/compare";
import { parseRecord } from "../src/keys";
import { readLines } from "../src/lineReader";
import { SortConfig } from "../src/types";
import { generateNdjson } from "../src/demoGen";
import { Store } from "../src/db";
import { JobManager } from "../src/jobManager";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-sort-"));
}

function cfg(partial: Partial<SortConfig>): SortConfig {
  return {
    keys: [{ field: "a", type: "number", direction: "asc", nulls: "last" }],
    bufferRecords: 5,
    fanIn: 3,
    maxLineBytes: 1 << 20,
    ...partial,
  };
}

async function sortLines(lines: string[], config: SortConfig): Promise<string[]> {
  const dir = tmpdir();
  const input = path.join(dir, "in.ndjson");
  fs.writeFileSync(input, lines.join("\n") + (lines.length ? "\n" : ""));
  const out = path.join(dir, "out.ndjson");
  const result = await externalSort(input, out, config, path.join(dir, "tmp"), "t1");
  const content = fs.readFileSync(out, "utf8");
  for (const f of result.tempFiles) assert.ok(!fs.existsSync(f), "临时段应已清理");
  return content.length ? content.trimEnd().split("\n") : [];
}

test("多键多方向排序", async () => {
  const lines = [
    { a: 2, b: "x" },
    { a: 1, b: "y" },
    { a: 1, b: "x" },
    { a: 2, b: "a" },
  ].map((o) => JSON.stringify(o));
  const out = await sortLines(
    lines,
    cfg({
      keys: [
        { field: "a", type: "number", direction: "desc", nulls: "last" },
        { field: "b", type: "string", direction: "asc", nulls: "last" },
      ],
    })
  );
  assert.deepEqual(out, [lines[3], lines[0], lines[2], lines[1]]);
});

test("中文字符串按码元确定排序", async () => {
  const lines = ["中", "张", "abc", "阿", "Z"].map((s) => JSON.stringify({ s }));
  const out = await sortLines(
    lines,
    cfg({ keys: [{ field: "s", type: "string", direction: "asc", nulls: "last" }] })
  );
  const expected = [...lines].sort((x, y) => {
    const a = JSON.parse(x).s;
    const b = JSON.parse(y).s;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  assert.deepEqual(out, expected);
});

test("空值位置不随升降序反转", async () => {
  const lines = ['{"a":2}', "{}", '{"a":null}', '{"a":1}'];
  for (const dir of ["asc", "desc"] as const) {
    const out = await sortLines(
      lines,
      cfg({ keys: [{ field: "a", type: "number", direction: dir, nulls: "first" }] })
    );
    const first2 = out.slice(0, 2).map((l) => JSON.parse(l).a ?? null);
    assert.deepEqual(first2, [null, null], `nulls=first 在 ${dir} 下也应在前`);
  }
});

test("空文件产生空输出", async () => {
  const out = await sortLines([], cfg({}));
  assert.deepEqual(out, []);
});

test("单行文件", async () => {
  const out = await sortLines(['{"a":1}'], cfg({}));
  assert.deepEqual(out, ['{"a":1}']);
});

test("完全重复的记录全部保留且稳定", async () => {
  const lines = Array(20).fill('{"a":1}');
  const out = await sortLines(lines, cfg({ bufferRecords: 3 }));
  assert.equal(out.length, 20);
});

test("末尾无换行也能处理", async () => {
  const dir = tmpdir();
  const input = path.join(dir, "in.ndjson");
  fs.writeFileSync(input, '{"a":2}\n{"a":1}'); // 无末尾换行
  const out = path.join(dir, "out.ndjson");
  await externalSort(input, out, cfg({}), path.join(dir, "tmp"), "t2");
  assert.equal(fs.readFileSync(out, "utf8"), '{"a":1}\n{"a":2}\n');
});

test("中途坏行报错并带源行号", async () => {
  const dir = tmpdir();
  const input = path.join(dir, "in.ndjson");
  fs.writeFileSync(input, '{"a":1}\n{"a":2}\n坏行\n{"a":3}\n');
  const out = path.join(dir, "out.ndjson");
  await assert.rejects(
    externalSort(input, out, cfg({}), path.join(dir, "tmp"), "t3"),
    (e: any) => e.code === "BAD_JSON" && e.line === 3
  );
  assert.ok(!fs.existsSync(out), "失败不应产生输出文件");
});

test("类型不符报 TYPE_MISMATCH", async () => {
  const dir = tmpdir();
  const input = path.join(dir, "in.ndjson");
  fs.writeFileSync(input, '{"a":"文本"}\n');
  await assert.rejects(
    externalSort(input, path.join(dir, "o"), cfg({}), path.join(dir, "t"), "t4"),
    (e: any) => e.code === "TYPE_MISMATCH" && e.line === 1
  );
});

test("超长行报 LINE_TOO_LONG", async () => {
  const dir = tmpdir();
  const input = path.join(dir, "in.ndjson");
  fs.writeFileSync(input, '{"a":"' + "x".repeat(1000) + '"}\n');
  await assert.rejects(
    externalSort(input, path.join(dir, "o"), cfg({ maxLineBytes: 100 }), path.join(dir, "t"), "t5"),
    (e: any) => e.code === "LINE_TOO_LONG" && e.line === 1
  );
});

test("小样本与内存基准逐行一致", async () => {
  const keys: SortConfig["keys"] = [
    { field: "group", type: "number", direction: "asc", nulls: "last" },
    { field: "score", type: "number", direction: "desc", nulls: "first" },
    { field: "name", type: "string", direction: "asc", nulls: "last" },
  ];
  const lines: string[] = [];
  for (const l of generateNdjson({ lines: 500, seed: 7, hotKeyModulo: 5 })) lines.push(l);
  const config = cfg({ keys, bufferRecords: 17, fanIn: 3 });
  const out = await sortLines(lines, config);
  const expected = lines
    .map((l, i) => ({ l, k: parseRecord(l, i + 1, keys), n: i + 1 }))
    .sort((x, y) => compareRows(x.k, x.n, y.k, y.n, keys))
    .map((x) => x.l);
  assert.deepEqual(out, expected);
});

test("大样本有序、记录数与内容守恒;不同缓冲/扇入结果相同", async () => {
  const keys: SortConfig["keys"] = [
    { field: "group", type: "number", direction: "asc", nulls: "last" },
    { field: "score", type: "number", direction: "desc", nulls: "first" },
  ];
  const lines: string[] = [];
  for (const l of generateNdjson({ lines: 20000, seed: 99, hotKeyModulo: 50 })) lines.push(l);
  const dir = tmpdir();
  const input = path.join(dir, "big.ndjson");
  fs.writeFileSync(input, lines.join("\n") + "\n");

  const outputs: string[] = [];
  for (const [bufferRecords, fanIn] of [
    [500, 4],
    [1000, 16],
    [20000, 64],
  ] as const) {
    const out = path.join(dir, `out-${bufferRecords}-${fanIn}.ndjson`);
    const { stats } = await externalSort(
      input,
      out,
      cfg({ keys, bufferRecords, fanIn }),
      path.join(dir, "tmp"),
      `big-${bufferRecords}`
    );
    assert.equal(stats.inputLines, 20000);
    assert.equal(stats.outputLines, 20000);
    outputs.push(out);
  }
  const contents = outputs.map((p) => fs.readFileSync(p, "utf8"));
  assert.equal(contents[0], contents[1], "不同缓冲区应得到相同输出");
  assert.equal(contents[1], contents[2], "不同扇入应得到相同输出");

  // 有序性 + 稳定性
  let prev: { k: any[]; n: number } | null = null;
  let count = 0;
  const sorted = contents[0].trimEnd().split("\n");
  sorted.forEach((l, i) => {
    const k = parseRecord(l, i + 1, keys);
    if (prev) assert.ok(compareRows(prev.k, prev.n, k, i + 1, keys) <= 0, "输出必须有序");
    prev = { k, n: i + 1 };
    count++;
  });
  assert.equal(count, 20000);
  // 内容守恒:多重集合相等
  const multiset = (arr: string[]) => {
    const m = new Map<string, number>();
    for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  assert.deepEqual(multiset(sorted), multiset(lines));
});

test("同键记录保持输入次序(稳定性)", async () => {
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) lines.push(JSON.stringify({ g: i % 3, id: i }));
  const out = await sortLines(
    lines,
    cfg({ keys: [{ field: "g", type: "number", direction: "asc", nulls: "last" }], bufferRecords: 7, fanIn: 2 })
  );
  const ids = out.map((l) => JSON.parse(l).id);
  for (const g of [0, 1, 2]) {
    const seq = ids.filter((id) => id % 3 === g);
    const sortedSeq = [...seq].sort((a, b) => a - b);
    assert.deepEqual(seq, sortedSeq, `g=${g} 的 id 应保持原序`);
  }
});

test("失败任务不覆盖已有成功结果;SQLite 可查询历史", async () => {
  const dir = tmpdir();
  const store = new Store(path.join(dir, "data", "sort.db"));
  const jobs = new JobManager(store, {
    dataDir: path.join(dir, "data"),
    tmpDir: path.join(dir, "data", "tmp"),
    outDir: path.join(dir, "data", "outputs"),
  });
  const good = path.join(dir, "good.ndjson");
  fs.writeFileSync(good, '{"a":2}\n{"a":1}\n');
  const bad = path.join(dir, "bad.ndjson");
  fs.writeFileSync(bad, '{"a":1}\noops\n');

  const in1 = await jobs.registerInput(good);
  const j1 = await jobs.submitJob(in1.id, cfg({}));
  assert.equal(j1.status, "done");
  const resultPath = jobs.getResultPath(j1.id);
  const before = fs.readFileSync(resultPath, "utf8");

  const in2 = await jobs.registerInput(bad);
  const j2 = await jobs.submitJob(in2.id, cfg({}));
  assert.equal(j2.status, "failed");
  assert.equal(JSON.parse(j2.error!).code, "BAD_JSON");
  assert.equal(JSON.parse(j2.error!).line, 2);
  assert.equal(fs.readFileSync(resultPath, "utf8"), before, "旧结果不受影响");

  // 模拟重启:新建 Store 读取同一数据库
  store.close();
  const store2 = new Store(path.join(dir, "data", "sort.db"));
  const jobs2 = new JobManager(store2, {
    dataDir: path.join(dir, "data"),
    tmpDir: path.join(dir, "data", "tmp"),
    outDir: path.join(dir, "data", "outputs"),
  });
  assert.equal(jobs2.getJob(j1.id).status, "done");
  assert.equal(jobs2.getJob(j2.id).status, "failed");
  store2.close();
});

test("统计信息:行数、段数、归并轮数、限制", async () => {
  const dir = tmpdir();
  const input = path.join(dir, "in.ndjson");
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) lines.push(JSON.stringify({ a: 100 - i }));
  fs.writeFileSync(input, lines.join("\n") + "\n");
  const out = path.join(dir, "out.ndjson");
  const { stats } = await externalSort(
    input,
    out,
    cfg({ bufferRecords: 10, fanIn: 3 }),
    path.join(dir, "tmp"),
    "stats"
  );
  assert.equal(stats.inputLines, 100);
  assert.equal(stats.runs, 10);
  assert.ok(stats.mergeRounds >= 2, "10 段 fanIn=3 应多轮归并");
  assert.equal(stats.bufferRecords, 10);
  assert.equal(stats.fanIn, 3);
});

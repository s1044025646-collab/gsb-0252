import fs from "node:fs";
import path from "node:path";
import { Store } from "./db";
import { JobManager, defaultPaths } from "./jobManager";
import { generateNdjson } from "./demoGen";
import { readLines } from "./lineReader";

async function main() {
  const root = process.cwd();
  const paths = defaultPaths(root);
  const store = new Store(path.join(paths.dataDir, "sort.db"));
  const jobs = new JobManager(store, paths);

  // 1. 生成确定种子演示数据
  const inputFile = path.join(paths.dataDir, "demo-input.ndjson");
  fs.mkdirSync(paths.dataDir, { recursive: true });
  const ws = fs.createWriteStream(inputFile);
  const LINES = 5000;
  for (const line of generateNdjson({ lines: LINES, seed: 42, hotKeyModulo: 10 })) {
    ws.write(line + "\n");
  }
  ws.end();
  await new Promise<void>((r) => ws.once("close", r));
  console.log(`[1] 生成演示数据 ${LINES} 行 (seed=42): ${inputFile}`);

  // 2. 小缓冲区 + 小扇入,强制多段、多轮归并
  const input = await jobs.registerInput(inputFile);
  const job = await jobs.submitJob(input.id, {
    keys: [
      { field: "group", type: "number", direction: "asc", nulls: "last" },
      { field: "score", type: "number", direction: "desc", nulls: "first" },
      { field: "name", type: "string", direction: "asc", nulls: "last" },
    ],
    bufferRecords: 200,
    fanIn: 4,
    maxLineBytes: 1 << 20,
  });
  const report = jobs.getReport(job.id);
  console.log(`[2] 排序完成,统计:`);
  console.log(JSON.stringify(report.stats, null, 2));
  console.log(`    说明: bufferRecords 是记录缓冲上限(条数),不是进程硬内存上限`);

  // 3. 展示同键记录仍按原序排列
  const resultPath = jobs.getResultPath(job.id);
  let shown = 0;
  let prev: { group: number; score: number | null; name: string } | null = null;
  let streak: { id: number; line: number }[] = [];
  let lineNo = 0;
  console.log(`[3] 同键记录保持输入次序(示例):`);
  for await (const { line } of readLines(resultPath, 1 << 20)) {
    lineNo++;
    const o = JSON.parse(line);
    const key = { group: o.group, score: o.score ?? null, name: o.name };
    if (prev && key.group === prev.group && key.score === prev.score && key.name === prev.name) {
      streak.push({ id: o.id, line: lineNo });
    } else {
      if (streak.length >= 3 && shown < 3) {
        console.log(`    键 group=${prev!.group} score=${prev!.score} name=${prev!.name}: id 序列 ${streak.map((s) => s.id).slice(0, 8).join(",")}... (严格递增=原序)`);
        shown++;
      }
      streak = [{ id: o.id, line: lineNo }];
    }
    prev = key;
  }

  // 4. 演示失败不覆盖旧结果:构造含坏行的输入
  const badFile = path.join(paths.dataDir, "demo-bad.ndjson");
  fs.writeFileSync(badFile, '{"a":1}\n这不是JSON\n{"a":2}\n');
  const badInput = await jobs.registerInput(badFile);
  const badJob = await jobs.submitJob(badInput.id, {
    keys: [{ field: "a", type: "number", direction: "asc", nulls: "last" }],
    bufferRecords: 100,
    fanIn: 4,
    maxLineBytes: 1 << 20,
  });
  const badReport = jobs.getReport(badJob.id);
  console.log(`[4] 坏行演示: 状态=${badReport.status}, 错误=${JSON.stringify(badReport.error)}`);
  console.log(`    旧结果仍可读: ${fs.existsSync(resultPath)} (${resultPath})`);

  store.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

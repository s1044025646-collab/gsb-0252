import fs from "node:fs";
import path from "node:path";
import { Store } from "./db";
import { JobManager, defaultPaths, validateConfig } from "./jobManager";
import { SortError } from "./errors";
import { generateNdjson } from "./demoGen";

const root = process.cwd();
const paths = defaultPaths(root);
const store = new Store(path.join(paths.dataDir, "sort.db"));
const jobs = new JobManager(store, paths);

function argValue(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : undefined;
}

function print(x: unknown) {
  console.log(JSON.stringify(x, null, 2));
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "register": {
      const file = rest[0];
      if (!file) throw new SortError("INVALID_CONFIG", "用法: cli register <文件路径>");
      print(await jobs.registerInput(file));
      break;
    }
    case "inputs":
      print(store.listInputs());
      break;
    case "sort": {
      const inputId = Number(argValue("input"));
      const keysArg = argValue("keys");
      if (!inputId || !keysArg) {
        throw new SortError(
          "INVALID_CONFIG",
          '用法: cli sort --input=<id> --keys=\'[{"field":"group","type":"number","direction":"asc","nulls":"last"}]\' [--buffer=1000] [--fan-in=8] [--max-line-bytes=4194304]'
        );
      }
      const config = validateConfig({
        keys: JSON.parse(keysArg),
        bufferRecords: argValue("buffer") ? Number(argValue("buffer")) : undefined,
        fanIn: argValue("fan-in") ? Number(argValue("fan-in")) : undefined,
        maxLineBytes: argValue("max-line-bytes") ? Number(argValue("max-line-bytes")) : undefined,
      });
      const job = await jobs.submitJob(inputId, config);
      print(jobs.getReport(job.id));
      break;
    }
    case "status":
      print(jobs.getReport(rest[0]));
      break;
    case "jobs":
      print(store.listJobs().map((j) => jobs.getReport(j.id)));
      break;
    case "result": {
      const p = jobs.getResultPath(rest[0]);
      const out = argValue("out");
      if (out) {
        fs.copyFileSync(p, path.resolve(out));
        console.log(`已复制到 ${path.resolve(out)}`);
      } else {
        console.log(p);
      }
      break;
    }
    case "report":
      print(jobs.getReport(rest[0]));
      break;
    case "gen": {
      const lines = Number(argValue("lines") ?? "10000");
      const seed = Number(argValue("seed") ?? "42");
      const out = path.resolve(argValue("out") ?? path.join("data", "demo-input.ndjson"));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const ws = fs.createWriteStream(out);
      for (const line of generateNdjson({ lines, seed, hotKeyModulo: 20 })) {
        ws.write(line + "\n");
      }
      ws.end();
      await new Promise<void>((r) => ws.once("close", r));
      console.log(`已生成 ${lines} 行 -> ${out} (seed=${seed})`);
      break;
    }
    default:
      console.log(`用法: node dist/src/cli.js <命令>
  register <文件>            登记项目内输入文件
  inputs                   列出已登记输入
  sort --input=<id> --keys=<JSON> [--buffer=N] [--fan-in=N] [--max-line-bytes=N]
  status <jobId>           查询任务状态
  jobs                     列出全部任务
  result <jobId> [--out=文件]  取结果路径或复制结果
  report <jobId>           导出任务报告
  gen [--lines=N] [--seed=S] [--out=文件]   生成确定种子演示数据`);
  }
}

main()
  .catch((e) => {
    if (e instanceof SortError) {
      console.error(JSON.stringify({ error: e.toJSON() }));
      process.exitCode = 2;
    } else {
      console.error(e);
      process.exitCode = 1;
    }
  })
  .finally(() => store.close());

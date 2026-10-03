#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { SortService } from './service.js';
import { startServer } from './server.js';
import { generateDemoRecords, referenceSort, writeDemoNdjson } from './demo.js';
import { runExternalSort } from './sorter.js';
import { parseSortOptions } from './config.js';
import { SortError } from './errors.js';
import { createReadStream } from 'node:fs';

interface ParsedArgs {
  flags: Map<string, string>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags.set(token.slice(2, eq), token.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(token.slice(2), next);
          i++;
        } else {
          flags.set(token.slice(2), 'true');
        }
      }
    } else {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

function fail(err: unknown): never {
  if (err instanceof SortError) {
    const suffix = err.line !== undefined ? `（源行号 ${err.line}）` : '';
    console.error(`错误 [${err.code}] ${err.message}${suffix}`);
  } else if (err instanceof Error) {
    console.error(`错误 [E_INTERNAL] ${err.message}`);
  } else {
    console.error('错误 [E_INTERNAL] 未知错误');
  }
  process.exitCode = 1;
  throw err;
}

function dataDirFromFlags(flags: Map<string, string>): string {
  return resolve(flags.get('data-dir') ?? join(process.cwd(), '.ndjson-sort-data'));
}

function streamResultToStdout(path: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on('error', rejectPromise);
    stream.on('end', () => resolvePromise());
    stream.pipe(process.stdout);
  });
}

const USAGE = `NDJSON 大文件稳定外部排序 — 命令行

用法:
  ndjson-sort serve [--port 8080] [--data-dir 目录]
      启动 HTTP API 服务（默认自动选择空闲端口）。

  ndjson-sort register --file 输入.ndjson [--data-dir 目录]
      登记项目内输入文件，输出 fileId。

  ndjson-sort sort --file <fileId> --keys '<JSON>' [--buffer-size N] [--fan-in N] [--max-line-bytes N] [--data-dir 目录]
      提交排序并等待结束，输出 jobId 与状态。

  ndjson-sort status --job <jobId> [--data-dir 目录]
      查询任务状态。

  ndjson-sort result --job <jobId> [--out 输出路径] [--data-dir 目录]
      取结果：打印到 stdout 或写入 --out。

  ndjson-sort report --job <jobId> [--out 报告.json] [--data-dir 目录]
      导出结构化报告。

  ndjson-sort demo [--data-dir 目录]
      用确定种子生成演示数据，以极小缓冲强制多段多轮归并，
      并在终端展示同键记录保持原序。

排序键 JSON 示例:
  [{"field":"grp","type":"number","dir":"asc","nulls":"last"},
   {"field":"city","type":"string","dir":"desc","nulls":"first"},
   {"field":"score","type":"number","dir":"desc","nulls":"last"}]
`;

async function main(): Promise<void> {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return;
  }

  const dataDir = dataDirFromFlags(args.flags);
  const service = await SortService.create(dataDir);

  try {
    switch (command) {
      case 'serve':
        await cmdServe(service, args);
        break;
      case 'register':
        await cmdRegister(service, args);
        break;
      case 'sort':
        await cmdSort(service, args);
        break;
      case 'status':
        await cmdStatus(service, args);
        break;
      case 'result':
        await cmdResult(service, args);
        break;
      case 'report':
        await cmdReport(service, args);
        break;
      case 'demo':
        await cmdDemo(service);
        break;
      default:
        console.error(`未知命令: ${command}\n`);
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    if (command !== 'serve') service.close();
  }
}

async function cmdServe(service: SortService, args: ParsedArgs): Promise<void> {
  const portFlag = args.flags.get('port');
  const port = portFlag ? Number(portFlag) : undefined;
  if (portFlag && (port === undefined || !Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new SortError('E_INVALID_ARGS', '--port 必须是 0-65535 的整数');
  }
  const running = await startServer(service, port);
  console.log(`NDJSON 排序服务已启动: http://127.0.0.1:${running.port}`);
  console.log(`数据目录（仅限本项目）: ${service.paths.root}`);
  console.log('按 Ctrl+C 停止服务。');
  const shutdown = async () => {
    await running.close();
    service.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // 常驻
  await new Promise<void>(() => undefined);
}

async function cmdRegister(service: SortService, args: ParsedArgs): Promise<void> {
  const file = args.flags.get('file');
  if (!file) throw new SortError('E_INVALID_ARGS', 'register 需要 --file <输入文件>');
  const row = await service.registerFile(file);
  console.log(JSON.stringify(row, null, 2));
}

function buildOptionsFromFlags(args: ParsedArgs): Record<string, unknown> {
  const keysText = args.flags.get('keys');
  if (!keysText) throw new SortError('E_INVALID_ARGS', 'sort 需要 --keys <排序键 JSON>');
  let keys: unknown;
  try {
    keys = JSON.parse(keysText);
  } catch {
    throw new SortError('E_INVALID_ARGS', '--keys 不是合法 JSON');
  }
  const options: Record<string, unknown> = { keys };
  if (args.flags.has('buffer-size')) options.bufferSize = Number(args.flags.get('buffer-size'));
  if (args.flags.has('fan-in')) options.fanIn = Number(args.flags.get('fan-in'));
  if (args.flags.has('max-line-bytes')) options.maxLineBytes = Number(args.flags.get('max-line-bytes'));
  return options;
}

async function cmdSort(service: SortService, args: ParsedArgs): Promise<void> {
  const fileId = args.flags.get('file');
  if (!fileId) throw new SortError('E_INVALID_ARGS', 'sort 需要 --file <fileId>');
  const options = buildOptionsFromFlags(args);
  const view = await service.runJobAndWait(fileId, options);
  console.log(JSON.stringify(view, null, 2));
  if (view.status === 'failed') process.exitCode = 1;
}

async function cmdStatus(service: SortService, args: ParsedArgs): Promise<void> {
  const jobId = args.flags.get('job');
  if (!jobId) throw new SortError('E_INVALID_ARGS', 'status 需要 --job <jobId>');
  console.log(JSON.stringify(service.getJob(jobId), null, 2));
}

async function cmdResult(service: SortService, args: ParsedArgs): Promise<void> {
  const jobId = args.flags.get('job');
  if (!jobId) throw new SortError('E_INVALID_ARGS', 'result 需要 --job <jobId>');
  const path = service.getResultPath(jobId);
  const out = args.flags.get('out');
  if (out) {
    await mkdir(dirname(resolve(out)), { recursive: true });
    const content = await readFile(path);
    await writeFile(resolve(out), content);
    console.log(`结果已写入 ${resolve(out)}`);
  } else {
    await streamResultToStdout(path);
  }
}

async function cmdReport(service: SortService, args: ParsedArgs): Promise<void> {
  const jobId = args.flags.get('job');
  if (!jobId) throw new SortError('E_INVALID_ARGS', 'report 需要 --job <jobId>');
  const report = service.buildReport(jobId);
  const text = JSON.stringify(report, null, 2);
  const out = args.flags.get('out');
  if (out) {
    await mkdir(dirname(resolve(out)), { recursive: true });
    await writeFile(resolve(out), `${text}\n`, 'utf8');
    console.log(`报告已导出 ${resolve(out)}`);
  } else {
    console.log(text);
  }
}

async function cmdDemo(service: SortService): Promise<void> {
  const demoDir = join(service.paths.root, 'demo');
  await mkdir(demoDir, { recursive: true });
  const inputPath = join(demoDir, 'demo-input.ndjson');
  const outputA = join(demoDir, 'sorted-buf4-fan2.ndjson');
  const outputB = join(demoDir, 'sorted-buf7-fan3.ndjson');
  const tmpA = join(service.paths.tmp, 'demo-a');
  const tmpB = join(service.paths.tmp, 'demo-b');

  const records = generateDemoRecords(127, 20260252);
  await writeDemoNdjson(inputPath, records, { unterminatedLast: true });
  console.log(`已生成确定种子演示数据: ${inputPath}（${records.length} 行，末尾无换行）`);

  const options = parseSortOptions({
    keys: [
      { field: 'grp', type: 'number', dir: 'asc', nulls: 'last' },
      { field: 'city', type: 'string', dir: 'asc', nulls: 'first' },
      { field: 'score', type: 'number', dir: 'desc', nulls: 'last' }
    ],
    bufferSize: 4,
    fanIn: 2,
    maxLineBytes: 65536
  });

  const optionsB = { ...options, bufferSize: 7, fanIn: 3 };

  console.log('\n运行 A：bufferSize=4, fanIn=2（强制多段、多轮）');
  const statsA = await runExternalSort(inputPath, outputA, tmpA, options);
  console.log(`  输入行数=${statsA.inputRows} 初始段数=${statsA.segmentCount} 归并轮数=${statsA.mergeRounds}`);

  console.log('运行 B：bufferSize=7, fanIn=3（不同缓冲与扇入，输出必须一致）');
  const statsB = await runExternalSort(inputPath, outputB, tmpB, optionsB);
  console.log(`  输入行数=${statsB.inputRows} 初始段数=${statsB.segmentCount} 归并轮数=${statsB.mergeRounds}`);

  const linesA = (await readFile(outputA, 'utf8')).split('\n').filter((line) => line.length > 0);
  const linesB = (await readFile(outputB, 'utf8')).split('\n').filter((line) => line.length > 0);
  const expected = referenceSort(records.map((record) => JSON.stringify(record)), options);

  const sameA = JSON.stringify(linesA) === JSON.stringify(expected);
  const sameB = JSON.stringify(linesB) === JSON.stringify(expected);
  console.log(`\n与独立内存基准逐行一致: A=${sameA} B=${sameB}`);
  if (!sameA || !sameB) throw new SortError('E_INTERNAL', '演示输出与基准不一致');

  console.log('\n前 12 行（注意 grp 相同的记录按 idx 严格保持输入原序）：');
  for (const line of linesA.slice(0, 12)) {
    const record = JSON.parse(line) as { grp: number; city: string; score: number | null; idx: number };
    console.log(`  grp=${record.grp}  city=${record.city}  score=${record.score === null ? 'null' : record.score}  idx=${record.idx}`);
  }
  console.log(`\n排序结果文件:\n  ${outputA}\n  ${outputB}`);
}

main().catch(fail);

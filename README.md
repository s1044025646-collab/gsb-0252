# NDJSON 大文件稳定外部排序后端

Windows 本地可运行的 **NDJSON 大文件稳定外部排序**服务，只提供 HTTP API 与命令行（CLI）。
使用 TypeScript + Node.js（内置 `node:sqlite`）实现，**不依赖 Docker、WSL、任何在线服务或第三方原生模块**。

当记录文件比允许的内存缓冲区更大时，服务采用自实现的
「分块排序 → 有序临时段 → 有界多路归并（必要时分轮）」完成排序，
输出内容相同、顺序确定的新文件。**排序不使用系统 `sort`，也不使用 SQLite `ORDER BY`**；
SQLite 只负责保存配置、任务状态、输入摘要与结果路径。

---

## 1. 功能边界

**做什么**

- 逐行读取 NDJSON；每行必须是一个 **顶层 JSON 对象**（数组、数字、字符串等一律拒绝）。
- 支持多个排序键，逐键指定：
  - 字段名（仅顶层字段，不支持嵌套路径）；
  - 类型 `number`（仅接受有限 JSON 数值，`NaN`/`Infinity` 不可能由合法 JSON 产生，非 number 类型报错）或 `string`；
  - 方向 `asc` / `desc`；
  - 空值位置 `nulls: first | last`。
- 缺字段与 `null` **统一视为空值**；空值位置由 `nulls` 决定，**不随升降序反转**。
- 字符串采用公开的确定性序关系：按 **UTF-16 码元**逐元素比较，**不依赖本机语言环境**（不使用 `localeCompare`/`Intl`）。
    对由有效 Unicode 标量值组成的字符串，这等价于按码点排序；中、英、emoji 混排结果在任何机器上一致。
- 所有有效记录全部保留，包括完全重复记录；不做清洗、过滤、聚合、关联或全文检索。

**稳定性**

每条记录在读取时获得 1 基源行号；所有排序键全部相等时以源行号决胜，
因此同键记录（含完全重复行）严格保持输入相对次序。

**错误处理**

- 坏 JSON、顶层不是对象、键类型不符、单行超长，均返回 **源行号** 并终止本次排序；
- 不会跳过坏行，也不会产出/发布“成功”结果；
- 正式输出先写到项目内临时文件，全部完成后原子 `rename` 发布；
  失败时**不会覆盖已有成功结果**；
- 只清理本次任务创建的临时段（以及启动时本项目临时目录中的遗留段）。

---

## 2. 外部排序算法与“限制”的真实含义

1. **分块排序（run production）**：流式读取输入，内存中最多保留 `bufferSize` 条记录
   （每条保存键数组、行号与原始行文本）。填满后在内存中稳定排序并整体落盘成一个有序临时段。
2. **有界多路归并**：每一轮把段分组，每组最多合并 `fanIn` 个段；
   归并时每组至多同时打开 `fanIn` 个段读取器，用最小堆选最小行。
3. **分轮**：若段数超过 `fanIn`，一轮无法收敛，则对本轮产物再进行下一轮，直到只剩一个有序段。
4. **发布**：把最终有序段逐行写回原始 JSON 文本（`每行原文 + "\n"`）到暂存文件，再原子重命名。

> **重要限制说明**：`bufferSize` 是**排序记录缓冲条数上限**，不是整个 Node.js 进程的
> 硬内存上限。进程实际占用还包括：V8/Node 运行时本身、每个键数组与字符串对象开销、
> 流式 I/O 缓冲（默认 64KB 读块、1MB 段写缓冲等）以及归并时每路读取器的读块。
> 要压低峰值内存，应调小 `bufferSize` 与 `fanIn`，但无论调多小，进程仍有运行时基线开销。

单行大小由 `maxLineBytes` 限制（默认 1 MiB，最大 64 MiB）；超限行在读取阶段即报错并给出行号。

任务报告包含：输入行数、初始段数、归并轮数、实际使用的 `bufferSize` / `fanIn` / `maxLineBytes`。

---

## 3. 目录结构

项目数据目录默认是当前工作目录下的 `.ndjson-sort-data`，可用 `--data-dir` 自定义：

```
<data-dir>/
  app.sqlite        # SQLite 数据库（配置/状态/输入摘要/结果路径）
  inputs/           # 登记后复制进来的输入文件副本
  results/          # 已发布的正式结果（按 jobId 命名）
  tmp/<jobId>/      # 每次任务的有序临时段与暂存结果（成功/失败后清理）
```

服务停止与临时清理**只作用于该数据目录**，不会触碰目录之外的文件。

---

## 4. 环境要求

- Windows（也适用于其他平台），Node.js **>= 22.5**（开发与验证使用 Node v25）。
  排序与数据库均使用 Node 内置能力（`node:sqlite` 为实验模块，运行时会打印一条 ExperimentalWarning，可忽略）。
- 无需联网、无需 Docker/WSL。

安装：

```powershell
npm install
```

## 5. 构建 / 测试 / 启动 / 演示

```powershell
npm run build     # TypeScript 编译到 dist/
npm test          # 编译并运行 node:test 全部测试（22 个用例）
npm start         # 启动 HTTP 服务（默认自动选择空闲端口）
npm run demo      # 确定种子演示：小缓冲强制 32 段、5 轮归并，并展示稳定性
```

演示会用固定种子生成 127 行数据（末尾无换行），分别用
`bufferSize=4,fanIn=2` 与 `bufferSize=7,fanIn=3` 排序，
与独立内存基准逐行比对，并在终端打印同键记录的原始顺序。

---

## 6. HTTP API

服务默认绑定 `127.0.0.1`；`--port` 可指定端口（被占用或未指定时由操作系统分配空闲端口），
启动日志会打印实际端口。所有请求/响应均为 JSON（结果下载为 `application/x-ndjson`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET  | `/health` | 健康检查 |
| POST | `/files` | 登记输入文件。body：`{"path": "C:\\data\\in.ndjson"}`，流式复制并计算 SHA256/大小 |
| GET  | `/files` | 列出已登记文件 |
| GET  | `/files/:id` | 查询单个文件摘要 |
| POST | `/files/:id/sort` | 提交排序任务（异步，返回 202 与任务对象） |
| GET  | `/jobs?status=done` | 列出任务，可按状态过滤 |
| GET  | `/jobs/:id` | 查询任务状态、错误（含源行号）、统计 |
| GET  | `/jobs/:id/result` | 下载已完成结果（流式 NDJSON） |
| GET  | `/jobs/:id/report` | 导出结构化报告（任务 + 输入摘要 + 结果大小） |

提交排序 body 示例：

```json
{
  "keys": [
    { "field": "grp",   "type": "number", "dir": "asc",  "nulls": "last" },
    { "field": "city",  "type": "string", "dir": "asc",  "nulls": "first" },
    { "field": "score", "type": "number", "dir": "desc", "nulls": "last" }
  ],
  "bufferSize": 1000,
  "fanIn": 8,
  "maxLineBytes": 1048576
}
```

字段默认值：`dir` 默认 `asc`；`nulls` 默认随方向为 `asc→first`、`desc→last`；
`bufferSize` 默认 1000（1–1,000,000）；`fanIn` 默认 8（2–1024）；
`maxLineBytes` 默认 1,048,576（1–67,108,864）。

PowerShell 调用示例：

```powershell
# 启动（另开一个终端执行后续命令，端口以启动日志为准）
npm start -- --port 8080

# 登记
Invoke-RestMethod -Method Post http://127.0.0.1:8080/files -ContentType 'application/json' `
  -Body '{"path":"E:\\data\\input.ndjson"}'

# 提交排序
Invoke-RestMethod -Method Post http://127.0.0.1:8080/files/<fileId>/sort `
  -ContentType 'application/json' `
  -Body '{"keys":[{"field":"v","type":"number"}],"bufferSize":500,"fanIn":4}'

# 查询 / 结果 / 报告
Invoke-RestMethod http://127.0.0.1:8080/jobs/<jobId>
Invoke-WebRequest  http://127.0.0.1:8080/jobs/<jobId>/result -OutFile sorted.ndjson
Invoke-RestMethod http://127.0.0.1:8080/jobs/<jobId>/report | ConvertTo-Json -Depth 6
```

## 7. CLI

```powershell
node dist/src/cli.js serve [--port 8080] [--data-dir DIR]
node dist/src/cli.js register --file E:\data\input.ndjson [--data-dir DIR]
node dist/src/cli.js sort --file <fileId> --keys '<JSON>' [--buffer-size N] [--fan-in N] [--max-line-bytes N]
node dist/src/cli.js status --job <jobId>
node dist/src/cli.js result --job <jobId> [--out sorted.ndjson]
node dist/src/cli.js report --job <jobId> [--out report.json]
node dist/src/cli.js demo
```

`sort` 会提交任务并阻塞等待结束，随后以 JSON 打印任务（含统计或错误行号）；
失败时进程退出码为 1。

## 8. 错误码

| 错误码 | 含义 |
| --- | --- |
| `E_INVALID_ARGS` | 参数非法（键配置、bufferSize、fanIn、maxLineBytes 等） |
| `E_FILE_NOT_FOUND` / `E_NOT_A_FILE` | 登记路径不存在或不是普通文件 |
| `E_BAD_JSON` | 某行不是合法 JSON（含源行号） |
| `E_NOT_OBJECT` | 某行顶层不是 JSON 对象（含源行号） |
| `E_TYPE_MISMATCH` | 排序键声明类型与实际值不符（含源行号） |
| `E_LINE_TOO_LONG` | 单行超过 `maxLineBytes`（含源行号） |
| `E_NOT_FOUND` | 文件 / 任务不存在 |
| `E_JOB_NOT_DONE` | 任务尚未成功完成，无法取结果 |
| `E_RESULT_MISSING` | 数据库显示成功但结果文件缺失 |
| `E_IO_ERROR` / `E_INTERNAL` | IO 错误 / 内部错误 |

错误响应统一形如：`{"error": {"code": "...", "message": "...", "line": 123}}`。

## 9. 测试覆盖

- 多键方向、空值位置、缺字段与 null 统一、中文字符串序；
- 空文件、单行、末尾无换行、完全重复记录、稳定性（行号决胜）；
- 强制多段多轮、不同 `bufferSize`/`fanIn` 输出逐字节一致；
- 中途坏 JSON、类型不符、非对象、超长行均返回源行号且不发布结果；
- 失败后旧成功结果仍可读、临时目录被清理；
- HTTP API 全流程、错误码、SQLite 重启后可查已完成记录；
- 5 万行大样本：独立内存基准核对有序性、记录数守恒、记录内容多重集守恒。

## 10. 已知假设与限制

- 输入按 UTF-8 解码；行终止符支持 `\n` 与 `\r\n`，单独 `\r` 不作为换行（NDJSON 约定）。
- 比较意义上的“字符串序”采用 UTF-16 码元序（确定性、与区域设置无关），不是某地区词典序。
- 结果文件每行以 `\n` 结尾（包括来自“末尾无换行”输入的最后一行）；记录文本本身不做任何改写。
- 任务在同一服务进程内异步执行；进程在任务执行中被强杀时，临时段在下次启动时清理，
  任务状态可能停留在 `running`（可凭报告与结果文件判断真实结果）。
- 本项目只做后端，不含任何前端页面。

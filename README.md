# NDJSON 稳定外部排序后端

Windows 本地运行的大文件 NDJSON 排序服务:在受限记录缓冲区下,把比内存缓冲区更大的
NDJSON 文件按指定顶层字段稳定排序,输出内容相同、顺序确定的新文件。纯 TypeScript +
Node.js + SQLite(`node:sqlite` 内置模块),只提供 HTTP API 与 CLI,无 Docker / WSL /
外部服务依赖。

## 功能与约束

- 每行必须是 JSON 对象;只支持顶层字段;不做清洗、过滤、聚合、关联或全文检索。
- 多排序键,每个键可指定:`type`(`number`/`string`)、`direction`(`asc`/`desc`)、
  `nulls`(`first`/`last`)。
- 缺字段与 `null` 统一视为空值;空值位置固定,**不随升降序反转**。
- 数字键只接受有限 JSON 数值;字符串按 UTF-16 码元序(公开、确定性、不依赖本机语言环境)。
- 所有有效记录全部保留,包括完全重复的记录;所有键相等时按原始行号保持输入次序(稳定排序)。
- 自行实现分块排序 + 有序临时段 + 堆式多路归并;**不**把全文件读入数组,也不用系统
  sort 或 SQLite `ORDER BY` 完成主要排序。
- 段数超过单轮扇入上限时自动分轮归并。
- 发现坏 JSON / 非对象行 / 类型不符 / 超长行时,返回源行号并终止本次排序,绝不跳过坏行。
- 正式输出先写项目内临时文件,全部完成后 `rename` 原子发布;失败不覆盖已有成功结果;
  只清理由本次任务创建的临时段(文件名含任务 ID)。
- SQLite 持久化排序配置、任务状态、输入摘要(路径/大小/SHA-256)与结果路径,重启后可查询历史。

## 内存模型说明

`bufferRecords` 是**记录缓冲上限(条数)**,不是整个 Node 进程的硬内存上限。实际占用还
取决于单行大小,因此另有 `maxLineBytes` 限制单行字节数(默认 4 MiB),超限即报错终止。

## 快速开始

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试
npm run demo      # 端到端演示(多段多轮归并 + 稳定性 + 失败保护)
npm start         # 启动 HTTP 服务(默认自动选空闲端口)
```

## CLI

```powershell
# 生成确定种子演示数据
node dist/src/cli.js gen --lines=10000 --seed=42 --out=data/input.ndjson

# 登记输入文件(计算大小与 SHA-256 摘要)
node dist/src/cli.js register data/input.ndjson

# 提交排序(同步执行);PowerShell 中 JSON 参数建议用单引号
node dist/src/cli.js sort --input=1 '--keys=[{"field":"group","type":"number","direction":"asc","nulls":"last"},{"field":"name","type":"string","direction":"desc","nulls":"first"}]' --buffer=1000 --fan-in=8

# 查询 / 取结果 / 导出报告
node dist/src/cli.js status <jobId>
node dist/src/cli.js result <jobId> --out=sorted.ndjson
node dist/src/cli.js report <jobId>
node dist/src/cli.js jobs
```

## HTTP API

默认端口为 0(自动选空闲端口),可用 `--port=8123` 或环境变量 `PORT` 指定。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/inputs` | 登记输入文件,body: `{"path": "..."}` |
| GET | `/inputs` | 列出已登记输入 |
| POST | `/jobs` | 提交排序,body: `{"inputId": 1, "keys": [...], "bufferRecords": N, "fanIn": N, "maxLineBytes": N}` |
| GET | `/jobs` | 列出全部任务 |
| GET | `/jobs/:id` | 查询任务状态 |
| GET | `/jobs/:id/report` | 导出报告(配置、统计、错误、结果路径) |
| GET | `/jobs/:id/result` | 下载排序结果(NDJSON) |

排序键对象:`{"field": "score", "type": "number", "direction": "desc", "nulls": "first"}`,
`direction` 默认 `asc`,`nulls` 默认 `last`。

报告中的统计包含:输入行数、段数、归并轮数、实际使用的 `bufferRecords` / `fanIn` /
`maxLineBytes` 上限与输出行数。

## 错误码

| 错误码 | 含义 |
| --- | --- |
| `BAD_JSON` | 某行不是合法 JSON(含空行),带源行号 |
| `NOT_OBJECT` | 某行不是 JSON 对象,带源行号 |
| `TYPE_MISMATCH` | 字段类型与声明不符(数字键要求有限 JSON 数值),带源行号 |
| `LINE_TOO_LONG` | 单行超过 `maxLineBytes`,带源行号 |
| `INVALID_CONFIG` | 排序配置 / 请求体不合法 |
| `INPUT_NOT_FOUND` | 输入文件或未登记的输入 |
| `JOB_NOT_FOUND` | 任务不存在 |
| `JOB_NOT_FINISHED` | 任务尚未成功完成就取结果 |
| `INTERNAL_ERROR` | 其他内部错误 |

## 目录结构

```
data/
  sort.db        # SQLite:inputs 与 jobs 表
  tmp/           # 临时段与未发布的输出(仅本次任务,成功后清理)
  outputs/       # 已发布的结果文件
src/
  sorter.ts      # 分块排序 + 段文件 + 堆式多路归并(核心)
  compare.ts     # 确定性比较器(空值位置固定、行号兜底稳定)
  lineReader.ts  # 流式逐行读取,限制单行大小
  keys.ts        # 行解析与键提取(坏行带行号报错)
  jobManager.ts  # 任务编排、原子发布、临时文件清理
  db.ts          # SQLite 持久化
  server.ts      # HTTP API
  cli.ts         # 命令行
  demoGen.ts     # 确定种子演示数据生成器(mulberry32)
  demo.ts        # 端到端演示脚本
test/
  sorter.test.ts # 15 个测试(见下)
```

## 测试覆盖

多键多方向、中文字符串码元序、空值位置不随方向反转、空文件、单行、完全重复记录、
末尾无换行、中途坏行(带行号)、类型不符、超长行、小样本与内存基准逐行比较、
大样本(2 万行)有序性与记录数/内容守恒、不同缓冲区与归并扇入结果一致、同键记录
保持输入次序、失败不覆盖旧结果、SQLite 重启后可查询、统计信息正确性。

## 已知限制

- 任务同步执行(提交即跑完才返回),没有并发队列与取消机制。
- 只支持顶层字段,不支持嵌套路径。
- 字符串序为 UTF-16 码元序,不是语言环境感知的中文拼音/笔画序。
- `bufferRecords` 不限制 Node 进程总内存;超大单行仍受 `maxLineBytes` 约束。
- 中间段文件约为输入大小的数倍(含键与行号),需要足够磁盘空间。

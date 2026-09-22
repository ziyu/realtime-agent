# 通用 Computer Use：CLI 与 HTTP API

日期：2026-09-21。API 版本：`1`。

Computer Use 接收自然语言目标，由现有 JEV / System One、LLM / System Two 和 Cua Driver 决定并执行所需操作。CLI、HTTP 调用者和网页共享同一运行时。调用不要求打开控制台、不要求预选窗口，也不需要为每一种应用写单独的工作流。

本接口定义任务如何提交、控制和读取结果；具体目标是否能完成由当前模型、应用现场和 Driver 的实际能力决定。某个应用的专项演示不是这个通用接口的调用前提。

## 启动服务

在连接实际桌面的主机上，从仓库根目录启动：

```powershell
pnpm dev:computer:live
# pnpm 未加入 PATH：
npm exec --yes --package=pnpm@11.1.2 -- pnpm dev:computer:live
```

默认地址为 `http://127.0.0.1:3110`。已有模型配置沿用不变；需要时先运行 `pnpm check:computer`。修改服务端代码后需重启服务加载新版路由。服务拥有一个 Cua runtime，任务执行在这台主机的实际桌面。网页是可选的观察和手动接管入口。

接口当前只监听本机，`localhost` / `127.0.0.1` 可调用；不提供未经认证的远程桌面入口。任务记录保存在服务进程内存中。

## CLI

根目录的 `scripts/computer.mjs` 只使用 Node 内置能力和 HTTP，不加载 Cua、模型密钥或 `.env`。适合从其他 Agent、脚本或工具中调用。

```powershell
# 服务启动后，在另一个终端调用；无需打开网页
node scripts/computer.mjs health
node scripts/computer.mjs capabilities
node scripts/computer.mjs run "切换到目标应用，按当前要求完成操作并核对结果" --wait

# 只提交，立即取得 task.id
node scripts/computer.mjs run "你的自然语言目标" --request-id my-task-001

# 以下 <task-id> 替换为返回的 task.id
node scripts/computer.mjs status <task-id>
node scripts/computer.mjs wait <task-id> --timeout-ms 300000
node scripts/computer.mjs stop <task-id>
node scripts/computer.mjs resume <task-id> --wait
node scripts/computer.mjs result <task-id>
node scripts/computer.mjs trace <task-id>
node scripts/computer.mjs list
```

也可使用 `pnpm computer run "目标" --wait`；需要严格解析 stdout 时，直接调用 `node scripts/computer.mjs`，避免包管理器自身输出混入结果。应用目录入口为 `node scripts/computer-cli.mjs`，根目录包装器调用同一实现。

| 选项 | 含义 |
| --- | --- |
| `--url http://127.0.0.1:3110` | 指定服务 origin；优先于 `COMPUTER_URL` 环境变量。 |
| `--wait` | `run` / `resume` 提交后等待；不加时立即返回任务。 |
| `--timeout-ms 300000` | 客户端等待期限，默认 5 分钟；独立于服务端任务预算。 |
| `--poll-ms 500` | 查询间隔，范围 50–10000 ms。 |
| `--request-id my-task-001` | `run` 使用的幂等标识；省略时生成 UUID，并输出到 stderr。 |
| `--stdin` | `run` 从标准输入读取完整 UTF-8 目标，与位置参数互斥。 |
| `--help` | 打印完整帮助，不连接服务。 |

普通结果以一行 JSON 输出到 stdout；提交标识、进展及错误以 JSON 输出到 stderr。`run` / `status` / `wait` / `stop` / `resume` 返回 `{task: ...}`。`result` 和 `trace` 与 HTTP 响应一致。

| 退出码 | 含义 |
| --- | --- |
| `0` | 提交或查询成功；等待命令则表示任务 `completed`。 |
| `1` | 参数、连接、HTTP API 或响应错误。 |
| `2` | 等待结束时任务为 `blocked` 或 `cancelled`，stdout 仍包含任务记录。 |
| `3` | 客户端等待超时，stderr 包含任务 ID；远端任务没有被自动停止。 |
| `130` | Ctrl+C 中断本地调用/等待；没有自动发送停止命令。 |

等待超时、客户端关闭或网络响应丢失，都不能证明远端操作没有发生。使用原 task ID 查询；提交响应丢失时，可用同一 `--request-id` 和相同目标再次提交以获得原任务，不要生成新标识盲目重试。

## HTTP 接口

请求和响应使用 JSON。所有写请求设置 `Content-Type: application/json`，没有参数的停止/继续请求发送 `{}`。

| 方法与路径 | 请求 / 响应 |
| --- | --- |
| `GET /api/v1/health` | `{apiVersion:"1", ready, backend, decisionProtocol, driverVersion}`。 |
| `GET /api/v1/capabilities` | 模型就绪状态、图像能力、任务限制、实际提供的工具 schema。读取不触发模型或动作。 |
| `POST /api/v1/tasks` | 请求 `{goal:"自然语言目标"}`；返回 HTTP 202、`{task,replayed:false}` 和 `Location`。 |
| `GET /api/v1/tasks` | 返回 `{tasks:[...]}`，最新任务在前。 |
| `GET /api/v1/tasks/:id` | 返回 `{task}`。 |
| `POST /api/v1/tasks/:id/stop` | 仅停止此 ID 的任务，返回 `{task}`；不会误停后续任务。 |
| `POST /api/v1/tasks/:id/resume` | 从实际现场继续目标，返回 HTTP 202 和新的 `{task}`；`task.resumedFrom` 引用原 ID。 |
| `GET /api/v1/tasks/:id/result` | `{taskId,status,result,pendingOperation}`；未完成时 `result:null`。 |
| `GET /api/v1/tasks/:id/trace` | `{task,actions,evidence,history,truncated,limits}`，只返回此任务的记录。 |

提交接口支持 `Idempotency-Key` 请求头，格式为 1–128 个字母、数字或 `. _ : -`。相同 key 与相同规范化目标返回 HTTP 200、原 task ID 和 `replayed:true`；相同 key 对应不同目标返回 409。幂等记录与任务一起保留在内存，不跨进程重启，也不提供底层 GUI 副作用的 exactly-once 保证。

一个桌面当前只运行一个自主任务，没有隐藏的多任务队列。任务仍 active，或仍有未结束的原生输入时，新的 v1 提交返回 `409 computer_busy`。调用者明确停止后再提交新目标。网页的既有“新目标替换当前任务”行为保留，被替换任务可通过 v1 查询到 `cancelled` 和 `supersededBy`。

### 任务记录

返回类型如下；所有时间为 UTC Unix 毫秒数。

```ts
interface ComputerTask {
  id: string;
  goal: string;
  status: 'active' | 'completed' | 'blocked' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  steps: number;
  progress: { phase: string; message: string; updatedAt: number };
  error: string | null;
  pendingOperation: { id: string; status: string; tool: string | null } | null;
  result: {
    summary: string;
    verification: 'observed-data' | 'model-visual' | null;
    evidenceIds: string[];
  } | null;
  resumedFrom: string | null;
  supersededBy: string | null;
}
```

`active` 表示任务已接受并在运行，包括观察、规划和执行阶段。`blocked` 表示需要处理当前原因后才能继续。`cancelled` 表示后续任务已停止；仍有 `pendingOperation` 时，不能据此假定已发送操作已撤销。`completed` 的结果保留运行时核对方式：`observed-data` 为结构化观察核对，`model-visual` 为模型对实际截图的判断。

停止接口可重复调用。使用旧 ID 停止时，只影响旧任务，不影响当前其他任务。继续返回新 task ID，保留原记录和原目标，并重新观察现场；调用者应改为跟踪响应中的新 ID。

保留最近 32 个任务。每个任务最多保留 180 项操作、24 项证据和 150 条历史，超出时 `trace.truncated=true`；证据本身也可能带有投影截断标记。服务重启或任务超出保留范围后，查询返回 404。轨迹包含任务、工具参数和观察内容，不包含截图 base64。需要长期留存的调用者应自行存储返回结果。

### 错误

v1 的错误统一为 `{error:{code,message}}`。输入错误 400，来源拒绝 403，未知或已清理任务 404，桌面占用/幂等冲突/不允许继续的状态 409，非 JSON 写请求 415，服务异常 503。错误不会被当作成功任务结果返回。

## 调用示例

PowerShell：

```powershell
$computerOrigin = 'http://127.0.0.1:3110'
$requestBody = @{ goal = '在当前电脑上完成我指定的操作，并报告实际结果' } | ConvertTo-Json
$created = Invoke-RestMethod -Method Post -Uri "$computerOrigin/api/v1/tasks" `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($requestBody))
$computerTaskId = $created.task.id
Invoke-RestMethod -Uri "$computerOrigin/api/v1/tasks/$computerTaskId"
```

Python 调用方只需要标准库；没有窗口或应用名称的硬编码：

```python
import json
import time
import uuid
import urllib.request

origin = "http://127.0.0.1:3110"

def request(path, body=None, headers=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        origin + path,
        data=data,
        headers={"Content-Type": "application/json", **(headers or {})},
        method="GET" if body is None else "POST",
    )
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.load(response)

def computer_use(goal: str, wait_seconds: float = 300):
    if not goal.strip():
        raise ValueError("goal must not be empty")
    task = request("/api/v1/tasks", {"goal": goal},
                   {"Idempotency-Key": str(uuid.uuid4())})["task"]
    deadline = time.monotonic() + wait_seconds
    while task["status"] == "active":
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Local wait timed out; task {task['id']} remains on the server")
        time.sleep(0.5)
        task = request(f"/api/v1/tasks/{task['id']}")["task"]
    return task  # completed / blocked / cancelled; inspect status and result
```

## 本轮验证

新增 `tests/cua-api.test.ts` 和 `tests/cua-cli.test.ts`，通过真实本地 HTTP 服务与 CLI 子进程验证通用目标输入、JSON 结果、幂等、并发冲突、按 ID 停止/继续、迟到执行结果、历史结果、UTF-8 stdin、退出码和等待超时。设备和模型明确注入夹具，测试不启动实际 Cua 设备操作、不读取密钥、不调用真实模型，也不运行应用专项任务。

本轮已运行 API 6 项、CLI 4 项，全部通过；同期 TypeScript 检查通过。随后补充了继续任务的操作归属判断和 stdin 的中断处理。包含这些收尾改动的最终类型/原有运行时与网页兼容性复跑，被执行工具返回“无法确定请求的安全状态”拦截，未执行；因此不将最终版本的全套回归标为通过。新增代码和文档已做源码核对，已有服务需重启后加载 v1 路由。

旧网页 `/api/goal`、`/api/state`、`/api/stop`、`/api/resume` 保留，任务状态进入同一登记表。底层真实任务的历史验证状态仍记录在 [Cua 接入记录](cua-computer-use.md)，不能把 API 契约验证等同于所有桌面目标均已通过实测。

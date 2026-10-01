# praxisd ACP 子命令实现规格（Rust 侧交接文档）

> **状态**：交接规格（Handoff Spec）。stub 优先接入已在 `praxisd-acp-harness` 分支落地
> （提交 `0a0b28a`，242 门禁测试全绿，端到端已验证）；本文档是把 stub 的 wire 契约
> 翻译成 PraxisCode rust 侧（`praxisd acp` 子命令）的实现与验收依据。
> **规范来源**：`scripts/dev/praxisd_acp_stub.py` 的线上行为即金标准（验收样例）；
> 上位规程见 [harness-onboarding.md](harness-onboarding.md)（praxisd worked example 一节）。

## 1. 目的与范围

PraxisCode 的 Rust 守护进程（praxisd）实现一个 **ACP v1 stdio 子命令**，使 KiroCrew
把整个产品壳（dashboard / 桌面 / 聊天频道 / 定时任务 / crew 编排）跑在 praxisd 之上：

```text
KiroCrew gateway (Python)
  └─ 每会话 spawn: praxisd acp        ← 本文要实现的进程
       ├─ stdin/stdout: ACP v1（JSON-RPC 2.0, NDJSON）
       └─ stderr: 有界诊断日志
```

**不在范围**（后续演进，见 §7）：工具调用审批（routing）、MCP 挂载、模型协商、
会话恢复、共享 runtime 多路复用。

## 2. 传输与帧格式（必须逐字遵守）

- **stdio**，UTF-8，**一行一条 JSON-RPC 2.0 消息**（NDJSON，`\n` 结尾，无内嵌换行）；
- 请求/响应/通知共用同一管道（双向全双工）；
- `stderr` 仅诊断：KiroCrew 会截取并注入日志（每行前缀 `[praxisd]`），**不得输出协议内容到 stderr**；
- 进程以 **stdin EOF** 为关闭信号（收到即优雅退出，退出码 0）;
- 一条损坏的 JSON 行不得杀死进程（记 stderr 后跳过）。

## 3. 方法契约（v1 最小集）

未知方法一律返回 `-32601 method not found`（这是 KiroCrew 探测能力的机制，
**不要静默忽略未知请求**；未知*通知*（无 `id`）可安全忽略）。

### 3.1 `initialize`（请求）

客户端首帧。响应**必须**包含：

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": { "loadSession": false },
    "authMethods": []
  }
}
```

- `protocolVersion`：**整数 `1`**（字符串日期形会被直接拒绝；本值与
  `ACP_BACKEND_LAUNCH` 行的 `protocol_version=1` 绑定，改动需走 goldens 流程）；
- `authMethods: []`：keyless。将来若 praxisd 要鉴权，这里声明方法并在
  `agent_sdk/host_auth.py` 重写 Stage 5 声明；
- `agentCapabilities.loadSession: false`：v1 不做会话恢复（`session/load` 可直接 -32601）。

### 3.2 `notifications/initialized`（通知）

无响应。收到后进入会话建立阶段。

### 3.3 `session/new`（请求）

```json
{"jsonrpc":"2.0","id":2,"method":"session/new",
 "params":{"cwd":"/workspace/project", "mcpServers":[]}}
```

响应：

```json
{"jsonrpc":"2.0","id":2,"result":{
  "sessionId":"praxisd-1a2b3c4d",
  "modes":[{"id":"praxis","description":"…"}]}}
```

- `sessionId`：全局唯一（建议 `praxisd-` + 随机 hex）；KiroCrew 不回传它以外的会话状态；
- `params.mcpServers`：**当前为 no-channel 投影**（KiroCrew 明知 stub/daemon 不挂载，
  见 `providers/mirrors/registry.py` 的 `ACP_BACKEND_PRAXISD` 行）。真实挂载能力落地时
  必须同步更新该投影 + `ACP_BACKENDS_SESSION_MCP_ARRAY` 决策（§7.2）；
- `cwd` 是会话工作目录，v1 可忽略（无工具）。

### 3.4 `session/prompt`（请求 → 通知流 → 响应）

请求形（**注意：`prompt.content` 块可能是 dict 或裸字符串，两种都要解析**——这是
实测踩过的坑）：

```json
{"jsonrpc":"2.0","id":3,"method":"session/prompt",
 "params":{"sessionId":"praxisd-1a2b3c4d",
           "prompt":{"content":[{"type":"text","text":"你好"}]}}}
```

应答方式：先发 0..N 条 `session/update` **通知**（流式增量），最后回**响应**：

```json
{"jsonrpc":"2.0","method":"session/update","params":{
  "sessionId":"praxisd-1a2b3c4d",
  "update":{"sessionUpdate":"agent_message_chunk",
            "content":{"type":"text","text":"（一段增量文本）"}}}}

{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}
```

- `agent_message_chunk.content.type` 目前只消费 `"text"`；
- `stopReason`：正常 `"end_turn"`；被取消 `"cancelled"`；
- **响应必须在所有 update 通知之后发出**（KiroCrew 以响应作为回合关闭点）；
- 回合中途死亡（进程退出）→ KiroCrew 记 `ACP process exited` 并把错误渲染进 UI。

### 3.5 `session/cancel`（请求）

当前回合取消。响应 `{}`，且被取消的 `session/prompt` 请求应尽快以
`{"stopReason":"cancelled"}` 收尾。

### 3.6 完整交互样例（冒烟命令）

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp"}}' \
 '{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"s","prompt":{"content":[{"type":"text","text":"hi"}]}}}' \
 | praxisd acp
```

期望输出：initialize 结果行 → 0..N 条 session/update 行 → id=3 的 end_turn 结果行。
**这条命令就是 Rust 实现的单元验收**（stub 同样通过它）。

## 4. 启动契约（KiroCrew 侧已固定）

| 项 | 值 | 落点 |
|---|---|---|
| argv | `praxisd acp` | `ACP_BACKEND_LAUNCH`（`agent_sdk/backends.py`） |
| 覆盖变量 | `PRAXISD_BIN`（指向绝对路径时整个 argv0 被替换） | 同上 `bin_env_var` |
| 进程模型 | 每会话一进程（stdin EOF 即退出） | `acp/client.py` 非 runtime 臂 |
| 协议版本 | `1`（整数） | 同上 `protocol_version` |
| provider label | `"praxisd"` | `acp/types.py`（缺失会误判 kiro 会话导致 transcript 误删） |

**维护红线**：改 `ACP_BACKEND_LAUNCH` 行或 spawn 臂后必须
`PRAXISD_BIN=<stub路径> .venv/bin/python scripts/update_acp_launch_goldens.py`
并在**同一提交**带上重写的 `test/fixtures/acp_launch_goldens.json`（reviewer 靠 fixture
diff 看哪个 harness 动了）。

## 5. KiroCrew 侧运行接线（验收时的操作序列）

```bash
cd KiroCrew
# 1) 编译真实 daemon 后：
export PRAXISD_BIN=/path/to/praxisd        # 真二进制；stub 期为 scripts/dev/praxisd_acp_stub.py
# 2) dev 实例配置（两个都要：聊天 slot 是 member 会话，读 member_acp_backend）
KIROCREW_HOME="$PWD/.kirocrew-dev" .venv/bin/kirocrew config set agent.acp_backend praxisd
KIROCREW_HOME="$PWD/.kirocrew-dev" .venv/bin/kirocrew config set agent.member_acp_backend praxisd
# 3) 重启（网关在启动时快照配置，改配置必须重启）
bash dev-fullstack.sh
# 4) 浏览器打开日志里的 token URL → 聊天框发消息 → 应看到 praxisd 的流式回复
```

验收观察点：gateway 日志出现 `praxisd stderr: …`（真实 daemon 的诊断行），
聊天页面渲染回合输出，无 `kiro-cli` / `AcpError` 字样。

## 6. 门禁与测试（改 KiroCrew 侧时必跑）

```bash
.venv/bin/python -m pytest -q \
  test/test_acp_launch_goldens.py \
  test/test_agent_backend_editable.py \
  test/test_agent_sdk_host_auth.py \
  test/test_provider_mirrors.py \
  test/test_backend_cards.py \
  test/test_harness_parity.py
# 当前基线：242 passed（praxisd-acp-harness 分支，0a0b28a）
```

## 7. 真实 daemon 的演进路线（按 onboarding 阶段解锁）

实现顺序建议，每一步都是独立可验收的增量：

### 7.1 第一增量（本规格 §3 全集）＝ 脱离 stub

`praxisd acp` 用 Rust 实现上表方法。**仅此一步即完成"后端换成我们自己的"**——
产品壳即刻跑在 praxisd 上（对话可见、可取消）。建议 praxisd 侧单测直接复用
§3.6 的冒烟命令做 CI 断言。

### 7.2 工具调用与审批（解锁 routing，安全关键）

- 发 `session/update` 的 `tool_call` 帧展示工具执行；
- **每个工具调用前发 `session/request_permission` 请求**（KiroCrew 的 tool gate 会应答
  允许/拒绝）——这是把 `ACP_BACKEND_ROUTING[praxisd]` 从 `UNVERIFIED` 升级的前提
  （UNVERIFIED 永远判定 INDETERMINATE，进不了 `ENFORCED_ROUTINGS`）；
- 同步在 Stage 2 能力集补决策（`ACP_BACKENDS_META_IDENTITY` 等）并补帧语料测试。

### 7.3 MCP 与模型

- MCP：决定 native（daemon 自读 agent spec）/ mirror / 保持 no-channel，三选一后更新
  `providers/mirrors/registry.py` 投影与相关集合；
- 模型：`session/new` 结果里带 `models` 列表即被 `GET /api/models` 捕获
  （需加入 `ACP_BACKENDS_ADVERTISED_MODEL_SELECTION`）；不广告则保持 config 默认。

### 7.4 会话与生命周期

- `session/close`/`session/cancel` 的驱逐语义 → `ACP_BACKENDS_SESSION_EVICTION`；
- 会话恢复（`session/resume` / `sessionCapabilities.resume`）→ 对应两个 resume 集合；
- 若做单进程多会话（共享 runtime）→ `ACP_BACKENDS_ACP_RUNTIME` + 新增一个 praxisd
  的 harness 适配器模块（参照 `acp/harness/` 目录内既有形状），成本高，v1 不做。

## 8. PraxisCode 治理对接（实现开工前必读）

- `rust/**` 属 PraxisCode 生产实现域：按仓库 AGENTS.md，实现需以**规格修订 / 批次
  指派**进入（本文件可直接作为 ER/packet 的输入材料）；
- 契约锚点：ACP（Agent Client Protocol）v1 公开规范 + 本仓库 stub 的实测行为；
  与 PraxisCode ADR-0002（自有 framed IPC）不冲突——`acp` 子命令是**外露适配面**，
  内部仍走 UDS/named pipe 到 praxisd 核心；
- 命名：二进制名 `praxisd`、子命令 `acp`、覆盖变量 `PRAXISD_BIN` 均已注册进
  KiroCrew 词表，不要改名（改名 = launch 行 + goldens + label 三处联动）。

## 9. 已知坑（实测记录，实现时对照）

1. `session/prompt` 的 `params`/`content` 形态不保证 dict —— 解析要同时接受
   dict / list / 裸字符串（stub 的 `prompt_text` 是防御样例）；
2. 协议版本是**整数**，写日期字符串会被握手拒绝；
3. spawn 分派在 `acp/client.py` 是逐后端 `elif` 链——**新 self-served 后端不加臂会
   静默落入 kiro-cli 分支**（症状：明明配了 praxisd 却报 kiro-cli not found）；
4. 聊天 slot 会话是 `agent_kind=member`，后端取 `agent.member_acp_backend`，
   只配 `agent.acp_backend` 不生效；
5. gateway 对配置是**启动时快照**：`config set` 后必须重启 gateway；
6. 后台会话（标题生成等）要求 `ACP_BACKENDS_ACP_RUNTIME` 成员资格，praxisd 暂无 →
   日志里 `Failed to create background session` / `Auto-title failed` 是**预期噪音**，
   不影响回合。

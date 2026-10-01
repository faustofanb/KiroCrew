#!/usr/bin/env python3
"""praxisd ACP development stub — the minimum self-served ACP v1 agent.

Speaks ACP (Agent Client Protocol, JSON-RPC 2.0 over stdio, one message per
line) as KiroCrew's ``acp/client.py`` per-session spawn path expects it:

  initialize            -> protocolVersion 1, no auth methods, no capabilities
  notifications/init.   -> ignored
  session/new           -> fresh sessionId + one "praxis" mode
  session/prompt        -> a few agent_message_chunk updates, then end_turn
  session/cancel        -> acknowledged
  anything else         -> -32601

No tools, no MCP mounts, no persistence: this exists to prove the harness
onboarding seam end to end. The real praxisd binary (PraxisCode, rust/)
replaces it by answering the same wire with real turns; point PRAXISD_BIN at
it when it exists.

Run standalone for a smoke test:
    printf '%s\n' \
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
      '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
      '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp"}}' \
      '{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"s","prompt":{"content":[{"type":"text","text":"hi"}]}}}' \
      | python3 scripts/dev/praxisd_acp_stub.py
"""
from __future__ import annotations

import json
import sys
import uuid

TURN_CHUNKS_PREFIX = (
    "(praxisd stub) 收到指令。",
    "这是 PraxisCode 守护进程的 ACP 开发桩：只实现 initialize / session/new / "
    "session/prompt 的最小闭环，不挂载工具，不落任何状态。",
    "你刚才说：",
)


def send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def reply(rid, result) -> None:
    send({"jsonrpc": "2.0", "id": rid, "result": result})


def error(rid, code: int, message: str) -> None:
    send({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}})


def notify(method: str, params: dict) -> None:
    send({"jsonrpc": "2.0", "method": method, "params": params})


def _text_of(block) -> str:
    if isinstance(block, str):
        return block
    if isinstance(block, dict):
        return block.get("text", "") if block.get("type", "text") == "text" else ""
    return ""


def prompt_text(params: dict) -> str:
    """Accept any ACP prompt shape: {prompt:{content:[...]}} or a bare list."""
    prompt = params.get("prompt")
    if isinstance(prompt, str):
        return prompt
    content = prompt.get("content") if isinstance(prompt, dict) else prompt
    if not isinstance(content, list):
        return ""
    return "".join(_text_of(b) for b in content)


def handle(msg: dict) -> None:
    method = msg.get("method")
    rid = msg.get("id")
    raw_params = msg.get("params")
    params = raw_params if isinstance(raw_params, dict) else {}
    if method == "initialize":
        reply(
            rid,
            {
                "protocolVersion": 1,
                "agentCapabilities": {"loadSession": False},
                "authMethods": [],
            },
        )
    elif method == "notifications/initialized":
        pass
    elif method == "session/new":
        reply(
            rid,
            {
                "sessionId": "praxisd-" + uuid.uuid4().hex[:8],
                "modes": [
                    {"id": "praxis", "description": "local praxisd development stub"}
                ],
            },
        )
    elif method == "session/prompt":
        sid = params.get("sessionId", "")
        text = prompt_text(params)
        for chunk in (*TURN_CHUNKS_PREFIX, text[:160] or "(空)"):
            notify(
                "session/update",
                {
                    "sessionId": sid,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": chunk},
                    },
                },
            )
        reply(rid, {"stopReason": "end_turn"})
    elif method == "session/cancel":
        reply(rid, {})
    elif rid is None:
        # A notification we do not know: nothing to answer.
        pass
    else:
        error(rid, -32601, f"method not found: {method}")


def main() -> int:
    sys.stderr.write("[praxisd-stub] ready on stdio\n")
    sys.stderr.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as exc:  # noqa: BLE001 - malformed line must not kill the wire
            sys.stderr.write(f"[praxisd-stub] bad json line: {exc!r}\n")
            sys.stderr.flush()
            continue
        try:
            handle(msg)
        except Exception as exc:  # noqa: BLE001 - the wire must stay alive
            sys.stderr.write(f"[praxisd-stub] handler error on {msg.get('method')!r}: {exc!r}\n")
            sys.stderr.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

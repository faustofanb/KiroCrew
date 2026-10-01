"""DBX integration — database workbench with AI support, over the dbx CLI.

Three surfaces, one module:

1. MCP REGISTRATION — registers the local ``@dbx-app/mcp-server`` as a
   user-authored MCP server via the gateway's own /api/mcp/custom contract,
   so the CHAT AGENT (praxisd or any harness) can list connections, browse
   schema and run SQL from a conversation. DBX's own permission modes
   (read_only / safe_write / high_risk_write) ride in the args.
2. UI WORKBENCH — /dbx/* routes for the Insight page: connections, schema
   tree, query execution (with the SAME allow-writes gates dbx enforces),
   all through the local ``dbx`` CLI so credentials stay in dbx's encrypted
   store — this module never sees them.
3. AI SQL — natural-language → SQL through the active chat backend: build a
   prompt carrying the connection's schema context (``dbx context``) and
   open a chat slot with it pre-seeded via the launcher, so the model that
   answers is whatever harness the operator already runs.
"""
from __future__ import annotations

import json
import shutil
import subprocess

_DBX_TIMEOUT = 60


def _dbx(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["dbx", *args], capture_output=True, text=True, timeout=_DBX_TIMEOUT
    )


def _dbx_json(args: list[str]) -> list | dict:
    proc = _dbx([*args, "--json"])
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "dbx failed").strip()[:1200])
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"dbx returned non-JSON output: {exc}") from exc


def dbx_available() -> bool:
    return shutil.which("dbx") is not None


# ── 1) Workbench reads/exec ──────────────────────────────────────────────────

def connections() -> dict:
    if not dbx_available():
        raise PermissionError("dbx CLI not installed (brew install dbx / npm i -g @dbx-app/cli)")
    return {"connections": _dbx_json(["connections", "list"])}


def schema(connection: str, name: str | None = None) -> dict:
    args = ["schema", "list", connection]
    if name:
        args += ["--schema", name]
    return {"schema": _dbx_json(args)}


def describe(connection: str, table: str, name: str | None = None) -> dict:
    args = ["schema", "describe", connection, table]
    if name:
        args += ["--schema", name]
    return {"table": _dbx_json(args)}


def query(connection: str, sql: str, allow_writes: bool = False, limit: int = 200) -> dict:
    if not sql.strip():
        raise ValueError("sql is required")
    if not sql.strip().lower().startswith("select") and not allow_writes:
        raise PermissionError(
            "non-SELECT statement: set allowWrites explicitly — dbx enforces the same gate"
        )
    args = ["query", connection, sql, "--limit", str(limit)]
    if allow_writes:
        args.append("--allow-writes")
    return {"rows": _dbx_json(args)}


# ── 2) MCP registration (chat agent gets dbx tools) ─────────────────────────

MCP_SERVER_NAME = "dbx"


def register_mcp(permission_mode: str = "read_only") -> dict:
    """Register @dbx-app/mcp-server as a user MCP server via the gateway API.

    ``permission_mode`` maps to dbx's own modes: read_only (default),
    safe_write, high_risk_write. Credentials and connection management stay
    inside dbx; the MCP server is only a typed window onto them.
    """
    if permission_mode not in ("read_only", "safe_write", "high_risk_write"):
        raise ValueError("permission_mode must be read_only | safe_write | high_risk_write")
    npx = shutil.which("npx")
    if not npx:
        raise FileNotFoundError("npx not found on PATH")
    spec = {
        "command": npx,
        "args": ["@dbx-app/mcp-server", "--mode", permission_mode],
        "env": {},
    }
    import urllib.request

    # Call the gateway's own API from the handler (same process, HTTP for the
    # auth contract) — the handler passes the request through; here we only
    # BUILD the spec, so the HTTP hop lives in routes.py.
    return {"name": MCP_SERVER_NAME, "spec": spec, "permissionMode": permission_mode}


# ── 3) AI SQL: natural language → seeded chat ────────────────────────────────

def ai_prompt(connection: str, question: str, max_tables: int = 12) -> dict:
    """Build the chat-launch payload for a natural-language database question.

    Uses ``dbx context`` (schema digest) + the question; the chat surface is
    whatever harness is active (praxisd today), so the MODEL is the one the
    operator already chose, and the SQL it writes can be run by dbx's MCP
    tools in the same conversation.
    """
    if not question.strip():
        raise ValueError("question is required")
    ctx = _dbx_json(["context", connection, "--max-tables", str(max_tables)])
    prompt = (
        "你是数据库助手。以下连接的库表上下文由 dbx 提供（JSON）：\n\n"
        f"{json.dumps(ctx, ensure_ascii=False)[:8000]}\n\n"
        f"用户问题：{question}\n\n"
        "请：1) 给出可执行的 SQL（只读查询默认不加写权限）；"
        "2) 简述它读了哪些表；3) 如果需要写操作，单独标注需要 --allow-writes。"
    )
    return {"connection": connection, "question": question, "prompt": prompt}

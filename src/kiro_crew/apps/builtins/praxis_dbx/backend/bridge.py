"""DBX connection bridge — read-only inventory over dbx-web's SQLite store.

dbx-web keeps everything (connections, history) in ``dbx.db`` under its data
dir. This module opens that file READ-ONLY (``mode=ro`` URI) and projects the
connection inventory: id/name/type/host/port/database plus a "jump" reference
into the embedded UI. Credentials are never read — the secret columns are
skipped by allowlist, not by denylist.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from .process import DBX_DATA_DIR

#: columns safe to display (allowlist — anything else, incl. secrets, is skipped)
_SAFE_COLUMNS = {
    "id",
    "name",
    "type",
    "db_type",
    "host",
    "port",
    "database",
    "dbname",
    "username",
    "user",
    "created_at",
    "updated_at",
    "description",
    "remark",
    "ssl",
    "color",
    "group_name",
    "ssh_enabled",
}


def _db_path() -> Path:
    return DBX_DATA_DIR / "dbx.db"


def _candidate_tables(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    names = [r[0] for r in rows]
    for t in ("connections", "connection", "db_connections"):
        if t in names:
            return [t]
    return [n for n in names if "connection" in n.lower()]


def connections() -> dict:
    """Connection inventory (read-only). Empty list until dbx-web has run once."""
    db = _db_path()
    if not db.exists():
        return {
            "available": False,
            "dataDir": str(DBX_DATA_DIR),
            "connections": [],
            "note": "dbx-web has not created its store yet — start it and add a connection in the UI",
        }
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=3)
    except sqlite3.Error as exc:
        return {"available": False, "error": str(exc), "connections": []}
    out: list[dict] = []
    try:
        for table in _candidate_tables(conn):
            cols = [r[1] for r in conn.execute(f'PRAGMA table_info("{table}")').fetchall()]
            safe = [c for c in cols if c.lower() in _SAFE_COLUMNS]
            if not safe:
                continue
            q = ", ".join(f'"{c}"' for c in safe)
            for row in conn.execute(f'SELECT {q} FROM "{table}"'):
                item = dict(zip(safe, row))
                item["_table"] = table
                item["openInUi"] = f"/dbx-app/?connection={item.get('name') or item.get('id')}"
                out.append(item)
            break  # first matching table wins — the others are shadows
    except sqlite3.Error as exc:
        return {"available": True, "error": str(exc), "connections": []}
    finally:
        conn.close()
    return {"available": True, "dataDir": str(DBX_DATA_DIR), "connections": out}


def ai_prompt(connection: str, question: str) -> dict:
    """Natural-language question → SQL prompt seeded with the schema digest.

    The digest comes from the dbx CLI (``dbx context``) when it is installed;
    otherwise the prompt carries the read-only connection inventory, which is
    still enough for the agent to ask the operator for specifics.
    """
    if not question.strip():
        raise ValueError("question is required")
    inventory = connections()
    names = [c.get("name") or c.get("id") for c in inventory.get("connections", [])]
    ctx_json = json.dumps(inventory.get("connections", []), ensure_ascii=False, default=str)[:6000]

    digest = ""
    if connection.strip():
        import shutil
        import subprocess

        if shutil.which("dbx"):
            proc = subprocess.run(
                ["dbx", "context", connection.strip(), "--max-tables", "12", "--json"],
                capture_output=True,
                text=True,
                timeout=30,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                digest = proc.stdout[:8000]

    parts = [
        "你是数据库助手（DBX 集成）。",
        "当前 dbx-web 连接清单（只读投影，凭据不可见）：",
        f"连接：{', '.join(str(n) for n in names) or '（暂无）'}",
        f"清单 JSON：{ctx_json}",
    ]
    if digest:
        parts.append(f"目标连接 {connection} 的库表上下文（dbx context）：\n{digest}")
    parts.append(
        f"用户问题：{question}\n\n"
        "请：1) 给出可执行 SQL（默认只读）；2) 列出读取的表；"
        "3) 需要写操作时单独标注。可建议在 DBX 页面的查询界面执行。"
    )
    return {"connection": connection, "question": question, "prompt": "\n".join(parts)}

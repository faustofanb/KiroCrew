"""Embedded tool pages — iframe any local web UI as a KiroCrew page.

The infrastructure: a registry of tool descriptors (name, url, category,
launch command) persisted in the Praxis Insight store. The UI renders each
registered tool as a full-page iframe with a toolbar (reload / open in
browser / status). Tools with a ``launch_command`` (like DBX Web via Docker)
can be started from the page; tools already serving (any localhost URL) are
embedded directly.

This is the PAGE-integration layer — the actual tool UIs render inside the
iframe at their native fidelity, not re-implemented. The MCP layer (already
landed) is the AI-integration complement.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from kiro_crew.config.paths import config_dir

_TIMEOUT = 5


def _store() -> Path:
    d = config_dir() / "praxis-insight"
    d.mkdir(parents=True, exist_ok=True)
    return d / "embedded_tools.json"


@dataclass
class Tool:
    id: str
    name: str
    url: str
    category: str = "dev"
    description: str = ""
    launch_command: str = ""  # shell command to start the service; empty = already running

    def to_json(self) -> dict:
        return self.__dict__.copy()


def _load() -> dict:
    p = _store()
    if not p.exists():
        return {"tools": _defaults()}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {"tools": _defaults()}


def _save(data: dict) -> None:
    _store().write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def _defaults() -> list[dict]:
    return [
        Tool(
            id="dbx-web",
            name="DBX Web",
            url="http://localhost:4224",
            category="database",
            description="100+ 数据库客户端完整 Web UI（查询编辑器、数据网格、ER 图、Schema Diff）",
            launch_command="docker run -d --name dbx-web -p 4224:4224 -v dbx-data:/app/data t8y2/dbx:latest",
        ).to_json(),
    ]


def list_tools() -> dict:
    return _load()


def add_tool(name: str, url: str, category: str = "dev", description: str = "", launch_command: str = "") -> dict:
    if not name.strip() or not url.strip():
        raise ValueError("name and url are required")
    tool = Tool(
        id=Path(url).stem or name.lower().replace(" ", "-"),
        name=name.strip(),
        url=url.strip(),
        category=category,
        description=description,
        launch_command=launch_command,
    )
    data = _load()
    data["tools"].append(tool.to_json())
    _save(data)
    return {"tool": tool.to_json()}


def remove_tool(tool_id: str) -> dict:
    data = _load()
    before = len(data["tools"])
    data["tools"] = [t for t in data["tools"] if t["id"] != tool_id]
    if len(data["tools"]) == before:
        raise KeyError(tool_id)
    _save(data)
    return {"removed": tool_id}


def check_url(url: str) -> dict:
    """Probe whether a tool's web UI is reachable."""
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            return {"url": url, "reachable": True, "status": resp.status}
    except Exception as exc:
        # Some servers reject HEAD; try GET before declaring unreachable.
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
                return {"url": url, "reachable": True, "status": resp.status}
        except Exception:
            return {"url": url, "reachable": False, "error": str(exc)[:200]}


def launch_tool(tool_id: str) -> dict:
    """Run a tool's launch_command (e.g., start DBX Web via Docker)."""
    data = _load()
    tool = next((t for t in data["tools"] if t["id"] == tool_id), None)
    if tool is None:
        raise KeyError(tool_id)
    if not tool.get("launch_command"):
        raise PermissionError(f"tool {tool_id} has no launch command")
    proc = subprocess.run(
        tool["launch_command"], shell=True, capture_output=True, text=True, timeout=120
    )
    return {"tool": tool_id, "ok": proc.returncode == 0, "output": (proc.stdout + proc.stderr)[:1000]}

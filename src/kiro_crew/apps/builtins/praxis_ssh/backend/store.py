"""SSH connection store — CRUD + connectivity probes, system ssh only.

Connections persist to ``~/.kiro/crew/praxis-ssh/connections.json``. The
store NEVER holds passwords: auth is key-only (``PreferredAuthentications
publickey``), the agent, or an explicit IdentityFile. Probes use
``StrictHostKeyChecking=accept-new`` and record the resulting host-key state
so the UI can surface "first seen / changed / known" explicitly instead of
letting it hide inside a generic error.
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

import subprocess

_HOST_RE = re.compile(r"^[A-Za-z0-9._:-]+$")


def _store_path() -> Path:
    from kiro_crew.config.paths import config_dir

    d = config_dir() / "praxis-ssh"
    d.mkdir(parents=True, exist_ok=True)
    return d / "connections.json"


def _load() -> list[dict]:
    p = _store_path()
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data.get("connections", []) if isinstance(data, dict) else []
    except Exception:
        return []


def _save(items: list[dict]) -> None:
    p = _store_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        json.dumps({"connections": items}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )


def _ssh_base_args(c: dict) -> list[str]:
    args = [
        "ssh",
        "-o",
        "BatchMode=yes",  # never prompt — key auth or fail fast
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "PreferredAuthentications=publickey",
        "-o",
        "PasswordAuthentication=no",
        "-o",
        "NumberOfPasswordPrompts=0",
        "-p",
        str(int(c.get("port") or 22)),
    ]
    identity = c.get("identityFile") or ""
    if identity:
        args += ["-i", os.path.expanduser(identity)]
    return args


def _target(c: dict) -> str:
    user = c.get("user") or ""
    return f"{user}@{c['host']}" if user else c["host"]


def list_connections() -> dict:
    return {"connections": _load()}


def _validate(c: dict) -> None:
    host = str(c.get("host") or "").strip()
    if not host or not _HOST_RE.match(host):
        raise ValueError("host is required (hostname or IP)")
    port = c.get("port") or 22
    if not (1 <= int(port) <= 65535):
        raise ValueError("port out of range")
    if "password" in c or c.get("authType") == "password":
        raise ValueError("password auth is not supported — use keys (by design)")


def create_connection(body: dict) -> dict:
    if body.get("password") or body.get("authType") == "password":
        raise ValueError("password auth is not supported — use keys (by design)")
    c = {
        "id": f"c{int(time.time() * 1000):x}{os.urandom(2).hex()}",
        "name": str(body.get("name") or body.get("host") or "").strip()[:80],
        "host": str(body.get("host") or "").strip(),
        "port": int(body.get("port") or 22),
        "user": str(body.get("user") or "").strip()[:64],
        "identityFile": str(body.get("identityFile") or "").strip() or None,
        "labels": str(body.get("labels") or "").strip()[:120] or None,
        "createdAt": int(time.time()),
        "lastTest": None,
    }
    _validate(c)
    items = _load()
    items.append(c)
    _save(items)
    return {"connection": c}


def update_connection(conn_id: str, body: dict) -> dict:
    items = _load()
    for i, c in enumerate(items):
        if c["id"] == conn_id:
            for k in ("name", "host", "user", "identityFile", "labels"):
                if k in body:
                    c[k] = str(body.get(k) or "").strip()[:120] or None
            if "port" in body:
                c["port"] = int(body.get("port") or 22)
            _validate(c)
            c["lastTest"] = None
            items[i] = c
            _save(items)
            return {"connection": c}
    raise KeyError(conn_id)


def delete_connection(conn_id: str) -> dict:
    items = _load()
    kept = [c for c in items if c["id"] != conn_id]
    if len(kept) == len(items):
        raise KeyError(conn_id)
    _save(kept)
    return {"removed": conn_id}


def get_connection(conn_id: str) -> dict:
    for c in _load():
        if c["id"] == conn_id:
            return c
    raise KeyError(conn_id)


def test_connection(conn_id: str) -> dict:
    """Probe reachability + auth + host-key state; records latency.

    The probe runs ``ssh -o BatchMode … true`` with a hard timeout and maps
    the exit code / stderr to an honest state: ok, unreachable, auth-refused,
    hostkey-changed, timeout. The full stderr never leaves this function —
    only the mapped state and a trimmed, scrubbed hint.
    """
    c = get_connection(conn_id)
    start = time.time()
    try:
        proc = subprocess.run(
            _ssh_base_args(c) + [_target(c), "true"],
            capture_output=True,
            text=True,
            timeout=20,
        )
        latency_ms = int((time.time() - start) * 1000)
    except subprocess.TimeoutExpired:
        result = {"ok": False, "state": "timeout", "latencyMs": None}
        _record(c, result)
        return {"id": conn_id, **result}

    err = (proc.stderr or "").strip()
    state = "ok" if proc.returncode == 0 else _classify_error(proc.returncode, err)
    result = {
        "ok": proc.returncode == 0,
        "state": state,
        "latencyMs": latency_ms,
    }
    if state == "hostkey-changed":
        result["hint"] = (
            "host key differs from known_hosts — resolve manually (ssh-keygen -R) or review known_hosts"
        )
    elif state == "auth-refused":
        result["hint"] = (
            "publickey auth rejected — check the key is offered (ssh-add -l) and authorized on the host"
        )
    elif state == "unreachable":
        result["hint"] = err.splitlines()[0][:200] if err else "network unreachable"
    _record(c, result)
    return {"id": conn_id, **result}


def _classify_error(code: int, err: str) -> str:
    low = err.lower()
    if "host key verification failed" in low or "host key has changed" in low or "offending" in low:
        return "hostkey-changed"
    if "permission denied" in low:
        return "auth-refused"
    if code == 255 and (
        "connection refused" in low
        or "timed out" in low
        or "no route" in low
        or "unreachable" in low
    ):
        return "unreachable"
    return "error"


def _record(c: dict, result: dict) -> None:
    items = _load()
    for i, item in enumerate(items):
        if item["id"] == c["id"]:
            item["lastTest"] = {
                "at": int(time.time()),
                "ok": result["ok"],
                "state": result["state"],
                "latencyMs": result["latencyMs"],
            }
            items[i] = item
            break
    _save(items)

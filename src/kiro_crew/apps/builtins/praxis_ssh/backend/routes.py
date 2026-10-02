"""SSH plugin backend — connection management, remote exec, key inventory.

Uses the system ssh binary (typed governed adapter per ER-ENG baseline).
Connections stored in the app's data directory as JSON. Password auth is
NEVER stored — only key-based connections are saved. Remote commands are
bounded (timeout + output size).
"""
import json, os, shlex, subprocess
from pathlib import Path
from aiohttp import web

_BASE = "/api/apps/praxis-ssh"
_TIMEOUT = 30
_MAX_OUTPUT = 100_000

def _store():
    d = Path.home() / ".kiro" / "crew" / "praxis-ssh"
    d.mkdir(parents=True, exist_ok=True)
    return d / "connections.json"

def _load():
    p = _store()
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text())
    except Exception:
        return []

def _save(conns):
    _store().write_text(json.dumps(conns, indent=1))

def _ssh_base_args(conn):
    args = ["ssh"]
    if conn.get("port"):
        args += ["-p", str(conn["port"])]
    if conn.get("keyPath"):
        args += ["-i", os.path.expanduser(conn["keyPath"])]
    args += ["-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=accept-new"]
    return args

async def _list(request):
    return web.json_response({"connections": _load()})

async def _add(request):
    body = await request.json() if request.can_read_body else {}
    name = body.get("name", "").strip()
    host = body.get("host", "").strip()
    if not name or not host:
        return web.json_response({"error": "name and host required"}, status=400)
    conn = {
        "id": f"ssh-{abs(hash(name)) % 100000}",
        "name": name, "host": host,
        "port": body.get("port", 22),
        "user": body.get("user", ""),
        "keyPath": body.get("keyPath", ""),
        "createdAt": body.get("createdAt", ""),
    }
    conns = _load()
    conns = [c for c in conns if c["name"] != name]
    conns.append(conn)
    _save(conns)
    return web.json_response({"connection": conn})

async def _remove(request):
    cid = request.match_info["conn_id"]
    conns = [c for c in _load() if c["id"] != cid]
    _save(conns)
    return web.json_response({"removed": cid})

async def _test(request):
    body = await request.json() if request.can_read_body else {}
    conn = body
    if not conn.get("host"):
        return web.json_response({"error": "host required"}, status=400)
    target = f"{conn.get('user','')}@{conn['host']}" if conn.get("user") else conn["host"]
    cmd = _ssh_base_args(conn) + [target, "echo", "SSH_OK"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=_TIMEOUT)
        ok = proc.returncode == 0 and "SSH_OK" in proc.stdout
        return web.json_response({"ok": ok, "output": (proc.stdout + proc.stderr)[:500]})
    except subprocess.TimeoutExpired:
        return web.json_response({"ok": False, "error": "timeout"}, status=408)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)[:200]}, status=500)

async def _exec(request):
    body = await request.json() if request.can_read_body else {}
    conn_id = body.get("connectionId", "")
    cmd_str = body.get("command", "")
    if not conn_id or not cmd_str:
        return web.json_response({"error": "connectionId and command required"}, status=400)
    conn = next((c for c in _load() if c["id"] == conn_id), None)
    if not conn:
        return web.json_response({"error": f"no connection {conn_id}"}, status=404)
    target = f"{conn.get('user','')}@{conn['host']}" if conn.get("user") else conn["host"]
    cmd = _ssh_base_args(conn) + [target, cmd_str]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=_TIMEOUT)
        return web.json_response({
            "exitCode": proc.returncode,
            "stdout": proc.stdout[:_MAX_OUTPUT],
            "stderr": proc.stderr[:_MAX_OUTPUT],
        })
    except subprocess.TimeoutExpired:
        return web.json_response({"error": "command timeout"}, status=408)
    except Exception as e:
        return web.json_response({"error": str(e)[:200]}, status=500)

async def _keys(request):
    """List SSH keys in ~/.ssh (public keys only)."""
    ssh_dir = Path.home() / ".ssh"
    keys = []
    if ssh_dir.is_dir():
        for p in sorted(ssh_dir.iterdir()):
            if p.suffix == ".pub" and p.is_file():
                try:
                    content = p.read_text().strip()
                    parts = content.split()
                    key_type = parts[0] if parts else "?"
                    comment = parts[-1] if len(parts) > 2 else ""
                    keys.append({"path": str(p.with_suffix("")), "type": key_type, "comment": comment})
                except Exception:
                    pass
    return web.json_response({"keys": keys})

def register_routes(app):
    r = app.router
    r.add_get(f"{_BASE}/connections", _list)
    r.add_post(f"{_BASE}/connections", _add)
    r.add_post(f"{_BASE}/connections/{{conn_id}}/remove", _remove)
    r.add_post(f"{_BASE}/test", _test)
    r.add_post(f"{_BASE}/exec", _exec)
    r.add_get(f"{_BASE}/keys", _keys)

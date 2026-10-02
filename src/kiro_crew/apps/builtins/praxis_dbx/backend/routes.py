"""DBX plugin backend — manages the dbx-web process lifecycle."""
import os, signal, subprocess, time, urllib.request
from pathlib import Path
from aiohttp import web

_DBX_PORT = 4224
_DBX_URL = f"http://localhost:{_DBX_PORT}"
_DBX_BIN = Path("/tmp/dbx/target/release/dbx-web")
_DBX_DATA = Path.home() / ".local/share/dbx-web"
_process = None

def _is_running():
    if _process is not None and _process.poll() is None:
        return True
    try:
        with urllib.request.urlopen(_DBX_URL, timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False

async def _handle_status(request):
    return web.json_response({"running": _is_running(), "url": _DBX_URL, "port": _DBX_PORT})

async def _handle_start(request):
    global _process
    if _is_running():
        return web.json_response({"running": True, "url": _DBX_URL, "alreadyRunning": True})
    if not _DBX_BIN.exists():
        return web.json_response({"error": f"dbx-web not found at {_DBX_BIN}. Build: cd /tmp/dbx && cargo build -p dbx-web --release"}, status=503)
    _DBX_DATA.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "DBX_PORT": str(_DBX_PORT)}
    _process = subprocess.Popen([str(_DBX_BIN)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
    for _ in range(10):
        time.sleep(0.5)
        if _is_running():
            return web.json_response({"running": True, "url": _DBX_URL, "pid": _process.pid})
        if _process.poll() is not None:
            stderr = _process.stderr.read().decode()[:500] if _process.stderr else ""
            return web.json_response({"error": f"dbx-web exited: {stderr}"}, status=500)
    return web.json_response({"running": True, "url": _DBX_URL, "pid": _process.pid})

async def _handle_stop(request):
    global _process
    if _process is not None and _process.poll() is None:
        os.killpg(_process.pid, signal.SIGTERM)
        try:
            _process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(_process.pid, signal.SIGKILL)
    _process = None
    return web.json_response({"running": False})

def register_routes(app):
    r = app.router
    r.add_get("/api/apps/praxis-dbx/status", _handle_status)
    r.add_post("/api/apps/praxis-dbx/start", _handle_start)
    r.add_post("/api/apps/praxis-dbx/stop", _handle_stop)

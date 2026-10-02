"""dbx-web process lifecycle — start/stop/restart/health/status/logs.

The binary lives at ``~/Workplace/tools/bin/dbx-web`` (source build, no
Docker — see ~/Workplace/tools/DBX-WEB.md for the rebuild command). This
supervisor owns ONE detached process:

* bound to 127.0.0.1 only, port 4224 (``DBX_PORT``);
* data dir pinned to ``~/.local/share/dbx-web`` (SQLite ``dbx.db``);
* ``DBX_PUBLIC_BASE_PATH=/dbx-app`` so every link/cookie the UI generates
  already lives under the gateway's reverse-proxy prefix — the iframe never
  escapes the proxy;
* stdout+stderr append to a bounded log ring (trimmed on start);
* a pid file under the crew home distinguishes live/stale/crashed states;
* optional auto-restart: a lightweight watchdog thread re-launches a crashed
  process (max 3 launches per minute, then it stays down and says so).
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path

import urllib.request

DBX_BIN = Path.home() / "Workplace" / "tools" / "bin" / "dbx-web"
DBX_DATA_DIR = Path.home() / ".local" / "share" / "dbx-web"
DBX_PORT = 4224
DBX_BASE_URL = f"http://127.0.0.1:{DBX_PORT}"
PUBLIC_BASE_PATH = "/dbx-app"
LOG_CAP = 256 * 1024

_LOCK = threading.Lock()
_AUTO_RESTART = {"enabled": True}
_LAUNCHES: list[float] = []


def _crew_dir() -> Path:
    from kiro_crew.config.paths import config_dir

    d = config_dir() / "praxis-dbx"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _pid_file() -> Path:
    return _crew_dir() / "dbx-web.pid"


def _log_file() -> Path:
    return _crew_dir() / "dbx-web.log"


def _binary_present() -> bool:
    return DBX_BIN.is_file() and os.access(DBX_BIN, os.X_OK)


def version() -> str:
    """Best-effort version — the server reports it once it is up."""
    try:
        with urllib.request.urlopen(f"{DBX_BASE_URL}/api/auth/check", timeout=2) as resp:
            data = json.loads(resp.read().decode())
            return str(data.get("version") or data.get("data") or "")
    except Exception:
        return ""


def health(timeout: float = 2.0) -> dict:
    """Probe the server's own auth-status endpoint (works pre-login)."""
    try:
        with urllib.request.urlopen(
            f"{DBX_BASE_URL}{PUBLIC_BASE_PATH}/api/auth/check", timeout=timeout
        ) as resp:
            body = json.loads(resp.read().decode())
            return {"up": True, "http": resp.status, "auth": body}
    except urllib.error.HTTPError as exc:
        # any HTTP answer means the server is listening
        try:
            body = json.loads(exc.read().decode() or "{}")
        except Exception:
            body = {}
        return {"up": True, "http": exc.code, "auth": body}
    except Exception:
        return {"up": False}


def _read_pid() -> int | None:
    try:
        return int(_pid_file().read_text().strip())
    except Exception:
        return None


def _pid_alive(pid: int | None) -> bool:
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # alive, just not ours to signal — still a conflict
    # kill(pid,0) also succeeds for zombies (an unreaped child). A zombie is
    # dead for supervision purposes; asking ps keeps this portable.
    try:
        out = subprocess.run(
            ["ps", "-p", str(pid), "-o", "stat="],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return out.returncode == 0 and not out.stdout.strip().startswith("Z")
    except Exception:
        return True


def _port_taken() -> bool:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", DBX_PORT)) == 0


def status() -> dict:
    pid = _read_pid()
    h = health(timeout=1.0)
    proc_alive = _pid_alive(pid)
    state = "stopped"
    if h["up"]:
        state = "running" if (proc_alive or pid is None) else "foreign"
    elif proc_alive:
        state = "starting"
    return {
        "state": state,
        "pid": pid if proc_alive else None,
        "up": h["up"],
        "auth": h.get("auth") or {},
        "port": DBX_PORT,
        "baseUrl": DBX_BASE_URL,
        "publicPath": PUBLIC_BASE_PATH,
        "binary": str(DBX_BIN),
        "binaryPresent": _binary_present(),
        "dataDir": str(DBX_DATA_DIR),
        "autoRestart": _AUTO_RESTART["enabled"],
        "version": version() if h["up"] else "",
    }


def _trim_log() -> None:
    log = _log_file()
    try:
        if log.exists() and log.stat().st_size > LOG_CAP * 2:
            text = log.read_text(encoding="utf-8", errors="replace")
            log.write_text(text[-LOG_CAP:], encoding="utf-8")
    except OSError:
        pass


def logs(tail_bytes: int = 32 * 1024) -> dict:
    log = _log_file()
    if not log.exists():
        return {"logs": ""}
    try:
        with log.open("rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - min(tail_bytes, LOG_CAP)))
            return {"logs": f.read().decode("utf-8", errors="replace")}
    except OSError:
        return {"logs": ""}


def _spawn() -> int:
    DBX_DATA_DIR.mkdir(parents=True, exist_ok=True)
    _trim_log()
    env = {
        **os.environ,
        "DBX_HOST": "127.0.0.1",
        "DBX_PORT": str(DBX_PORT),
        "DBX_DATA_DIR": str(DBX_DATA_DIR),
        "DBX_PUBLIC_BASE_PATH": PUBLIC_BASE_PATH,
        "RUST_LOG": "dbx_web=info,tower_http=warn",
    }
    log_fd = os.open(_log_file(), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    try:
        proc = subprocess.Popen(
            [str(DBX_BIN)],
            stdout=log_fd,
            stderr=log_fd,
            stdin=subprocess.DEVNULL,
            env=env,
            start_new_session=True,  # detach: survives this process tree
        )
    finally:
        os.close(log_fd)
    _pid_file().write_text(str(proc.pid))
    _LAUNCHES.append(time.time())
    return proc.pid


def _cleanup_stale() -> None:
    pid = _read_pid()
    if pid is not None and not _pid_alive(pid):
        try:
            _pid_file().unlink()
        except OSError:
            pass


def start(auto_restart: bool | None = None) -> dict:
    with _LOCK:
        if not _binary_present():
            raise FileNotFoundError(
                f"dbx-web binary not found at {DBX_BIN} — rebuild with `cargo build -p dbx-web --release` (see ~/Workplace/tools/DBX-WEB.md)"
            )
        _cleanup_stale()
        h = health(timeout=1.0)
        if h["up"]:
            return {"started": False, "alreadyRunning": True, **status()}
        pid = _read_pid()
        if _pid_alive(pid):
            # starting or wedged: stop it first for a deterministic start
            stop()
        if _port_taken():
            # something ELSE owns 4224 and is not speaking dbx's auth endpoint
            raise RuntimeError(
                f"port {DBX_PORT} is occupied by a non-dbx process; free it or set DBX_PORT"
            )
        if auto_restart is not None:
            _AUTO_RESTART["enabled"] = auto_restart
        new_pid = _spawn()
        _ensure_watchdog()
        # wait briefly for the listener so the UI's first health poll passes
        for _ in range(40):
            if health(timeout=0.5)["up"]:
                break
            if not _pid_alive(new_pid):
                raise RuntimeError(f"dbx-web exited immediately; see {_log_file()}")
            time.sleep(0.25)
        return {"started": True, "pid": new_pid, **status()}


def stop() -> dict:
    with _LOCK:
        pid = _read_pid()
        stopped = False
        if _pid_alive(pid):
            assert pid is not None
            try:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            for _ in range(20):
                if not _pid_alive(pid):
                    stopped = True
                    break
                time.sleep(0.25)
            if _pid_alive(pid):
                try:
                    os.killpg(os.getpgid(pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                stopped = not _pid_alive(pid)
        else:
            stopped = True
        try:
            _pid_file().unlink()
        except OSError:
            pass
        return {"stopped": stopped}


def restart() -> dict:
    stop()
    return start()


def set_auto_restart(enabled: bool) -> dict:
    _AUTO_RESTART["enabled"] = bool(enabled)
    if enabled:
        _ensure_watchdog()
    return {"autoRestart": _AUTO_RESTART["enabled"]}


_WATCHDOG_STARTED = False


def _ensure_watchdog() -> None:
    global _WATCHDOG_STARTED
    if _WATCHDOG_STARTED:
        return
    _WATCHDOG_STARTED = True
    t = threading.Thread(target=_watchdog_loop, name="dbx-web-watchdog", daemon=True)
    t.start()


def _watchdog_loop() -> None:
    """Re-launch after a crash, rate-limited to 3 launches per minute."""
    while True:
        time.sleep(5)
        if not _AUTO_RESTART["enabled"]:
            continue
        if not _binary_present():
            continue
        pid = _read_pid()
        if pid is None or not _pid_alive(pid):
            if health(timeout=0.5)["up"]:
                continue  # foreign instance on the port — leave it alone
            now = time.time()
            while _LAUNCHES and now - _LAUNCHES[0] > 60:
                _LAUNCHES.pop(0)
            if len(_LAUNCHES) >= 3:
                continue  # crash-looping: stay down, status() reports stopped
            with _LOCK:
                if _binary_present() and not _port_taken():
                    _spawn()


def ensure_running() -> dict:
    """Idempotent attach-or-launch used by the page's first load."""
    with _LOCK:
        _cleanup_stale()
        if health(timeout=1.0)["up"]:
            return {"started": False, "alreadyRunning": True, **status()}
    return start()

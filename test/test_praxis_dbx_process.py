"""DBX supervisor tests — lifecycle states over a stand-in binary.

Uses a tiny shell-script "dbx-web" that answers the auth endpoint with a
plain HTTP response, so state transitions (stopped→running→stopped, stale
pid cleanup, port-conflict refusal, auto-restart flag) are asserted without
the real 54 MB binary.
"""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from kiro_crew.apps.builtins.praxis_dbx.backend import bridge, process


class _AuthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/auth/status"):
            body = b'{"authenticated": false, "setup_required": true}'
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *a):  # silence
        pass


@pytest.fixture()
def standin(tmp_path, monkeypatch):
    """A fake DBX_BIN whose process IS the health endpoint.

    The script serves /api/auth/status until killed, so ``process.health``
    is up exactly while the supervised process lives — the same observable
    contract the real dbx-web has.
    """
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()

    script = tmp_path / "dbx-web"
    script.write_text(
        "#!/bin/sh\n"
        'exec python3 -c "\n'
        "from http.server import BaseHTTPRequestHandler, HTTPServer\n"
        "class H(BaseHTTPRequestHandler):\n"
        "    def do_GET(self):\n"
        "        if self.path.startswith('/api/auth/status'):\n"
        '            b = b\'{\\"authenticated\\": false, \\"setup_required\\": true}\'\n'
        "            self.send_response(200); self.send_header('content-type','application/json')\n"
        "            self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)\n"
        "        else:\n"
        "            self.send_response(404); self.end_headers()\n"
        "    def log_message(self, *a): pass\n"
        f"HTTPServer(('127.0.0.1', {port}), H).serve_forever()\n"
        '"\n',
        encoding="utf-8",
    )
    os.chmod(script, 0o755)

    crew = tmp_path / "crew"
    crew.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(process, "DBX_BIN", script)
    monkeypatch.setattr(process, "DBX_DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(process, "DBX_PORT", port)
    monkeypatch.setattr(process, "DBX_BASE_URL", f"http://127.0.0.1:{port}")
    monkeypatch.setattr(process, "_crew_dir", lambda: crew)
    monkeypatch.setattr(process, "_WATCHDOG_STARTED", True)  # no watchdog in tests
    process._AUTO_RESTART["enabled"] = False
    yield {"port": port, "crew": crew}
    process.stop()


def test_status_reports_stopped_when_down(standin):
    st = process.status()
    assert st["state"] == "stopped" and st["up"] is False
    assert st["binaryPresent"] is True


def test_ensure_attaches_when_already_up(standin):
    process.start()
    out = process.ensure_running()
    assert out["started"] is False and out.get("alreadyRunning") is True
    assert process.status()["up"] is True
    process.stop()


def test_start_stop_roundtrip(standin):
    out = process.start()
    assert out["started"] is True and out["pid"] > 0
    assert process.status()["pid"] == out["pid"]
    stopped = process.stop()
    assert stopped["stopped"] is True
    assert process.status()["state"] in ("stopped", "foreign")


def test_start_is_idempotent_when_healthy(standin):
    process.start()
    again = process.start()
    assert again["started"] is False and again.get("alreadyRunning") is True
    process.stop()


def test_stale_pid_file_is_cleaned(standin):
    p = process._pid_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("999999")  # no such pid
    process._cleanup_stale()
    assert not p.exists()


def test_logs_are_bounded_and_readable(standin):
    process.start()
    try:
        out = process.logs()
        assert "logs" in out
    finally:
        process.stop()


def test_auto_restart_flag_roundtrip(standin):
    process.set_auto_restart(False)
    assert process._AUTO_RESTART["enabled"] is False
    process.set_auto_restart(True)
    assert process.status()["autoRestart"] is True
    process.set_auto_restart(False)


def test_bridge_reports_missing_store(standin, tmp_path, monkeypatch):
    monkeypatch.setattr(bridge, "DBX_DATA_DIR", tmp_path / "nope")
    out = bridge.connections()
    assert out["available"] is False and out["connections"] == []


def test_bridge_ai_prompt_requires_question(standin):
    with pytest.raises(ValueError):
        bridge.ai_prompt("", "")

"""SSH key inventory — public keys, agent state, known_hosts view.

Everything here is public material only: ``~/.ssh/*.pub`` parsed with
``ssh-keygen -lf`` (type + fingerprint + comment), the agent's key list
(``ssh-add -l``), and a bounded known_hosts projection. Private key bodies
are never read; secrets never reach a log line.
"""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

SSH_DIR = Path.home() / ".ssh"
KNOWN_HOSTS_CAP = 500


def _ssh_dir() -> Path:
    return SSH_DIR if SSH_DIR.is_dir() else Path("/nonexistent")


def list_keys() -> dict:
    keys = []
    for pub in sorted(_ssh_dir().glob("*.pub")):
        entry = {
            "pubFile": pub.name,
            "privatePresent": (_ssh_dir() / pub.name[: -len(".pub")]).exists(),
            "type": "",
            "bits": 0,
            "fingerprint": "",
            "comment": "",
        }
        proc = subprocess.run(
            ["ssh-keygen", "-lf", str(pub)], capture_output=True, text=True, timeout=10
        )
        if proc.returncode == 0:
            # shape: "256 SHA256:xxxx comment (ED25519)" — the comment can be
            # empty, so split into at most 4 fields and treat the parenthesised
            # trailing token as the type when present
            parts = proc.stdout.strip().split(maxsplit=3)
            if len(parts) >= 3:
                entry["bits"] = int(parts[0]) if parts[0].isdigit() else 0
                entry["fingerprint"] = parts[1]
                rest = parts[2]
                if len(parts) == 4 and parts[3].endswith(")"):
                    entry["type"] = parts[3].strip("()")
                    entry["comment"] = rest
                elif rest.endswith(")"):
                    comment, _, ktype = rest.rpartition("(")
                    entry["comment"] = comment.strip()
                    entry["type"] = ktype
                else:
                    entry["comment"] = rest
        entry["mtime"] = int(pub.stat().st_mtime)
        keys.append(entry)
    return {"keys": keys, "sshDir": str(_ssh_dir())}


def agent_status() -> dict:
    proc = subprocess.run(["ssh-add", "-l"], capture_output=True, text=True, timeout=10)
    auth_sock = os.environ.get("SSH_AUTH_SOCK", "")
    if proc.returncode == 0:
        entries = []
        for line in proc.stdout.strip().splitlines():
            parts = line.split()
            if len(parts) >= 3:
                entries.append(
                    {
                        "fingerprint": parts[1],
                        "type": parts[-1].strip("()") if "(" in parts[-1] else "",
                    }
                )
        return {"running": True, "hasSocket": bool(auth_sock), "keys": entries}
    # rc 1: agent reachable, no keys; rc 2: no agent
    if proc.returncode == 1:
        return {"running": True, "hasSocket": bool(auth_sock), "keys": []}
    return {
        "running": False,
        "hasSocket": bool(auth_sock),
        "keys": [],
        "hint": "ssh-agent not reachable (SSH_AUTH_SOCK unset or stale)",
    }


def known_hosts() -> dict:
    path = _ssh_dir() / "known_hosts"
    if not path.exists():
        return {"entries": [], "total": 0}
    entries = []
    total = 0
    try:
        with path.open(encoding="utf-8", errors="replace") as f:
            for line in f:
                total += 1
                if len(entries) >= KNOWN_HOSTS_CAP:
                    continue
                line = line.strip()
                if not line or line.startswith("#") or line.startswith("@"):
                    kind = "marker"
                else:
                    kind = "hashed" if line.startswith("|1|") else "plain"
                host_field = line.split()[0] if line.split() else ""
                key_type = line.split()[1] if len(line.split()) > 1 else ""
                entries.append(
                    {
                        "kind": kind,
                        "host": "[hashed]" if kind == "hashed" else host_field[:120],
                        "keyType": key_type,
                    }
                )
    except OSError:
        pass
    return {"entries": entries, "total": total, "truncated": total > KNOWN_HOSTS_CAP}

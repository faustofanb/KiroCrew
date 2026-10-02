"""SSH store tests — CRUD, key-only policy, and probe classification."""

from __future__ import annotations

from pathlib import Path

import pytest

from kiro_crew.apps.builtins.praxis_ssh.backend import keys, store


@pytest.fixture()
def isolated(tmp_path, monkeypatch):
    d = tmp_path / "ssh"
    monkeypatch.setattr(store, "_store_path", lambda: d / "connections.json")
    return d


def test_create_list_update_delete_roundtrip(isolated):
    out = store.create_connection({"name": "web", "host": "10.0.0.5", "user": "root", "port": 2222})
    cid = out["connection"]["id"]
    assert store.list_connections()["connections"][0]["host"] == "10.0.0.5"
    store.update_connection(cid, {"name": "web2", "port": 22})
    c = store.get_connection(cid)
    assert c["name"] == "web2" and c["port"] == 22
    store.delete_connection(cid)
    assert store.list_connections()["connections"] == []


def test_password_is_refused_by_design(isolated):
    with pytest.raises(ValueError, match="password"):
        store.create_connection({"host": "h", "password": "x"})
    with pytest.raises(ValueError, match="password"):
        store.create_connection({"host": "h", "authType": "password"})


def test_invalid_host_and_port_rejected(isolated):
    with pytest.raises(ValueError):
        store.create_connection({"host": ""})
    with pytest.raises(ValueError):
        store.create_connection({"host": "bad host space"})
    with pytest.raises(ValueError):
        store.create_connection({"host": "ok.io", "port": 99999})


def test_ssh_args_are_key_only_and_accept_new(isolated):
    store.create_connection({"host": "srv", "user": "u", "identityFile": "~/.ssh/id_ed25519"})
    c = store.get_connection(store.list_connections()["connections"][0]["id"])
    args = store._ssh_base_args(c)
    joined = " ".join(args)
    assert "BatchMode=yes" in joined
    assert "StrictHostKeyChecking=accept-new" in joined
    assert "PasswordAuthentication=no" in joined
    assert "-i" in args


def test_test_connection_classifies_unreachable(isolated):
    out = store.create_connection({"host": "127.0.0.1", "port": 1})
    res = store.test_connection(out["connection"]["id"])
    assert res["ok"] is False
    assert res["state"] in ("unreachable", "timeout", "error")
    # lastTest recorded
    c = store.get_connection(out["connection"]["id"])
    assert c["lastTest"]["ok"] is False


def test_keys_scan_parses_real_pub(tmp_path, monkeypatch):
    pub = tmp_path / "id_test.pub"
    import subprocess

    proc = subprocess.run(
        ["ssh-keygen", "-t", "ed25519", "-N", "", "-f", str(tmp_path / "id_test"), "-q"],
        capture_output=True,
    )
    if proc.returncode != 0:
        pytest.skip("ssh-keygen unavailable")
    monkeypatch.setattr(keys, "SSH_DIR", tmp_path)
    out = keys.list_keys()
    assert len(out["keys"]) == 1
    k = out["keys"][0]
    assert k["fingerprint"].startswith("SHA256:")
    assert k["type"] == "ED25519"
    assert k["privatePresent"] is True


def test_known_hosts_marks_hashed(tmp_path, monkeypatch):
    monkeypatch.setattr(keys, "SSH_DIR", tmp_path)
    (tmp_path / "known_hosts").write_text("hosta ssh-ed25519 AAAA\n|1|hash= ssh-ed25519 BBBB\n")
    out = keys.known_hosts()
    assert out["total"] == 2
    kinds = {e["kind"] for e in out["entries"]}
    assert "plain" in kinds and "hashed" in kinds

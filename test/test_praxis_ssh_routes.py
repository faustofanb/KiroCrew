"""SSH route-level tests — the owner-gated surface over aiohttp."""

from __future__ import annotations

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from dashboard_owner_helpers import as_owner

from kiro_crew.apps.builtins.praxis_ssh.backend import routes as ssh_routes
from kiro_crew.apps.builtins.praxis_ssh.backend import store


@pytest.fixture()
def make_client(tmp_path, monkeypatch):
    d = tmp_path / "ssh"
    monkeypatch.setattr(store, "_store_path", lambda: d / "connections.json")

    async def _enabled_true() -> bool:
        return True

    monkeypatch.setattr(ssh_routes, "_enabled", _enabled_true)

    def _make() -> TestClient:
        app = as_owner(web.Application())
        ssh_routes.register_routes(app)
        return TestClient(TestServer(app))

    return _make


BASE = "/api/apps/praxis-ssh"


@pytest.mark.asyncio
async def test_connection_crud_and_probe(make_client):
    async with make_client() as client:
        # create (password refused)
        r = await client.post(f"{BASE}/connections", json={"host": "h", "password": "x"})
        assert r.status == 400
        # create ok
        r = await client.post(
            f"{BASE}/connections", json={"name": "t", "host": "127.0.0.1", "port": 1, "user": "u"}
        )
        assert r.status == 200
        cid = (await r.json())["connection"]["id"]
        # list
        r = await client.get(f"{BASE}/connections")
        assert any(c["id"] == cid for c in (await r.json())["connections"])
        # probe against a dead port: classified, structured, not a stack trace
        r = await client.post(f"{BASE}/connections/{cid}/test")
        body = await r.json()
        assert r.status == 200 and body["ok"] is False
        assert body["state"] in ("unreachable", "timeout", "error")
        # update + delete
        r = await client.put(f"{BASE}/connections/{cid}", json={"name": "t2"})
        assert r.status == 200
        r = await client.delete(f"{BASE}/connections/{cid}")
        assert r.status == 200
        r = await client.get(f"{BASE}/connections")
        assert not (await r.json())["connections"]


@pytest.mark.asyncio
async def test_keys_and_known_hosts_surfaces(make_client):
    async with make_client() as client:
        for ep in ("keys", "agent", "known-hosts", "history"):
            r = await client.get(f"{BASE}/{ep}")
            assert r.status == 200, ep
            body = await r.json()
            assert isinstance(body, dict)


@pytest.mark.asyncio
async def test_exec_requires_connection(make_client):
    async with make_client() as client:
        r = await client.post(f"{BASE}/exec", json={"connectionId": "nope", "command": "ls"})
        assert r.status == 404
        r = await client.post(f"{BASE}/exec", json={"connectionId": "", "command": ""})
        assert r.status == 400


@pytest.mark.asyncio
async def test_sftp_unknown_connection(make_client):
    async with make_client() as client:
        r = await client.get(f"{BASE}/sftp/list", params={"connectionId": "nope", "path": "."})
        assert r.status == 404
        r = await client.get(f"{BASE}/sftp/download", params={"connectionId": "nope", "path": "/x"})
        assert r.status == 404

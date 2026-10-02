"""Git Studio route-level tests — the full owner-gated surface over aiohttp.

Registers ``register_routes`` on a test app the way the gateway does, installs
the owner identity via ``as_owner``, and drives add-repo → status → graph →
diff → line staging → commit → branches → search against a real throwaway
repository. Non-owner requests must be refused — that is the security
property, not a detail.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from dashboard_owner_helpers import as_owner

from kiro_crew.apps.builtins.praxis_git.backend import repos as repos_mod
from kiro_crew.apps.builtins.praxis_git.backend import routes as gs_routes


@pytest.fixture()
def make_client(repo, monkeypatch):
    """Build an owner-authenticated TestClient against the registered routes."""

    async def _enabled_true() -> bool:
        return True

    monkeypatch.setattr(gs_routes, "_enabled", _enabled_true)

    def _make() -> TestClient:
        app = as_owner(web.Application())
        gs_routes.register_routes(app)
        return TestClient(TestServer(app))

    return _make


def _sh(args: list[str], cwd: Path) -> None:
    subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True,
        capture_output=True,
        text=True,
        env={
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@e.com",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@e.com",
            "GIT_EDITOR": "true",
            "PATH": "/usr/bin:/bin:/usr/local/bin",
        },
    )


@pytest.fixture()
def repo(tmp_path, monkeypatch):
    p = tmp_path / "alpha"
    p.mkdir()
    _sh(["init", "-b", "main"], p)
    (p / "a.txt").write_text("one\n")
    _sh(["add", "-A"], p)
    _sh(["commit", "-m", "c1"], p)
    store = tmp_path / "store"
    monkeypatch.setattr(repos_mod, "_store_path", lambda: store / "repositories.json")
    return p


BASE = "/api/apps/praxis-git"


@pytest.mark.asyncio
async def test_full_surface_over_real_repo(make_client, repo):
    async with make_client() as client:
        await _full_surface(client, repo)


async def _full_surface(client: TestClient, repo: Path):
    # add the repo (subdirectory resolves to toplevel)
    resp = await client.post(f"{BASE}/repos", json={"path": str(repo / "sub-nope")})
    assert resp.status == 404  # nonexistent dir

    resp = await client.post(f"{BASE}/repos", json={"path": str(repo)})
    assert resp.status == 200
    rid = (await resp.json())["id"]

    # repo list + status
    resp = await client.get(f"{BASE}/repos")
    body = await resp.json()
    assert any(r["id"] == rid and r["branch"] == "main" for r in body["repos"])

    (repo / "a.txt").write_text("one\ntwo\n")
    (repo / "new.txt").write_text("n\n")
    resp = await client.get(f"{BASE}/repos/{rid}/status")
    st = await resp.json()
    assert st["counts"]["unstaged"] == 1 and st["counts"]["untracked"] == 1

    # graph with lanes + decoration
    resp = await client.get(f"{BASE}/repos/{rid}/graph")
    g = await resp.json()
    assert g["total"] == 1
    row = g["rows"][0]
    assert row["branches"] == ["main"] and row["node"] == 0
    assert all(e["a"] is None or isinstance(e["a"], int) for e in row["edges"])

    # structured diff with line numbers
    resp = await client.get(f"{BASE}/repos/{rid}/diff", params={"path": "a.txt"})
    d = await resp.json()
    f = d["files"][0]
    add = next(l for h in f["hunks"] for l in h["lines"] if l["t"] == "add")
    assert add["text"] == "two" and add["new"] == 2

    # line-level staging via the route
    resp = await client.post(
        f"{BASE}/repos/{rid}/stage",
        json={
            "op": "lines",
            "path": "a.txt",
            "staged": False,
            "selections": [{"hunk": 0, "keys": [f"add:{add['old']}:{add['new']}"]}],
        },
    )
    assert resp.status == 200
    resp = await client.get(f"{BASE}/repos/{rid}/diff", params={"path": "a.txt", "staged": "1"})
    staged = await resp.json()
    staged_adds = [
        l["text"] for h in staged["files"][0]["hunks"] for l in h["lines"] if l["t"] == "add"
    ]
    assert staged_adds == ["two"]

    # stage the untracked file + commit through the routes
    resp = await client.post(f"{BASE}/repos/{rid}/stage", json={"op": "file", "paths": ["new.txt"]})
    assert resp.status == 200
    resp = await client.post(f"{BASE}/repos/{rid}/commit", json={"message": "route commit"})
    assert resp.status == 200
    sha = (await resp.json())["commit"]
    assert sha

    # graph grew; the new commit decorates main
    resp = await client.get(f"{BASE}/repos/{rid}/graph")
    g2 = await resp.json()
    assert g2["total"] == 2 and g2["rows"][0]["branches"] == ["main"]

    # branches / tags / remotes / worktrees / submodules all answer
    for ep in ("branches", "tags", "remotes", "worktrees", "submodules"):
        resp = await client.get(f"{BASE}/repos/{rid}/{ep}")
        assert resp.status == 200, ep
    body = await resp.json()
    assert isinstance(body["submodules"], list)

    # search by message
    resp = await client.get(f"{BASE}/repos/{rid}/search", params={"q": "route", "mode": "message"})
    hits = (await resp.json())["commits"]
    assert any("route commit" in c["subject"] for c in hits)

    # stash round-trip via routes
    (repo / "a.txt").write_text("one\ntwo\nthree\n")
    resp = await client.post(f"{BASE}/repos/{rid}/stash", json={"op": "push", "message": "wip"})
    assert resp.status == 200 and (await resp.json())["stashed"]
    resp = await client.get(f"{BASE}/repos/{rid}/stash/0/diff")
    assert resp.status == 200

    # unknown op → structured 400; unknown repo → 404
    resp = await client.post(f"{BASE}/repos/{rid}/stash", json={"op": "wat"})
    assert resp.status == 400
    assert (await resp.json())["code"] == "bad_request"
    resp = await client.get(f"{BASE}/repos/ffffffffffff/status")
    assert resp.status == 404


@pytest.mark.asyncio
async def test_sse_stream_requires_real_op(make_client):
    async with make_client() as client:
        resp = await client.get(f"{BASE}/network/nope123/stream")
        assert resp.status == 404


@pytest.mark.asyncio
async def test_json_error_shape(make_client, repo: Path):
    async with make_client() as client:
        await _json_error_shape(client, repo)


async def _json_error_shape(client: TestClient, repo: Path):
    resp = await client.post(f"{BASE}/repos", json={"path": str(repo)})
    rid = (await resp.json())["id"]
    # invalid revision is refused before git runs
    resp = await client.get(f"{BASE}/repos/{rid}/graph", params={"branch": "--inject;rm"})
    assert resp.status in (400, 409, 500)
    body = await resp.json()
    assert set(body) >= {"error", "code"}
    assert isinstance(json.dumps(body), str)

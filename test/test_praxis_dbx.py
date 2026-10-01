"""DBX integration tests — mocked at the subprocess boundary.

The real dbx CLI may be absent or hold no connections on a CI box, so every
test monkeypatches ``_dbx_json``/``_dbx`` and asserts the ORCHESTRATION: the
write gate, the prompt construction, the MCP spec shape.
"""
from __future__ import annotations

import pytest

from kiro_crew.apps.builtins.praxis_insight.backend import dbx


@pytest.fixture()
def fake(monkeypatch):
    calls: list[list[str]] = []

    def fake_json(args):
        calls.append(args)
        if args[:2] == ["connections", "list"]:
            return [{"name": "pg-main", "type": "postgres"}]
        if args[:2] == ["schema", "list"]:
            return [{"schema": "public", "tables": ["users", "orders"]}]
        if args[:2] == ["schema", "describe"]:
            return {"columns": [{"name": "id"}, {"name": "email"}]}
        if args[0] == "query":
            return [{"id": 1}]
        if args[0] == "context":
            return {"connection": "pg-main", "tables": [{"name": "users"}]}
        return {}

    monkeypatch.setattr(dbx, "_dbx_json", fake_json)
    return calls


def test_connections_pass_through(fake):
    out = dbx.connections()
    assert out["connections"][0]["name"] == "pg-main"


def test_non_select_requires_explicit_write_gate(fake):
    with pytest.raises(PermissionError, match="allowWrites"):
        dbx.query("pg-main", "DELETE FROM users")
    # With the gate the command carries dbx's own --allow-writes flag.
    dbx.query("pg-main", "DELETE FROM users", allow_writes=True)
    assert "--allow-writes" in fake[-1]


def test_select_passes_without_flag(fake):
    dbx.query("pg-main", "SELECT 1")
    assert "--allow-writes" not in fake[-1]


def test_ai_prompt_carries_schema_context_and_rules(fake):
    out = dbx.ai_prompt("pg-main", "最近 7 天下单最多的用户")
    assert "pg-main" in out["prompt"]
    assert "users" in out["prompt"]  # dbx context embedded
    assert "allow-writes" in out["prompt"]  # the write rule is stated to the model
    assert out["question"].startswith("最近")


def test_ai_prompt_requires_question(fake):
    with pytest.raises(ValueError):
        dbx.ai_prompt("pg-main", "  ")


def test_mcp_spec_shape():
    out = dbx.register_mcp("safe_write")
    assert out["name"] == "dbx"
    assert out["spec"]["args"] == ["@dbx-app/mcp-server", "--mode", "safe_write"]
    assert out["spec"]["command"].endswith("npx")


def test_mcp_rejects_unknown_mode():
    with pytest.raises(ValueError):
        dbx.register_mcp("yolo")

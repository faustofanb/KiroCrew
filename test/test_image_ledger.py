"""Per-session dedup and aggregate budget over prompt image blocks.

The per-image caps (``imaging.py``) bound one image; this layer bounds what a
session inlines in TOTAL, because kiro-cli replays every inlined image on every
later turn and the backend refuses the request body once the replay crosses its
ceiling. Four properties are pinned, in the order the work item states them:

(a) the same bytes offered twice in one session yield one image block, and the
    second offer's marker reads ``sent earlier``;
(b) the ledger survives a gateway restart -- it is on the session record and a
    fresh ``SessionMap`` read from disk still dedups;
(c) N images crossing the per-prompt budget yield blocks up to the cap and text
    markers after it, and the running total is recorded on the ledger;
(d) the existing per-image caps are untouched.

Plus the wiring: the ACP session handle and the direct client both apply the
layer after the builder, charge the ledger only once the prompt frame is
written, and let no host-side annotation reach the wire. The ledger names the
native conversation (``sid``) it describes, so a fresh conversation -- even one
whose sid promotion is deferred behind a history replay -- never reads the
previous one's ledger, and a confirmed native ``/clear`` empties it.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import random
from pathlib import Path

import pytest

from kiro_crew import image_ledger
from kiro_crew.acp.client import AcpClient, AcpProcessDied
from kiro_crew.acp.prompt_blocks import (
    MAX_IMAGE_B64_BYTES,
    MAX_IMAGE_EDGE_PX,
    build_prompt_blocks,
)
from kiro_crew.acp.runtime import AcpRuntime
from kiro_crew.acp.session_handle import AcpRuntimeDead, AcpSessionHandle
from kiro_crew.acp.types import (
    EVENT_COMPLETE,
    EVENT_IMAGE_BUDGET,
    METHOD_CLEAR_STATUS,
    METHOD_COMPACTION_STATUS,
    JsonRpcMessage,
)
from kiro_crew.agent_sdk.backends import ACP_BACKEND_KAS, ACP_BACKEND_KIRO
from kiro_crew.image_ledger import (
    COMPACTION_KEPT_PAIRS,
    COMPACTION_VERIFIED_KIRO_CLI_LAST_NIGHTLY,
    COMPACTION_VERIFIED_KIRO_CLI_RELEASES,
    COMPACTION_WALK_TARGET_BYTES,
    IMAGE_BLOCK_SOURCE_KEY,
    MAX_LEDGER_HASHES,
    MAX_PROMPT_IMAGE_B64_BYTES,
    MAX_PROMPT_IMAGE_BLOCKS,
    MAX_RECENT_PROMPTS,
    MAX_SESSION_IMAGE_B64_BYTES,
    SessionImageBudget,
    apply_image_budget,
    compact_ledger,
    compaction_refunds,
    empty_ledger,
    image_digest,
    kiro_cli_compaction_verified,
    normalize_ledger,
    stage_written,
    withheld_notice,
)
from kiro_crew.session_map import SessionMap

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs" / "system-specs" / "modules" / "acp-client.md"

MIB = 1024 * 1024
SID = "sid-1"
#: A kiro-cli release inside the verified range, and one past it.
VERIFIED_VERSION = "2.24.1"
NEWER_VERSION = "2.24.2"


def _data(seed: int, size: int = 120) -> str:
    """A deterministic base64 payload of exactly ``size`` characters, distinct per seed."""
    raw = bytes([seed % 256]) * (size * 3 // 4)
    out = base64.b64encode(raw).decode("ascii")
    assert len(out) == size, (len(out), size)
    return out


def _sent(name: str, path: str = "") -> str:
    """The literal the layer writes for a repeat (with or without a path)."""
    return (
        f"[image: {name}, sent earlier; file: {path}]" if path else f"[image: {name}, sent earlier]"
    )


def _over(name: str, path: str = "") -> str:
    """The literal the layer writes for a block over the budget."""
    tail = f"; file: {path}]" if path else "]"
    return f"[image: {name}, not inlined: over the image budget{tail}"


def _prompt(*specs: tuple, lead: str = "look: ", size: int = 120) -> list[dict]:
    """Blocks the builder would produce for ``lead`` + one marker per spec.

    Each spec is ``(seed, name, path)``; ``path`` may be ``""``. The text
    carries ``[image: <name>]`` per spec separated by spaces, and every image
    block is annotated with its marker's exact offsets, as the builder does.
    """
    text = lead
    images: list[dict] = []
    for seed, name, path in specs:
        marker = f"[image: {name}]"
        if text != lead:
            text += " "
        start = len(text)
        text += marker
        images.append(
            {
                "type": "image",
                "data": _data(seed, size),
                "mimeType": "image/png",
                IMAGE_BLOCK_SOURCE_KEY: {"path": path, "spans": [[start, len(text)]]},
            }
        )
    return [{"type": "text", "text": text}, *images]


def _bare_image(seed: int, size: int = 120) -> dict:
    """An image block with no annotation at all."""
    return {"type": "image", "data": _data(seed, size), "mimeType": "image/png"}


def _image_blocks(blocks: list[dict]) -> list[dict]:
    return [b for b in blocks if b.get("type") == "image"]


def _png_bytes(seed: int) -> bytes:
    pil = pytest.importorskip("PIL.Image")
    buf = io.BytesIO()
    pil.new("RGB", (4, 4), (seed % 256, 90, 30)).save(buf, format="PNG")
    return buf.getvalue()


def _png(tmp_path: Path, name: str, seed: int = 1) -> Path:
    tmp_path.mkdir(parents=True, exist_ok=True)
    p = tmp_path / name
    p.write_bytes(_png_bytes(seed))
    return p


def _budget(key: str, sid: str = SID) -> SessionImageBudget:
    return SessionImageBudget(lambda: key, lambda: sid)


@pytest.fixture(autouse=True)
def _no_registered_store():
    """Every test starts and ends with no durable store registered."""
    image_ledger.set_image_ledger_store(None)
    yield
    image_ledger.set_image_ledger_store(None)


@pytest.fixture
def caps(monkeypatch):
    """Set the module's caps small for one test (the constants are read at call time)."""

    def _set(
        *,
        prompt_images: int | None = None,
        prompt_b64: int | None = None,
        session_b64: int | None = None,
    ):
        if prompt_images is not None:
            monkeypatch.setattr(image_ledger, "MAX_PROMPT_IMAGE_BLOCKS", prompt_images)
        if prompt_b64 is not None:
            monkeypatch.setattr(image_ledger, "MAX_PROMPT_IMAGE_B64_BYTES", prompt_b64)
        if session_b64 is not None:
            monkeypatch.setattr(image_ledger, "MAX_SESSION_IMAGE_B64_BYTES", session_b64)

    return _set


class TestDedup:
    """(a) the same bytes twice in one session -> one block, then the marker."""

    def test_same_bytes_offered_twice_in_a_session_inline_once(self):
        first = apply_image_budget(_prompt((1, "a.png", "/tmp/a.png")), empty_ledger(SID))
        assert len(_image_blocks(first.blocks)) == 1
        assert first.inlined == 1 and first.sent_earlier == 0
        assert first.ledger["hashes"] == [image_digest(_data(1))]
        assert first.ledger["sid"] == SID

        second = apply_image_budget(_prompt((1, "a.png", "/tmp/a.png")), first.ledger)
        assert _image_blocks(second.blocks) == []
        assert second.sent_earlier == 1 and second.inlined == 0
        assert second.blocks[0]["text"] == "look: " + _sent("a.png", "/tmp/a.png")
        # Nothing new was sent: same digests, same bytes; the earlier prompt's
        # record is one position older, as after any written prompt.
        assert second.ledger["hashes"] == first.ledger["hashes"]
        assert second.ledger["b64_bytes"] == first.ledger["b64_bytes"]
        text = len(second.blocks[0]["text"].encode("utf-8"))
        assert first.ledger["recent"] == [{"b": len(_data(1)), "t": 0, "after": 0}]
        assert second.ledger["recent"] == [{"b": len(_data(1)), "t": 0, "after": 1}]
        assert second.ledger["pending_text"] == text, "charged to the record once answered"

    def test_the_key_is_content_not_name_or_path(self):
        ledger = apply_image_budget(_prompt((1, "a.png", "/one/a.png")), None).ledger
        again = apply_image_budget(_prompt((1, "copy.png", "/elsewhere/copy.png")), ledger)
        assert _image_blocks(again.blocks) == []
        assert again.blocks[0]["text"] == "look: " + _sent("copy.png", "/elsewhere/copy.png")

    def test_different_bytes_under_one_name_are_both_inlined(self):
        ledger = apply_image_budget(_prompt((1, "shot.png", "")), None).ledger
        again = apply_image_budget(_prompt((2, "shot.png", "")), ledger)
        assert len(_image_blocks(again.blocks)) == 1
        assert again.blocks[0]["text"] == "look: [image: shot.png]"
        assert len(again.ledger["hashes"]) == 2

    def test_the_same_bytes_twice_in_one_prompt_inline_once(self):
        result = apply_image_budget(
            _prompt((1, "a.png", "/t/a.png"), (1, "b.png", "/t/b.png")), None
        )
        assert len(_image_blocks(result.blocks)) == 1
        assert result.blocks[0]["text"] == "look: [image: a.png] " + _sent("b.png", "/t/b.png")
        assert result.sent_earlier == 1

    def test_dedup_wins_over_the_budget(self, caps):
        """A repeat costs nothing, so it is reported as a repeat even at a full budget."""
        ledger = apply_image_budget(_prompt((1, "a.png", "")), None).ledger
        caps(prompt_images=0)
        result = apply_image_budget(_prompt((1, "a.png", "/t/a.png")), ledger)
        assert result.sent_earlier == 1 and result.over_budget == 0

    def test_a_repeat_without_a_path_reads_sent_earlier_alone(self):
        ledger = apply_image_budget(_prompt((1, "a.png", "")), None).ledger
        again = apply_image_budget(_prompt((1, "a.png", "")), ledger)
        assert again.blocks[0]["text"] == "look: " + _sent("a.png")


class TestBudget:
    """(c) blocks up to the cap, markers after it, running total recorded."""

    def test_images_past_the_per_prompt_count_cap_become_markers(self, caps):
        blocks = _prompt(*[(i, f"{n}.png", f"/t/{n}.png") for i, n in enumerate("abc", start=1)])
        caps(prompt_images=2)
        result = apply_image_budget(blocks, None)
        kept = _image_blocks(result.blocks)
        assert [b["data"] for b in kept] == [_data(1), _data(2)]
        assert result.inlined == 2 and result.over_budget == 1
        assert result.blocks[0]["text"] == "look: [image: a.png] [image: b.png] " + _over(
            "c.png", "/t/c.png"
        )
        # The running total counts what was SENT, not what was offered.
        assert result.ledger["b64_bytes"] == len(_data(1)) + len(_data(2))
        assert result.ledger["hashes"] == [image_digest(_data(1)), image_digest(_data(2))]

    def test_the_per_prompt_byte_cap_is_inclusive(self, caps):
        two = _prompt((1, "a.png", ""), (2, "b.png", ""))
        caps(prompt_b64=2 * len(_data(1)))
        at_cap = apply_image_budget(two, None)
        assert at_cap.inlined == 2 and at_cap.over_budget == 0
        caps(prompt_b64=2 * len(_data(1)) - 1)
        one_short = apply_image_budget(two, None)
        assert one_short.inlined == 1 and one_short.over_budget == 1

    def test_the_session_total_runs_across_prompts(self, caps):
        size = len(_data(1))
        cap = 2 * size
        caps(session_b64=cap)
        first = apply_image_budget(_prompt((1, "a.png", "")), None)
        second = apply_image_budget(_prompt((2, "b.png", "")), first.ledger)
        assert second.inlined == 1 and second.ledger["b64_bytes"] == cap
        third = apply_image_budget(_prompt((3, "c.png", "/t/c.png")), second.ledger)
        assert third.inlined == 0 and third.over_budget == 1
        assert third.blocks[0]["text"] == "look: " + _over("c.png", "/t/c.png")
        # A refused block was never sent: it neither counts nor becomes a known digest.
        assert third.ledger["hashes"] == second.ledger["hashes"]
        assert third.ledger["b64_bytes"] == second.ledger["b64_bytes"] == cap

    def test_a_refused_image_may_be_inlined_by_a_later_prompt(self, caps):
        caps(prompt_images=1)
        first = apply_image_budget(_prompt((1, "a.png", ""), (2, "b.png", "/t/b.png")), None)
        assert first.over_budget == 1
        second = apply_image_budget(_prompt((2, "b.png", "")), first.ledger)
        assert second.inlined == 1 and second.over_budget == 0

    def test_an_over_budget_marker_without_a_path_still_names_the_file(self, caps):
        caps(prompt_images=0)
        result = apply_image_budget(_prompt((1, "a.png", "")), None)
        assert result.blocks[0]["text"] == "look: " + _over("a.png")

    def test_an_unannotated_degraded_block_leaves_the_text_as_it_is(self, caps):
        # The annotation is the contract and the one producer always writes it,
        # so there is no note fallback: a block without it is still deduped and
        # budgeted, and when dropped the text is untouched and no block is added.
        caps(prompt_images=0)
        over = apply_image_budget([{"type": "text", "text": "see"}, _bare_image(1)], None)
        assert over.blocks == [{"type": "text", "text": "see"}]
        assert over.over_budget == 1
        assert apply_image_budget([_bare_image(1)], None).blocks == []
        caps(prompt_images=MAX_PROMPT_IMAGE_BLOCKS)
        ledger = apply_image_budget([{"type": "text", "text": "see"}, _bare_image(1)], None).ledger
        repeat = apply_image_budget([{"type": "text", "text": "see"}, _bare_image(1)], ledger)
        assert repeat.blocks == [{"type": "text", "text": "see"}]
        assert repeat.sent_earlier == 1

    def test_default_caps_are_shares_of_the_measured_ceiling(self):
        """The constants state their arithmetic; measure it through the code, then
        check the owning spec quotes the same figures rather than its own."""
        assert MAX_SESSION_IMAGE_B64_BYTES == 24 * MIB
        assert MAX_SESSION_IMAGE_B64_BYTES == (32 * MIB) * 3 // 4
        assert MAX_PROMPT_IMAGE_B64_BYTES == MAX_SESSION_IMAGE_B64_BYTES // 2 == 12 * MIB
        assert MAX_PROMPT_IMAGE_BLOCKS == 20
        assert MAX_PROMPT_IMAGE_B64_BYTES < MAX_SESSION_IMAGE_B64_BYTES < 32 * MIB
        text = SPEC.read_text(encoding="utf-8")
        start = text.index("**Per-session dedup and aggregate budget**")
        paragraph = text[start : text.index("\n\n", start)]
        for figure in (
            f"{MAX_SESSION_IMAGE_B64_BYTES // MIB} MiB per session",
            f"{MAX_PROMPT_IMAGE_B64_BYTES // MIB} MiB per prompt",
            f"{MAX_PROMPT_IMAGE_BLOCKS} image blocks per prompt",
            "32 MiB",
        ):
            assert figure in paragraph, figure
        # The ratio the spec states is the one the code computes.
        assert "three quarters" in paragraph and "half of that" in paragraph

    def test_the_default_caps_apply(self):
        many = [{"type": "text", "text": "x"}] + [
            _bare_image(i, size=4) for i in range(MAX_PROMPT_IMAGE_BLOCKS + 3)
        ]
        result = apply_image_budget(many, None)
        assert result.inlined == MAX_PROMPT_IMAGE_BLOCKS and result.over_budget == 3


class TestWireShape:
    def test_host_side_annotations_never_reach_the_output(self):
        blocks = _prompt((1, "a.png", "/t/a.png"))
        blocks[1]["_other"] = "host only"
        result = apply_image_budget(blocks, None)
        (kept,) = _image_blocks(result.blocks)
        assert kept == {"type": "image", "data": _data(1), "mimeType": "image/png"}

    def test_inputs_are_not_mutated(self):
        blocks = _prompt((1, "a.png", ""), (1, "b.png", ""))
        snapshot = json.dumps(blocks, sort_keys=True)
        ledger = empty_ledger(SID)
        apply_image_budget(blocks, ledger)
        assert json.dumps(blocks, sort_keys=True) == snapshot
        assert ledger == empty_ledger(SID)

    def test_a_kept_block_is_byte_identical(self):
        """(d) the layer neither re-encodes nor resizes: the per-image caps in
        ``imaging.py`` stay the only thing that touches the payload."""
        blocks = _prompt((7, "a.png", ""))
        result = apply_image_budget(blocks, None)
        assert _image_blocks(result.blocks)[0]["data"] == blocks[1]["data"]
        assert MAX_IMAGE_EDGE_PX == 2000
        assert MAX_IMAGE_B64_BYTES == 5 * MIB

    def test_blocks_of_other_shapes_pass_through_untouched(self):
        odd = [{"type": "tool_result", "x": 1}, "not a dict", {"type": "image", "data": 3}]
        result = apply_image_budget(list(odd), None)
        assert result.blocks == odd
        assert result.inlined == 0 and result.ledger == empty_ledger()


class TestMarkerIdentity:
    """A dropped block rewrites the characters its producer substituted, nothing else."""

    def test_two_files_sharing_a_basename_get_distinct_markers(self, tmp_path):
        a = _png(tmp_path / "a", "shot.png", seed=1)
        b = _png(tmp_path / "b", "shot.png", seed=2)
        blocks = build_prompt_blocks(f"first {a} then {b}")
        text = blocks[0]["text"]
        assert text == "first [image: shot.png] then [image: shot.png (2)]"
        ((s1, e1),) = blocks[1][IMAGE_BLOCK_SOURCE_KEY]["spans"]
        ((s2, e2),) = blocks[2][IMAGE_BLOCK_SOURCE_KEY]["spans"]
        assert text[s1:e1] == "[image: shot.png]" and text[s2:e2] == "[image: shot.png (2)]"

    def test_the_dropped_block_rewrites_its_own_marker_not_a_neighbours(
        self, tmp_path, monkeypatch
    ):
        a = _png(tmp_path / "a", "shot.png", seed=1)
        b = _png(tmp_path / "b", "shot.png", seed=2)
        monkeypatch.setattr(image_ledger, "MAX_PROMPT_IMAGE_BLOCKS", 1)
        over = apply_image_budget(build_prompt_blocks(f"first {a} then {b}"), None)
        assert [x["data"] for x in _image_blocks(over.blocks)] == [
            base64.b64encode(_png_bytes(1)).decode("ascii")
        ]
        assert over.blocks[0]["text"] == "first [image: shot.png] then " + _over(
            "shot.png (2)", str(b)
        )
        # The same payload under two names: the SECOND block is the repeat.
        c = _png(tmp_path / "c", "shot.png", seed=1)
        dup = apply_image_budget(build_prompt_blocks(f"first {a} then {c}"), None)
        assert dup.blocks[0]["text"] == "first [image: shot.png] then " + _sent(
            "shot.png (2)", str(c)
        )

    def test_every_place_the_dropped_file_was_named_is_rewritten(self, tmp_path):
        p = _png(tmp_path, "shot.png")
        ledger = apply_image_budget(build_prompt_blocks(f"see {p}"), None).ledger
        blocks = build_prompt_blocks(f"{p} and once more {p}")
        assert len(blocks[1][IMAGE_BLOCK_SOURCE_KEY]["spans"]) == 2
        again = apply_image_budget(blocks, ledger)
        marker = _sent("shot.png", str(p))
        assert again.blocks[0]["text"] == f"{marker} and once more {marker}"

    def test_a_bracketed_string_the_user_typed_is_never_rewritten(self, tmp_path, monkeypatch):
        """The user quotes ``[image: shot.png]`` literally while attaching that very
        file over budget: only the builder's substitution is rewritten, the quoted
        text is left as the user wrote it."""
        p = _png(tmp_path, "shot.png")
        blocks = build_prompt_blocks(f"you said [image: shot.png] earlier; here it is: {p}")
        monkeypatch.setattr(image_ledger, "MAX_PROMPT_IMAGE_BLOCKS", 0)
        over = apply_image_budget(blocks, None)
        assert over.blocks[0]["text"] == (
            "you said [image: shot.png] earlier; here it is: " + _over("shot.png", str(p))
        )
        # The repeat route lands on the same substitution and nothing else.
        monkeypatch.setattr(image_ledger, "MAX_PROMPT_IMAGE_BLOCKS", MAX_PROMPT_IMAGE_BLOCKS)
        ledger = apply_image_budget(build_prompt_blocks(f"see {p}"), None).ledger
        dup = apply_image_budget(build_prompt_blocks(f"[image: shot.png] again {p}"), ledger)
        assert dup.blocks[0]["text"] == "[image: shot.png] again " + _sent("shot.png", str(p))

    def test_only_the_grammars_own_matches_become_marker_sites(self, tmp_path):
        """The substitution follows the grammar's matches: the same characters glued
        to the tail of another token are not a candidate, so they stay as written
        even when the path stands alone elsewhere in the message."""
        p = _png(tmp_path, "shot.png")
        blocks = build_prompt_blocks(f"token{p} is not a path but {p} is")
        assert blocks[0]["text"] == f"token{p} is not a path but [image: shot.png] is"
        assert len(blocks[1][IMAGE_BLOCK_SOURCE_KEY]["spans"]) == 1


class TestLedgerNormalization:
    def test_malformed_records_read_as_empty(self):
        for raw in (None, "x", [], {"hashes": "abc", "b64_bytes": "9"}, {"b64_bytes": True}):
            assert normalize_ledger(raw) == empty_ledger(), raw

    def test_only_lowercase_hex_sha256_digests_are_retained(self):
        good = image_digest("a")
        raw = {
            "hashes": [good, "short", 12, "x" * 65, None, "g" * 64, good.upper(), "0" * 63 + "-"],
            "b64_bytes": -4,
        }
        assert normalize_ledger(raw) == {
            "sid": "",
            "hashes": [good],
            "b64_bytes": 0,
            "recent": [],
            "pending_text": 0,
            "uncertain_bytes": 0,
            "unconfirmed": None,
        }

    def test_the_sid_is_kept_when_it_is_a_string(self):
        assert normalize_ledger({"sid": "abc"})["sid"] == "abc"
        assert normalize_ledger({"sid": 7})["sid"] == ""

    def test_the_digest_list_is_bounded_oldest_first(self):
        digests = [image_digest(str(i)) for i in range(MAX_LEDGER_HASHES + 5)]
        kept = normalize_ledger({"hashes": digests, "b64_bytes": 1})["hashes"]
        assert kept == digests[5:]
        assert len(kept) == MAX_LEDGER_HASHES

    def test_an_oversized_record_is_read_within_the_bound_not_scanned(self, caplog):
        # The writer never stores more than MAX_LEDGER_HASHES digests, so a longer
        # record is foreign (hand-edited, corrupt, another version). It is read on
        # the event loop, so the read must cost the CONSTANT, not the record: only
        # the newest MAX_LEDGER_HASHES raw entries are examined -- a full iteration
        # over the raw list is the defect -- and the overflow is counted out loud.
        class _NeverIterated(list):
            def __iter__(self):
                raise AssertionError("normalize_ledger iterated the whole raw list")

        overflow = 10_000
        digests = [image_digest(str(i)) for i in range(overflow + MAX_LEDGER_HASHES)]
        raw = {"sid": SID, "hashes": _NeverIterated(digests), "b64_bytes": 3}
        with caplog.at_level(logging.WARNING, logger="kiro_crew.image_ledger"):
            ledger = normalize_ledger(raw)
        assert ledger == {
            "sid": SID,
            "hashes": digests[overflow:],
            "b64_bytes": 3,
            "recent": [],
            "pending_text": 0,
            "uncertain_bytes": 0,
            "unconfirmed": None,
        }
        messages = [r.getMessage() for r in caplog.records]
        assert len(messages) == 1, messages
        assert f"{overflow} entr" in messages[0] and str(MAX_LEDGER_HASHES) in messages[0]
        # Counts only, never a digest or a byte of an image.
        assert not any(d in messages[0] for d in (digests[0], digests[-1]))

    def test_a_record_within_the_bound_is_read_whole_and_reports_nothing(self, caplog):
        # Every record the writer can produce fits the window, so the malformed
        # filter still runs ahead of the cap over the WHOLE record: a bad entry
        # occupies no slot and pushes no real digest out. Nothing is logged.
        digests = [image_digest(str(i)) for i in range(MAX_LEDGER_HASHES - 1)]
        raw = {"sid": SID, "hashes": ["not-a-digest"] + digests, "b64_bytes": 0}
        with caplog.at_level(logging.WARNING, logger="kiro_crew.image_ledger"):
            assert normalize_ledger(raw)["hashes"] == digests
            assert normalize_ledger({"sid": SID, "hashes": [], "b64_bytes": 0})["hashes"] == []
        assert caplog.records == []

    def test_eviction_is_counted_and_only_the_newest_digests_are_kept(self):
        full = {
            "sid": SID,
            "hashes": [image_digest(str(i)) for i in range(MAX_LEDGER_HASHES)],
            "b64_bytes": 0,
        }
        result = apply_image_budget(_prompt((9, "n.png", ""), size=4), full)
        assert result.evicted == 1
        assert len(result.ledger["hashes"]) == MAX_LEDGER_HASHES
        assert result.ledger["hashes"][-1] == image_digest(_data(9, 4))
        assert result.ledger["hashes"][0] == image_digest("1")
        assert result.ledger["sid"] == SID


@pytest.fixture()
def patched_map(tmp_path, monkeypatch):
    kiro = tmp_path / "kiro"
    kiro.mkdir()
    monkeypatch.setattr("kiro_crew.session_map.config_dir", lambda: tmp_path)
    monkeypatch.setattr("kiro_crew.session_map._KIRO_SESSIONS_DIR", kiro)
    return tmp_path


def _ledger(*digests: str, sid: str = SID, b64_bytes: int = 10) -> dict:
    return {"sid": sid, "hashes": list(digests), "b64_bytes": b64_bytes}


class TestSessionRecord:
    """(b) the ledger is on the session record and survives a restart."""

    def test_a_key_with_no_entry_takes_no_ledger_and_gains_no_entry(self, patched_map):
        sm = SessionMap()
        assert sm.get_image_ledger("dashboard:1") is None
        assert sm.set_image_ledger("dashboard:1", _ledger(image_digest("a"))) is False
        assert sm.get_image_ledger("dashboard:1") is None
        assert not (patched_map / "session_map.json").exists(), "nothing was written"

    def test_the_ledger_survives_a_reload(self, patched_map):
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        assert sm.get_image_ledger("dashboard:1") == {}
        ledger = _ledger(image_digest("a"), image_digest("b"), b64_bytes=4321)
        assert sm.set_image_ledger("dashboard:1", ledger) is True
        # A fresh instance reads the file: that is what a gateway restart does.
        assert SessionMap().get_image_ledger("dashboard:1") == {
            **ledger,
            "recent": [],
            "pending_text": 0,
            "uncertain_bytes": 0,
            "unconfirmed": None,
        }
        assert SessionMap().mapped_sid("dashboard:1") == SID, "the sid is untouched"

    def test_a_new_native_conversation_starts_an_empty_ledger(self, patched_map):
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        sm.set_image_ledger("dashboard:1", _ledger(image_digest("a")))
        sm.set("dashboard:1", SID, cwd="/somewhere")
        assert sm.get_image_ledger("dashboard:1")["b64_bytes"] == 10, "same sid keeps it"
        sm.set("dashboard:1", "sid-2")
        assert sm.get_image_ledger("dashboard:1") == {}
        assert SessionMap().get_image_ledger("dashboard:1") == {}

    def test_a_cleared_sid_then_a_fresh_one_drops_the_ledger(self, patched_map):
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        sm.set_image_ledger("dashboard:1", _ledger(image_digest("a")))
        assert sm.clear_sid("dashboard:1") is True
        sm.set("dashboard:1", "sid-3")
        assert sm.get_image_ledger("dashboard:1") == {}

    def test_a_ledger_written_under_a_deferred_sid_survives_its_promotion(self, patched_map):
        """A fresh session behind a history replay writes its ledger under the NEW
        sid while the entry still records the old one; recording the new sid
        must keep that ledger, and the old conversation's ledger must not have
        been readable by the new one in the first place."""
        sm = SessionMap()
        sm.set("dashboard:1", "old-sid")
        sm.set_image_ledger("dashboard:1", _ledger(image_digest("old"), sid="old-sid"))
        image_ledger.set_image_ledger_store(sm)
        assert image_ledger.load_image_ledger("dashboard:1", "new-sid") == empty_ledger("new-sid")
        assert image_ledger.load_image_ledger("dashboard:1", "old-sid")["hashes"] == [
            image_digest("old")
        ]
        # The fresh conversation's first turn writes its own ledger...
        sm.set_image_ledger("dashboard:1", _ledger(image_digest("new"), sid="new-sid"))
        # ...and the promotion that follows the landed turn keeps it.
        sm.set("dashboard:1", "new-sid")
        assert sm.get_image_ledger("dashboard:1")["hashes"] == [image_digest("new")]
        sm.set("dashboard:1", "other-sid")
        assert sm.get_image_ledger("dashboard:1") == {}

    def test_an_empty_ledger_leaves_no_field_behind(self, patched_map):
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        sm.set_image_ledger("dashboard:1", _ledger(image_digest("a")))
        sm.set_image_ledger("dashboard:1", empty_ledger(SID))
        raw = json.loads((patched_map / "session_map.json").read_text(encoding="utf-8"))
        assert "image_ledger" not in raw["dashboard:1"]

    def test_the_record_is_normalized_at_the_point_of_retention(self, patched_map):
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        digests = [image_digest(str(i)) for i in range(MAX_LEDGER_HASHES + 2)]
        sm.set_image_ledger(
            "dashboard:1", {"sid": "s" * 1000, "hashes": digests + ["junk"], "b64_bytes": -1}
        )
        stored = SessionMap().get_image_ledger("dashboard:1")
        # 259 entries is a record the writer never produces, so it is read through
        # its newest MAX_LEDGER_HASHES entries only: the junk inside that window is
        # dropped and nothing older is pulled in to replace it.
        assert stored["hashes"] == digests[3:] and stored["b64_bytes"] == 0
        assert len(stored["hashes"]) == MAX_LEDGER_HASHES - 1
        assert stored["sid"] == "", "an over-long sid is refused, not truncated"

    @pytest.mark.asyncio
    async def test_the_layer_dedups_across_a_simulated_gateway_restart(self, patched_map):
        """The whole path: layer -> registered live map -> disk -> new process."""
        first_map = SessionMap()
        first_map.set("dashboard:7", SID)
        image_ledger.set_image_ledger_store(first_map)
        budget = _budget("dashboard:7")

        sent = await budget.apply(_prompt((1, "a.png", "/t/a.png")))
        assert len(_image_blocks(sent)) == 1
        budget.commit()  # the prompt was written...
        budget.confirm()  # ...and the runtime's first frame proved it accepted
        # The deferred flush lands (and its task retires) before the "restart".
        await first_map.aclose()

        # Restart: a new map read from disk, a new handle, a new applier.
        second_map = SessionMap()
        image_ledger.set_image_ledger_store(second_map)
        again = await _budget("dashboard:7").apply(_prompt((1, "a.png", "/t/a.png")))
        assert _image_blocks(again) == []
        assert again[0]["text"] == "look: " + _sent("a.png", "/t/a.png")
        await second_map.aclose()

    @pytest.mark.asyncio
    async def test_a_session_without_a_record_keeps_an_in_memory_ledger(self, patched_map):
        sm = SessionMap()
        image_ledger.set_image_ledger_store(sm)
        budget = _budget("subagent:x")
        assert len(_image_blocks(await budget.apply(_prompt((1, "a.png", ""))))) == 1
        budget.commit()
        budget.confirm()
        again = await budget.apply(_prompt((1, "a.png", "")))
        assert _image_blocks(again) == []
        assert sm.get_image_ledger("subagent:x") is None, "no entry was materialized"
        await sm.aclose()
        assert not (patched_map / "session_map.json").exists(), "nothing was written"

    @pytest.mark.asyncio
    async def test_an_in_memory_ledger_follows_its_owners_native_conversation(self):
        sid = {"value": "one"}
        budget = SessionImageBudget(lambda: "subagent:x", lambda: sid["value"])
        await budget.apply(_prompt((1, "a.png", "")))
        budget.commit()
        budget.confirm()
        assert _image_blocks(await budget.apply(_prompt((1, "a.png", "")))) == []
        sid["value"] = "two"  # the owner reset onto a fresh native conversation
        assert len(_image_blocks(await budget.apply(_prompt((1, "a.png", ""))))) == 1

    @pytest.mark.asyncio
    async def test_no_store_registered_still_dedups_in_memory(self):
        budget = _budget("dashboard:1")
        assert len(_image_blocks(await budget.apply(_prompt((1, "a.png", ""))))) == 1
        budget.commit()
        budget.confirm()
        assert _image_blocks(await budget.apply(_prompt((1, "a.png", "")))) == []

    @pytest.mark.asyncio
    async def test_text_only_prompts_are_returned_as_is(self):
        blocks = [{"type": "text", "text": "hi"}]
        assert await _budget("k").apply(blocks) is blocks


class TestStagedCommit:
    @pytest.mark.asyncio
    async def test_apply_stages_commit_charges_and_confirm_records(self, patched_map):
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        image_ledger.set_image_ledger_store(sm)
        budget = _budget("dashboard:1")
        await budget.apply(_prompt((1, "a.png", "")))
        assert sm.get_image_ledger("dashboard:1") == {}, "staged, not recorded"
        budget.commit()
        written = sm.get_image_ledger("dashboard:1")
        assert written["sid"] == SID
        assert written["b64_bytes"] == len(_data(1)), "charged at the write"
        assert written["hashes"] == [] and written["recent"] == [], "digests and advance wait"
        assert written["unconfirmed"] == {
            "hashes": [image_digest(_data(1))],
            "recent": _recent((len(_data(1)), 0, 0)),
            "pending_text": len("look: [image: a.png]"),
            "b": len(_data(1)),
        }
        budget.confirm()
        accepted = sm.get_image_ledger("dashboard:1")
        assert accepted["hashes"] == [image_digest(_data(1))]
        assert accepted["recent"] == _recent((len(_data(1)), 0, 0))
        assert accepted["unconfirmed"] is None and accepted["uncertain_bytes"] == 0
        budget.confirm()  # idempotent
        budget.commit()  # nothing staged: a no-op
        assert sm.get_image_ledger("dashboard:1") == accepted
        await sm.aclose()

    @pytest.mark.asyncio
    async def test_an_unconfirmed_prompt_is_invalidated_by_the_next_one(self, patched_map):
        """The runtime never spoke for the written prompt: the next prompt reads
        its bytes as uncertain (charged for good), its digests as unknown (the
        retry inlines the picture again) and its advance as never made."""
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        image_ledger.set_image_ledger_store(sm)
        budget = _budget("dashboard:1")
        await budget.apply(_prompt((1, "a.png", "")))
        budget.commit()  # written; the runtime died before any frame
        retry = await _budget("dashboard:1").apply(_prompt((1, "a.png", "")))  # the re-queue
        assert len(_image_blocks(retry)) == 1, "no false sent-earlier for an undelivered image"
        ledger = sm.get_image_ledger("dashboard:1")
        assert ledger["uncertain_bytes"] == len(_data(1))
        assert ledger["b64_bytes"] == len(_data(1)) and ledger["unconfirmed"] is None
        assert ledger["hashes"] == [] and ledger["recent"] == []
        await sm.aclose()

    @pytest.mark.asyncio
    async def test_discard_drops_the_stage_for_durable_and_local_ledgers(self, patched_map):
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        image_ledger.set_image_ledger_store(sm)
        durable = _budget("dashboard:1")
        await durable.apply(_prompt((1, "a.png", "")))
        durable.discard()
        durable.commit()
        assert sm.get_image_ledger("dashboard:1") == {}
        local = _budget("subagent:x")
        await local.apply(_prompt((1, "a.png", "")))
        local.discard()
        assert len(_image_blocks(await local.apply(_prompt((1, "a.png", ""))))) == 1
        await sm.aclose()

    @pytest.mark.asyncio
    async def test_abandon_charges_the_write_as_uncertain(self, patched_map):
        """A write that raised may have left its bytes with the runtime."""
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        image_ledger.set_image_ledger_store(sm)
        budget = _budget("dashboard:1")
        await budget.apply(_prompt((1, "a.png", "")))
        budget.abandon()
        ledger = sm.get_image_ledger("dashboard:1")
        assert ledger["uncertain_bytes"] == len(_data(1)) == ledger["b64_bytes"]
        assert ledger["hashes"] == [] and ledger["recent"] == [] and ledger["unconfirmed"] is None
        assert len(_image_blocks(await budget.apply(_prompt((1, "a.png", ""))))) == 1
        local = _budget("subagent:x")
        await local.apply(_prompt((1, "a.png", "")))
        local.abandon()
        assert local._local["uncertain_bytes"] == len(_data(1))
        assert len(_image_blocks(await local.apply(_prompt((1, "a.png", ""))))) == 1
        await sm.aclose()

    @pytest.mark.asyncio
    async def test_a_new_apply_replaces_an_uncommitted_stage(self):
        budget = _budget("k")
        await budget.apply(_prompt((1, "a.png", "")))
        await budget.apply(_prompt((2, "b.png", "")))
        budget.commit()
        budget.confirm()
        assert budget._local["hashes"] == [image_digest(_data(2))]

    @pytest.mark.asyncio
    async def test_reset_clears_durable_local_and_staged_state(self, patched_map):
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        image_ledger.set_image_ledger_store(sm)
        budget = _budget("dashboard:1")
        await budget.apply(_prompt((1, "a.png", "")))
        budget.commit()
        await budget.apply(_prompt((2, "b.png", "")))
        budget.reset()
        budget.commit()
        assert sm.get_image_ledger("dashboard:1") == {}
        assert budget._local == empty_ledger(SID)
        await sm.aclose()


def _recent(*entries: tuple[int, int, int]) -> list[dict]:
    """Per-prompt records as ``(b64 image bytes, text bytes after, positions after)``, oldest first."""
    return [{"b": b, "t": t, "after": after} for b, t, after in entries]


def _text(text: str = "more") -> list[dict]:
    return [{"type": "text", "text": text}]


class TestCompaction:
    """A kiro-cli compaction refunds the ledger: digests forgotten, bytes kept only
    for the prompts its kept tail can still replay."""

    def test_a_conversation_at_its_budget_inlines_again_after_a_compaction(self, caps):
        size = len(_data(1))
        caps(session_b64=2 * size)
        ledger = apply_image_budget(_prompt((1, "a.png", "")), empty_ledger(SID)).ledger
        ledger = apply_image_budget(_prompt((2, "b.png", "")), ledger).ledger
        # Two long text turns later the two pictures are the oldest history.
        for _ in range(2):
            ledger = apply_image_budget(_text("x" * COMPACTION_WALK_TARGET_BYTES), ledger).ledger
        refused = apply_image_budget(_prompt((3, "c.png", "/t/c.png")), ledger)
        assert refused.over_budget == 1, "the budget is spent"
        refunded = compact_ledger(refused.ledger)
        assert refunded["hashes"] == [] and refunded["b64_bytes"] == 0
        assert refunded["sid"] == SID
        third = apply_image_budget(_prompt((3, "c.png", "/t/c.png")), refunded)
        assert third.inlined == 1 and third.over_budget == 0

    def test_a_picture_the_summary_swallowed_is_inlined_again_not_deduped(self):
        # For an agent without file tools this is the whole picture: after a
        # compaction the model holds only the summary, so a repeat is sent, not marked.
        ledger = apply_image_budget(_prompt((1, "a.png", "/t/a.png")), None).ledger
        for _ in range(3):
            ledger = apply_image_budget(_text("x" * COMPACTION_WALK_TARGET_BYTES), ledger).ledger
        again = apply_image_budget(_prompt((1, "a.png", "/t/a.png")), compact_ledger(ledger))
        assert again.inlined == 1 and again.sent_earlier == 0
        assert again.blocks[0]["text"] == "look: [image: a.png]"

    def test_the_prompt_in_flight_and_the_two_before_it_stay_charged(self):
        big = COMPACTION_WALK_TARGET_BYTES * 4 // 3  # one image alone reaches the target
        recent = _recent((big, 0, 3), (big, 0, 2), (big, 0, 1), (big, 0, 0))
        kept = compact_ledger({"sid": SID, "hashes": [], "b64_bytes": 4 * big, "recent": recent})
        # Position 3 is beyond the kept pairs and the walk reached its target on
        # positions 1 and 2, so kiro-cli summarized it; the rest stays.
        assert kept["recent"] == _recent((big, 0, 2), (big, 0, 1), (big, 0, 0))
        assert kept["b64_bytes"] == 3 * big

    def test_an_older_heavy_prompt_behind_small_ones_stays_charged(self):
        # kiro-cli walks pairs newest-first until two percent of the window is
        # reached, so small recent images do not shield an older heavy one from
        # the replay; charging it is what keeps the request under the ceiling.
        big = COMPACTION_WALK_TARGET_BYTES * 4 // 3
        recent = _recent((10 * big, 0, 3), (100, 0, 3), (100, 0, 2), (100, 0, 1))
        kept = compact_ledger({"sid": SID, "hashes": [], "b64_bytes": 0, "recent": recent})
        assert kept["recent"] == recent
        assert kept["b64_bytes"] == 10 * big + 300
        # Once the newer prompts alone reach the target, the heavy one is summarized.
        recent = _recent((10 * big, 0, 3), (100, 0, 3), (big, 0, 2), (100, 0, 1))
        kept = compact_ledger({"sid": SID, "hashes": [], "b64_bytes": 0, "recent": recent})
        assert kept["recent"] == _recent((big, 0, 2), (100, 0, 1))
        # Text written after it counts toward the target too.
        recent = _recent((10 * big, COMPACTION_WALK_TARGET_BYTES, 3), (100, 0, 1))
        kept = compact_ledger({"sid": SID, "hashes": [], "b64_bytes": 0, "recent": recent})
        assert kept["recent"] == _recent((100, 0, 1))

    def test_records_a_compaction_could_never_keep_are_dropped_as_prompts_are_written(self):
        big = (COMPACTION_WALK_TARGET_BYTES * 4 // 3 + 3) // 4 * 4  # base64 length: a multiple of 4
        text = len(b"look: [image: t.png]")
        ledger = apply_image_budget(_prompt((1, "t.png", ""), size=big), None).ledger
        ledger = apply_image_budget(_prompt((2, "t.png", ""), size=big), ledger).ledger
        assert ledger["recent"] == _recent((big, 0, 1), (big, 0, 0))
        assert ledger["pending_text"] == text, "the second prompt's text is owed, not yet charged"
        # One text prompt: both within the kept pairs; the owed text lands.
        ledger = apply_image_budget(_text("a"), ledger).ledger
        assert ledger["recent"] == _recent((big, text, 2), (big, 0, 1))
        # A second: the older one is past the pairs and the newer image alone
        # reached the target, so no compaction could keep it -- dropped now.
        ledger = apply_image_budget(_text("b"), ledger).ledger
        assert ledger["recent"] == _recent((big, 1, 2))
        # Digests and the total stay charged until a compaction says otherwise.
        assert len(ledger["hashes"]) == 2 and ledger["b64_bytes"] == 2 * big
        ledger = apply_image_budget(_text("c"), ledger).ledger
        assert ledger["recent"] == _recent((big, 2, 3)), "only the walk can keep it now"
        assert compact_ledger(ledger)["b64_bytes"] == big
        # A paste the size of the target is in flight: kiro-cli keeps the prompt
        # without counting it, so the record survives this write...
        ledger = apply_image_budget(_text("d" * COMPACTION_WALK_TARGET_BYTES), ledger).ledger
        assert ledger["recent"] == _recent((big, 3, 3))
        assert compact_ledger(ledger)["b64_bytes"] == big
        # ...and leaves at the next, once the paste is history the walk counts.
        ledger = apply_image_budget(_text("e"), ledger).ledger
        assert ledger["recent"] == []
        assert compact_ledger(ledger)["b64_bytes"] == 0

    def test_a_text_only_prompt_that_moves_no_record_returns_the_ledger_as_is(self):
        blocks = _text("hi")
        result = apply_image_budget(blocks, empty_ledger(SID))
        assert result.blocks is blocks
        assert result.ledger == empty_ledger(SID)
        assert result.ledger["pending_text"] == 0, "nothing to charge later with no record"

    def test_the_text_of_the_prompt_in_flight_is_walked_only_once_it_is_answered(self):
        """kiro-cli's walk skips the trailing user message -- the prompt whose
        overflow triggered the compaction is kept and not counted -- so a prompt
        large enough to reach the walk target by itself must not push an older
        picture out of the charge while kiro-cli still replays it."""
        ledger = apply_image_budget(_prompt((1, "shot.png", ""), size=200_000), None).ledger
        for _ in range(COMPACTION_KEPT_PAIRS + 1):
            ledger = apply_image_budget(_text("small"), ledger).ledger
        assert ledger["recent"][0]["after"] == COMPACTION_KEPT_PAIRS + 1, "past the kept pairs"
        big = apply_image_budget(_text("w" * COMPACTION_WALK_TARGET_BYTES), ledger).ledger
        assert big["pending_text"] == COMPACTION_WALK_TARGET_BYTES
        assert big["recent"][0]["t"] == 3 * len("small"), "the prompt in flight is not yet charged"
        compacted = compact_ledger(big)
        assert compacted["b64_bytes"] == 200_000, "kiro-cli keeps the pair that crosses the target"
        assert (
            compacted["pending_text"] == COMPACTION_WALK_TARGET_BYTES
        ), "still owed after the refund"
        # Answered and followed by another prompt, the big prompt is history the
        # walk counts: no compaction could keep the picture now, so its record is
        # dropped at this write and the next compaction releases its bytes.
        later = apply_image_budget(_text("next"), compacted).ledger
        assert later["recent"] == []
        assert later["b64_bytes"] == 200_000, "charged until a compaction says otherwise"
        assert later["pending_text"] == 0, "nothing left for the owed text to reach"
        assert compact_ledger(later)["b64_bytes"] == 0

    def test_the_deferred_text_is_charged_to_records_older_than_its_prompt_only(self):
        """The record of the prompt that owes the text gains nothing from it: the
        text written after THAT prompt is the next one, itself deferred."""
        ledger = apply_image_budget(_prompt((1, "a.png", ""), lead=""), None).ledger
        b_blocks = _prompt((2, "b.png", ""), lead="")
        b_text = len(b_blocks[0]["text"].encode("utf-8"))
        ledger = apply_image_budget(b_blocks, ledger).ledger
        assert [e["t"] for e in ledger["recent"]] == [0, 0], "b's text is deferred"
        assert ledger["pending_text"] == b_text
        ledger = apply_image_budget(_text("cccccc"), ledger).ledger
        assert [e["t"] for e in ledger["recent"]] == [b_text, 0], "a gains b's text; b nothing yet"
        assert ledger["pending_text"] == 6
        ledger = apply_image_budget(_text("d"), ledger).ledger
        assert [e["t"] for e in ledger["recent"]] == [b_text + 6, 6]
        assert ledger["pending_text"] == 1

    def test_the_deferred_text_persists_bounded_and_malformed_reads_as_nothing(self):
        ledger = apply_image_budget(_prompt((1, "a.png", "")), None).ledger
        ledger = apply_image_budget(_text("x" * 10), ledger).ledger
        assert normalize_ledger(json.loads(json.dumps(ledger))) == ledger
        assert (
            normalize_ledger({"pending_text": 10**9})["pending_text"]
            == COMPACTION_WALK_TARGET_BYTES
        )
        assert normalize_ledger({"pending_text": -1})["pending_text"] == 0
        assert normalize_ledger({"pending_text": True})["pending_text"] == 0
        assert normalize_ledger({"pending_text": "7"})["pending_text"] == 0
        assert normalize_ledger({})["pending_text"] == 0

    def test_the_record_list_is_bounded(self):
        recent = [{"b": 1, "t": 0, "after": 0} for _ in range(MAX_RECENT_PROMPTS + 5)]
        assert len(normalize_ledger({"recent": recent})["recent"]) == MAX_RECENT_PROMPTS
        ledger = empty_ledger(SID)
        for seed in range(MAX_RECENT_PROMPTS + 3):
            ledger = apply_image_budget(_prompt((seed + 1, "t.png", ""), lead=""), ledger).ledger
        assert len(ledger["recent"]) == MAX_RECENT_PROMPTS
        assert ledger["recent"][-1]["after"] == 0

    def test_bytes_of_records_past_the_cap_stay_charged_until_their_survivor_is_summarized(self):
        """The cap bounds the LIST, never the accounting: a big picture followed by
        more tiny ones than the cap holds is still in kiro-cli's kept tail."""
        big = 5 * 1024 * 1024
        ledger = apply_image_budget(_prompt((1, "big.png", ""), size=big), None).ledger
        for seed in range(MAX_RECENT_PROMPTS):
            ledger = apply_image_budget(_prompt((seed + 2, "t.png", ""), lead=""), ledger).ledger
        assert len(ledger["recent"]) == MAX_RECENT_PROMPTS
        total = ledger["b64_bytes"]
        assert total > big
        assert (
            sum(e["b"] for e in ledger["recent"]) == total
        ), "the sliced record's bytes ride the oldest survivor"
        assert compact_ledger(ledger)["b64_bytes"] == total, "still replayed, still charged"
        # Only when the survivor itself is past the walk are its bytes -- and the
        # folded ones, older still -- refunded. The paste that pushes it there is
        # not counted while in flight; it is at the write that follows it.
        ledger = apply_image_budget(_text("x" * COMPACTION_WALK_TARGET_BYTES), ledger).ledger
        assert compact_ledger(ledger)["b64_bytes"] == total, "the paste is still in flight"
        ledger = apply_image_budget(_text("y"), ledger).ledger
        refunded = compact_ledger(ledger)
        assert refunded["b64_bytes"] < big
        assert refunded["b64_bytes"] == sum(e["b"] for e in ledger["recent"])

    def test_repeated_folds_and_compactions_never_lose_a_charged_byte(self):
        """Every prompt past the cap cuts one more record; each cut folds onto the
        current oldest survivor, through as many compactions as happen along the way."""
        big = 3 * 1024 * 1024
        ledger = apply_image_budget(_prompt((1, "big.png", ""), size=big), None).ledger
        for seed in range(MAX_RECENT_PROMPTS + 10):
            ledger = apply_image_budget(_prompt((seed + 2, "t.png", ""), lead=""), ledger).ledger
            assert len(ledger["recent"]) <= MAX_RECENT_PROMPTS
            assert sum(e["b"] for e in ledger["recent"]) == ledger["b64_bytes"]
            if seed % 7 == 3:
                ledger = compact_ledger(ledger)
                assert ledger["b64_bytes"] >= big, "the big picture is still in the kept tail"
                assert sum(e["b"] for e in ledger["recent"]) == ledger["b64_bytes"]
        assert ledger["recent"][0]["b"] > big, "the oldest survivor carries every cut record"

    def test_a_folded_record_survives_persist_and_reload(self, patched_map):
        big = 5 * 1024 * 1024
        ledger = apply_image_budget(_prompt((1, "big.png", ""), size=big), None).ledger
        for seed in range(MAX_RECENT_PROMPTS + 2):
            ledger = apply_image_budget(_prompt((seed + 2, "t.png", ""), lead=""), ledger).ledger
        assert normalize_ledger(json.loads(json.dumps(ledger))) == ledger
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        assert sm.set_image_ledger("dashboard:1", ledger) is True
        reloaded = SessionMap().get_image_ledger("dashboard:1")
        assert reloaded == ledger
        assert compact_ledger(reloaded)["b64_bytes"] == ledger["b64_bytes"]

    def test_folding_changes_no_keep_decision_and_releases_no_earlier_than_exact(self, monkeypatch):
        """Against the same prompt sequence, an uncapped ledger (no folds) keeps
        exactly the same positions; the folded one refunds no byte the uncapped
        one still holds."""
        rng = random.Random(7)
        sequence = [
            (
                rng.choice([0, 1, 1, 1, 2]),
                rng.choice([200, 200, 400, 400, 4000]),
                rng.randrange(0, 40),
            )
            for _ in range(160)
        ]

        def run(cap: int) -> list[tuple[list[int], int]]:
            monkeypatch.setattr(image_ledger, "MAX_RECENT_PROMPTS", cap)
            ledger = empty_ledger(SID)
            trace = []
            for i, (n_images, size, text_len) in enumerate(sequence):
                specs = [(i * 4 + k + 1, f"i{i}-{k}.png", "") for k in range(n_images)]
                blocks = (
                    _prompt(*specs, lead="w" * text_len, size=size)
                    if specs
                    else _text("w" * text_len)
                )
                ledger = apply_image_budget(blocks, ledger).ledger
                if i % 9 == 5:
                    ledger = compact_ledger(ledger)
                trace.append(
                    (
                        [e["after"] for e in ledger["recent"]][-MAX_RECENT_PROMPTS:],
                        ledger["b64_bytes"],
                    )
                )
            return trace

        capped = run(MAX_RECENT_PROMPTS)
        exact = run(10**6)
        assert any(len(p) == MAX_RECENT_PROMPTS for p, _ in capped), "the cap was reached"
        for (kept_capped, total_capped), (kept_exact, total_exact) in zip(capped, exact):
            assert (
                kept_capped == kept_exact[-MAX_RECENT_PROMPTS:]
            ), "the same newest positions are kept"
            assert total_capped >= total_exact, "a fold never refunds before the exact model does"

    def test_charged_bytes_never_fall_below_what_kiro_cli_can_still_replay(self):
        """Randomized conversations against an oracle of the measured kiro-cli rule:
        keep the newest two (user, assistant) pairs plus, walking newest-first over
        pairs, as many as it takes to reach two percent of the context window in
        raw bytes (images at full weight, assistant replies counted), the pair
        that crosses included; the prompt in flight is re-sent. The oracle counts
        assistant bytes and uses a smaller window, both of which keep LESS than
        the ledger's walk, so the ledger must never charge less than the oracle
        still replays -- through folds, compactions and dedup alike."""
        for seed in range(16):
            rng = random.Random(seed)
            window_tokens = rng.choice([200_000, 400_000, 1_000_000])
            target = window_tokens * 2 // 100 * 4
            # Half the conversations paste tiny pictures turn after turn, the shape
            # that drives the record list past its cap before a compaction.
            tiny = seed % 2 == 1
            sizes = [200, 400, 800] if tiny else [400, 4000, 40_000, 400_000]
            ledger = empty_ledger(SID)
            pairs: list[tuple[int, int, int]] = (
                []
            )  # (user raw bytes, assistant raw bytes, kept image b64)
            for i in range(90):
                n_images = rng.choice([1, 1, 2] if tiny else [0, 0, 1, 1, 1, 2, 3])
                if tiny and i == 0:
                    n_images, size = 1, 2 * 1024 * 1024
                else:
                    size = rng.choice(sizes)
                text_len = rng.randrange(0, 30 if tiny else 2000)
                if not tiny and rng.random() < 0.1:
                    # A paste that reaches the walk target by itself, in the turn
                    # whose overflow triggers the compaction: kiro-cli keeps the
                    # prompt in flight and does not count it.
                    text_len = rng.randrange(target, 2 * target)
                specs = [(rng.randrange(1, 12), f"i{i}-{k}.png", "") for k in range(n_images)]
                blocks = (
                    _prompt(*specs, lead="w" * text_len, size=size)
                    if specs
                    else _text("w" * text_len)
                )
                result = apply_image_budget(blocks, ledger)
                if rng.random() < 0.1:
                    # The runtime dies after the drained write and before any
                    # frame: the prompt is written but unconfirmed. Whether
                    # kiro-cli stored it is a coin nobody sees; the recovery
                    # resumes the same sid and re-queues the message.
                    stored = rng.random() < 0.5
                    written = stage_written(ledger, result.ledger)
                    if stored:
                        dead_b64 = sum(len(b["data"]) for b in _image_blocks(result.blocks))
                        dead_raw = sum(
                            len(b["text"].encode("utf-8"))
                            for b in result.blocks
                            if b["type"] == "text"
                        )
                        pairs.append((dead_raw + dead_b64 * 3 // 4, 0, dead_b64))
                    retry = apply_image_budget(blocks, written)
                    assert retry.sent_earlier == result.sent_earlier, (
                        seed,
                        i,
                        "an undelivered picture must not read as sent earlier",
                    )
                    assert retry.ledger["uncertain_bytes"] >= written["unconfirmed"]["b"]
                    result = retry
                ledger = result.ledger
                sent_b64 = sum(len(b["data"]) for b in _image_blocks(result.blocks))
                text_raw = sum(
                    len(b["text"].encode("utf-8")) for b in result.blocks if b["type"] == "text"
                )
                in_flight = (text_raw + sent_b64 * 3 // 4, 0, sent_b64)
                if rng.random() < 0.2:
                    # kiro-cli compacts with this prompt in flight: it and the kept pairs stay.
                    walked, kept_pairs = 0, 0
                    for user_raw, asst_raw, _ in reversed(pairs):
                        kept_pairs += 1
                        walked += user_raw + asst_raw
                        if walked >= target:
                            break
                    kept_pairs = max(COMPACTION_KEPT_PAIRS, kept_pairs)
                    pairs = pairs[-kept_pairs:] if kept_pairs else []
                    ledger = compact_ledger(ledger)
                    replayable = sum(b64 for _, _, b64 in pairs) + in_flight[2]
                    assert ledger["b64_bytes"] >= replayable, (
                        seed,
                        i,
                        ledger["b64_bytes"],
                        replayable,
                    )
                pairs.append(
                    (in_flight[0], rng.randrange(0, 200 if tiny else 60_000), in_flight[2])
                )

    def test_malformed_records_are_dropped_at_retention(self):
        raw = {
            "recent": [
                {"b": 5, "t": 0, "after": 1},
                {"b": -1, "t": 0, "after": 0},
                {"b": True, "t": 0, "after": 0},
                {"b": 5, "t": 0, "after": "1"},
                {"b": 5, "after": 0},
                "junk",
                {"b": 7, "t": 10**9, "after": 99},
            ]
        }
        assert normalize_ledger(raw)["recent"] == _recent(
            (5, 0, 1), (7, COMPACTION_WALK_TARGET_BYTES, COMPACTION_KEPT_PAIRS + 1)
        )
        assert normalize_ledger({"recent": "no"})["recent"] == []

    def test_the_constants_state_their_derivation(self):
        assert COMPACTION_KEPT_PAIRS == 2
        assert COMPACTION_WALK_TARGET_BYTES == 1_000_000 * 2 // 100 * 4 == 80_000


class TestBuilderAnnotation:
    def test_the_builder_annotates_each_image_with_its_source_and_spans(self, tmp_path):
        p = _png(tmp_path, "shot.png")
        blocks = build_prompt_blocks(f"see {p}")
        assert blocks[0]["text"] == "see [image: shot.png]"
        assert blocks[1][IMAGE_BLOCK_SOURCE_KEY] == {
            "path": str(p),
            "spans": [[4, 4 + len("[image: shot.png]")]],
        }

    def test_every_image_block_the_builder_emits_carries_the_annotation(self, tmp_path):
        # The annotation is the layer's whole contract for rewriting a dropped
        # image's marker (there is no fallback), and the builder is the one
        # producer of image blocks, so every block it emits must carry it --
        # several files, a file named twice, and two files sharing a basename.
        a = _png(tmp_path, "a.png", seed=1)
        b = _png(tmp_path, "b.png", seed=2)
        (tmp_path / "sub").mkdir()
        c = _png(tmp_path / "sub", "a.png", seed=3)
        blocks = build_prompt_blocks(f"{a} then {b}, {a} again, and {c}")
        images = _image_blocks(blocks)
        assert len(images) == 3
        text = blocks[0]["text"]
        for block in images:
            source = block[IMAGE_BLOCK_SOURCE_KEY]
            assert isinstance(source["path"], str) and source["path"]
            assert source["spans"], source
            for start, end in source["spans"]:
                assert text[start:end].startswith("[image: ") and text[start:end].endswith("]")

    def test_the_layer_rewrites_the_marker_the_builder_wrote(self, tmp_path, monkeypatch):
        p = _png(tmp_path, "shot.png")
        first = apply_image_budget(build_prompt_blocks(f"see {p}"), None)
        second = apply_image_budget(build_prompt_blocks(f"again {p}"), first.ledger)
        assert _image_blocks(second.blocks) == []
        assert second.blocks[0]["text"] == "again " + _sent("shot.png", str(p))
        monkeypatch.setattr(image_ledger, "MAX_PROMPT_IMAGE_BLOCKS", 0)
        over = apply_image_budget(build_prompt_blocks(f"see {p}"), None)
        assert over.blocks[0]["text"] == "see " + _over("shot.png", str(p))


def _handle(
    tmp_path: Path,
    sent: list[dict],
    *,
    fail_send: bool = False,
    frames: list[JsonRpcMessage] | None = None,
    session_id: str = SID,
    acp_backend: str = ACP_BACKEND_KIRO,
    agent_version: str = VERIFIED_VERSION,
    die_after_write: bool = False,
) -> AcpSessionHandle:
    """A handle on a fake runtime that records the prompt params and ends the turn.

    A successful send answers itself: the runtime's reader would deliver the
    prompt's result frame (after any ``frames``, which stand in for
    notifications the backend sends first), so the fake queues them as the
    write's side effect -- queueing them before the prompt would have the
    pre-turn stale drain discard them. ``fail_send`` dies at the write instead,
    the shape of a runtime that went away between the build and the write.
    ``die_after_write`` drains the write and then dies before any frame comes
    back: whether the backend stored the prompt is exactly what nobody knows.
    ``agent_version`` is what the process reported at its handshake.
    """
    runtime = AcpRuntime(work_dir=str(tmp_path), acp_backend=acp_backend)
    runtime._initialized = True
    runtime._agent_version = agent_version
    runtime._prompt_capabilities = {"image": True}
    queue: asyncio.Queue = asyncio.Queue()
    runtime._session_queues[session_id] = queue

    async def send_request(method, params):
        sent.append(params)
        if fail_send:
            raise AcpRuntimeDead("died before the write")
        req_id = len(sent)
        if die_after_write:
            queue.put_nowait(None)  # the reader's death sentinel
            return req_id
        for frame in frames or []:
            queue.put_nowait(frame)
        queue.put_nowait(
            JsonRpcMessage.from_dict(
                {"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": "end_turn"}}
            )
        )
        return req_id

    runtime.send_request = send_request
    return AcpSessionHandle(session_id, queue, runtime, session_key="dashboard:1")


async def _turn(handle: AcpSessionHandle, message: str) -> None:
    """Drive one prompt turn to its end (the fake send answers it)."""
    async for _event in handle.prompt(message, timeout=3.0):
        pass


async def _turn_dies(handle: AcpSessionHandle, message: str) -> None:
    gen = handle.prompt(message, timeout=3.0)
    with pytest.raises(AcpRuntimeDead):
        await gen.__anext__()
    await gen.aclose()


def _clear_frame(session_id: str = SID) -> JsonRpcMessage:
    return JsonRpcMessage(method=METHOD_CLEAR_STATUS, params={"sessionId": session_id})


class TestHandleWiring:
    @pytest.mark.asyncio
    async def test_the_handle_applies_the_layer_across_turns(self, tmp_path):
        p = _png(tmp_path, "shot.png")
        sent: list[dict] = []
        handle = _handle(tmp_path, sent)
        await _turn(handle, f"first {p}")
        await _turn(handle, f"second {p}")
        assert [b["type"] for b in sent[0]["prompt"]] == ["text", "image"]
        assert [b["type"] for b in sent[1]["prompt"]] == ["text"]
        assert sent[1]["prompt"][0]["text"] == "second " + _sent("shot.png", str(p))

    @pytest.mark.asyncio
    async def test_nothing_host_side_reaches_the_wire(self, tmp_path):
        p = _png(tmp_path, "shot.png")
        sent: list[dict] = []
        await _turn(_handle(tmp_path, sent), f"see {p}")
        for block in sent[0]["prompt"]:
            assert not any(str(k).startswith("_") for k in block), block.keys()

    @pytest.mark.asyncio
    async def test_a_write_that_raised_is_charged_as_uncertain_and_never_dedups(self, tmp_path):
        """The ledger is committed by the WRITE, not the build: a runtime that dies
        during the write makes the caller re-queue the same message, and that
        retry must still carry the image instead of a ``sent earlier`` marker --
        while the bytes, which may have left with the broken drain, stay charged."""
        p = _png(tmp_path, "shot.png")
        size = len(base64.b64encode(p.read_bytes()))
        sent: list[dict] = []
        dead = _handle(tmp_path, sent, fail_send=True)
        await _turn_dies(dead, f"first {p}")
        assert [b["type"] for b in sent[0]["prompt"]] == ["text", "image"]
        local = dead._image_budget._local
        assert (local["hashes"], local["recent"], local["unconfirmed"]) == ([], [], None)
        assert local["uncertain_bytes"] == size == local["b64_bytes"], "charged, not known"
        # Same handle, same key: the retry must inline again -- and charges again.
        await _turn_dies(dead, f"retry {p}")
        assert [b["type"] for b in sent[1]["prompt"]] == ["text", "image"]
        assert dead._image_budget._local["uncertain_bytes"] == 2 * size

    @pytest.mark.asyncio
    async def test_a_failed_write_leaves_the_durable_record_without_digests(
        self, tmp_path, patched_map
    ):
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        image_ledger.set_image_ledger_store(sm)
        p = _png(tmp_path, "shot.png")
        size = len(base64.b64encode(p.read_bytes()))
        sent: list[dict] = []
        await _turn_dies(_handle(tmp_path, sent, fail_send=True), f"see {p}")
        after_death = sm.get_image_ledger("dashboard:1")
        assert after_death["hashes"] == [] and after_death["uncertain_bytes"] == size
        # A live handle on the same record then sends it for real.
        await _turn(_handle(tmp_path, sent), f"again {p}")
        assert [b["type"] for b in sent[1]["prompt"]] == ["text", "image"]
        assert sm.get_image_ledger("dashboard:1")["hashes"] == [
            image_digest(sent[1]["prompt"][1]["data"])
        ]
        await sm.aclose()

    @pytest.mark.asyncio
    async def test_the_handle_uses_the_durable_record_when_the_session_has_one(
        self, tmp_path, patched_map
    ):
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        image_ledger.set_image_ledger_store(sm)
        p = _png(tmp_path, "shot.png")
        sent: list[dict] = []
        await _turn(_handle(tmp_path, sent), f"see {p}")
        digest = image_digest(sent[0]["prompt"][1]["data"])
        assert sm.get_image_ledger("dashboard:1")["hashes"] == [digest]
        # A NEW handle (a recycled session, same native conversation) dedups.
        await _turn(_handle(tmp_path, sent), f"again {p}")
        assert [b["type"] for b in sent[1]["prompt"]] == ["text"]
        await sm.aclose()

    @pytest.mark.asyncio
    async def test_a_fresh_conversation_behind_a_deferred_promotion_reads_no_old_ledger(
        self, tmp_path, patched_map
    ):
        """Tool-search resume: the entry still records the OLD sid (promotion is
        deferred until the replay-bearing turn lands) while the handle already
        speaks for a NEW empty conversation. Its first prompt must inline the
        picture, and the ledger it writes must survive the later promotion."""
        sm = SessionMap()
        sm.set("dashboard:1", "old-sid")
        image_ledger.set_image_ledger_store(sm)
        p = _png(tmp_path, "shot.png")
        sent: list[dict] = []
        await _turn(_handle(tmp_path, sent, session_id="old-sid"), f"see {p}")
        assert sm.get_image_ledger("dashboard:1")["sid"] == "old-sid"
        # The fresh session (new sid) prompts BEFORE the map records its sid.
        await _turn(_handle(tmp_path, sent, session_id="new-sid"), f"again {p}")
        assert [b["type"] for b in sent[1]["prompt"]] == ["text", "image"], "not deduped"
        assert sm.get_image_ledger("dashboard:1")["sid"] == "new-sid"
        # The landed turn promotes the sid; the new conversation's ledger stays.
        sm.set("dashboard:1", "new-sid")
        await _turn(_handle(tmp_path, sent, session_id="new-sid"), f"third {p}")
        assert [b["type"] for b in sent[2]["prompt"]] == ["text"]
        await sm.aclose()

    @pytest.mark.asyncio
    async def test_a_confirmed_native_clear_forgets_the_inlined_images(self, tmp_path, patched_map):
        """``/clear`` empties the conversation under the SAME sid, so the sid-scoped
        ledger would otherwise still apply; the clear notification this session
        owns must reset it, or a picture attached again would be dropped."""
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        image_ledger.set_image_ledger_store(sm)
        p = _png(tmp_path, "shot.png")
        sent: list[dict] = []
        await _turn(_handle(tmp_path, sent), f"see {p}")
        assert sm.get_image_ledger("dashboard:1")["hashes"], "charged after the write"
        # A turn during which the backend confirms a clear.
        await _turn(_handle(tmp_path, sent, frames=[_clear_frame()]), "wipe it")
        assert sm.get_image_ledger("dashboard:1") == {}
        await _turn(_handle(tmp_path, sent), f"again {p}")
        assert [b["type"] for b in sent[2]["prompt"]] == ["text", "image"]
        await sm.aclose()

    @pytest.mark.asyncio
    async def test_a_fanned_out_clear_is_not_this_sessions_clear(self, tmp_path):
        p = _png(tmp_path, "shot.png")
        sent: list[dict] = []
        handle = _handle(tmp_path, sent)
        await _turn(handle, f"see {p}")
        foreign = _clear_frame()
        foreign.fanout_no_owner = True
        # A second fake runtime delivering the foreign frame, same ledger.
        handle2 = _handle(tmp_path, sent, frames=[foreign])
        handle2._image_budget = handle._image_budget
        await _turn(handle2, "someone else cleared")
        await _turn(handle2, f"again {p}")
        assert [b["type"] for b in sent[2]["prompt"]] == ["text"], "ledger kept"

    @pytest.mark.asyncio
    async def test_the_direct_client_applies_the_same_layer(self, tmp_path):
        p = _png(tmp_path, "shot.png")
        client = AcpClient(work_dir=tmp_path, session_key="dashboard:9")
        client._session_id = "s9"
        sent: list[dict] = []

        async def send_request(method, params):
            sent.append(params)
            return 1

        client._send_request = send_request
        await client._send_prompt(f"one {p}")
        client._image_budget.confirm()  # the turn's first frame, read by _prompt_loop
        await client._send_prompt(f"two {p}")
        client._image_budget.confirm()
        assert [b["type"] for b in sent[0]["prompt"]] == ["text", "image"]
        assert not any(str(k).startswith("_") for k in sent[0]["prompt"][1])
        assert [b["type"] for b in sent[1]["prompt"]] == ["text"]
        # A reset onto a fresh native conversation starts over.
        client._session_id = "s10"
        await client._send_prompt(f"three {p}")
        assert [b["type"] for b in sent[2]["prompt"]] == ["text", "image"]

    @pytest.mark.asyncio
    async def test_the_direct_client_charges_a_failed_write_as_uncertain(self, tmp_path):
        p = _png(tmp_path, "shot.png")
        size = len(base64.b64encode(p.read_bytes()))
        client = AcpClient(work_dir=tmp_path, session_key="dashboard:9")
        client._session_id = "s9"
        sent: list[dict] = []

        async def failing(method, params):
            sent.append(params)
            raise AcpRuntimeDead("pipe closed")

        client._send_request = failing
        with pytest.raises(AcpRuntimeDead):
            await client._send_prompt(f"one {p}")
        local = client._image_budget._local
        assert local["uncertain_bytes"] == size == local["b64_bytes"]
        assert local["hashes"] == [] and local["unconfirmed"] is None

        async def working(method, params):
            sent.append(params)
            return 2

        client._send_request = working
        await client._send_prompt(f"retry {p}")
        assert [b["type"] for b in sent[1]["prompt"]] == ["text", "image"]

    @pytest.mark.asyncio
    async def test_a_clear_typed_as_prompt_text_leaves_the_direct_clients_ledger_alone(
        self, tmp_path
    ):
        """Only a confirmed clear notification empties the ledger. ``/clear`` sent as
        prompt text is an ordinary prompt to the ledger: no harness has been measured
        to clear its conversation on that text, and a ledger emptied for one that did
        not would re-send every picture into a history that still holds them -- the
        growth the ledger exists to stop -- while a ledger kept across a clear that did
        happen costs a ``sent earlier`` marker that names the file."""
        p = _png(tmp_path, "shot.png")
        client = AcpClient(work_dir=tmp_path, session_key="dashboard:9")
        client._session_id = "s9"
        sent: list[dict] = []

        async def send_request(method, params):
            sent.append(params)
            return len(sent)

        client._send_request = send_request
        await client._send_prompt(f"one {p}")
        client._image_budget.confirm()
        before = dict(client._image_budget._local)
        await client._send_prompt("/clear")
        client._image_budget.confirm()
        after = client._image_budget._local
        assert (after["hashes"], after["b64_bytes"]) == (before["hashes"], before["b64_bytes"])
        assert [b["type"] for b in sent[1]["prompt"]] == ["text"]
        await client._send_prompt(f"again {p}")
        assert [b["type"] for b in sent[2]["prompt"]] == ["text"]
        assert "sent earlier" in sent[2]["prompt"][0]["text"]

    @pytest.mark.asyncio
    async def test_the_direct_client_empties_the_ledger_on_a_clear_notification(self, tmp_path):
        from unittest.mock import AsyncMock

        p = _png(tmp_path, "shot.png")
        client = AcpClient(work_dir=tmp_path, session_key="dashboard:9")
        client._session_id = "s1"

        async def send_request(method, params):
            return 1

        client._send_request = send_request
        await client._send_prompt(f"one {p}")
        client._image_budget.confirm()
        assert client._image_budget._local["hashes"]

        clear_msg = JsonRpcMessage(method=METHOD_CLEAR_STATUS, params={"sessionId": "s1"})
        complete_msg = JsonRpcMessage(id=1, result={"status": "complete"})

        async def fake_prompt_loop(req_id, timeout):
            yield "clear", clear_msg
            yield "complete", complete_msg

        client.ensure_ready = AsyncMock()
        client._send_prompt = AsyncMock(return_value=1)
        client._prompt_loop = fake_prompt_loop
        async for _event in client.stream_events("test"):
            pass
        assert client._image_budget._local == empty_ledger("s1")

    @pytest.mark.asyncio
    async def test_a_clear_typed_as_prompt_text_leaves_the_handles_ledger_alone(self, tmp_path):
        """The shared-runtime writer: the text is a prompt, the notification is the reset."""
        p = _png(tmp_path, "shot.png")
        sent: list[dict] = []
        handle = _handle(tmp_path, sent)
        await _turn(handle, f"see {p}")
        before = dict(handle._image_budget._local)
        await _turn(handle, "/clear")
        after = handle._image_budget._local
        assert (after["hashes"], after["b64_bytes"]) == (before["hashes"], before["b64_bytes"])
        await _turn(handle, f"again {p}")
        assert [b["type"] for b in sent[2]["prompt"]] == ["text"]


def _compaction_frame(status: str = "completed", session_id: str = SID) -> JsonRpcMessage:
    return JsonRpcMessage(
        method=METHOD_COMPACTION_STATUS,
        params={"sessionId": session_id, "status": {"type": status}, "summary": ""},
    )


class TestCompactionVerifiedVersions:
    """The refund is released only to a kiro-cli whose kept tail was read in its
    source: a stable or nightly build inside the verified range. Anything the
    range cannot place -- newer, a later nightly of the ceiling release, an rc or
    feature build, a source build, nothing at all -- keeps the ledger."""

    def test_the_range_is_the_one_the_source_was_read_at(self):
        assert COMPACTION_VERIFIED_KIRO_CLI_RELEASES == ((2, 17, 0), (2, 24, 1))
        assert COMPACTION_VERIFIED_KIRO_CLI_LAST_NIGHTLY == 2

    @pytest.mark.parametrize(
        "version",
        [
            "2.17.0",  # floor release
            "2.17.1-nightly.1",  # first nightly past the floor
            "2.21.0",
            "2.21.5-nightly.8",
            "2.24.0",
            "2.24.1-nightly.1",
            "2.24.1-nightly.2",  # last verified nightly of the ceiling release
            "2.24.1",  # ceiling release
            " 2.24.1 ",  # the handshake value is stripped
        ],
    )
    def test_a_verified_build_refunds(self, version):
        assert kiro_cli_compaction_verified(version)

    @pytest.mark.parametrize(
        "version",
        [
            "2.24.1-nightly.3",  # a later main than the one read
            "2.24.2-nightly.1",
            "2.24.2",
            "2.25.0",
            "3.0.0",
            "2.16.3",  # below the floor
            "2.16.3-nightly.3",
            "2.24.1-rc.1",  # cut from a release branch the range says nothing about
            "2.23.1-autocomplete-decouple.3",  # a feature build
            "2.22.0-new-bundle.2",
            "0.0.0-dev",  # a source build
            "",  # no handshake yet
            "2.24",  # not a release triple
            "v2.24.1",
            "kiro-cli 2.24.1",
            "2.24.1+build.7",
            "2.24.1-nightly",
            "2.24.1-nightly.",
            "2.24.1-Nightly.2",
            "02.24.1x",
        ],
    )
    def test_an_unverified_build_does_not(self, version):
        assert not kiro_cli_compaction_verified(version)

    def test_the_decision_needs_the_kiro_backend_and_a_verified_version(self):
        assert compaction_refunds(ACP_BACKEND_KIRO, VERIFIED_VERSION)
        assert not compaction_refunds(ACP_BACKEND_KAS, VERIFIED_VERSION)
        assert not compaction_refunds("claude", VERIFIED_VERSION)
        assert not compaction_refunds(ACP_BACKEND_KIRO, NEWER_VERSION)
        assert not compaction_refunds(ACP_BACKEND_KIRO, "")
        assert not compaction_refunds(ACP_BACKEND_KIRO, "0.0.0-dev")


class TestCompactionWiring:
    """The completed kiro-cli compaction this session owns refunds its ledger, on
    every path the notification can take; a co-tenant's does not."""

    @pytest.mark.asyncio
    async def test_the_handle_refunds_the_durable_ledger_on_its_own_compaction(
        self, tmp_path, patched_map, caps
    ):
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        image_ledger.set_image_ledger_store(sm)
        p = _png(tmp_path, "shot.png")
        sent: list[dict] = []
        await _turn(_handle(tmp_path, sent), f"see {p}")
        size = len(sent[0]["prompt"][1]["data"])
        caps(session_b64=size)
        await _turn(_handle(tmp_path, sent), f"more {_png(tmp_path, 'two.png', seed=2)}")
        assert [b["type"] for b in sent[1]["prompt"]] == ["text"], "budget spent"
        # A turn during which kiro-cli reports the compaction it ran.
        await _turn(_handle(tmp_path, sent, frames=[_compaction_frame()]), "long story")
        ledger = sm.get_image_ledger("dashboard:1")
        assert ledger["hashes"] == []
        # The picture is the prompt two positions back: still in the kept tail.
        assert ledger["b64_bytes"] == size
        assert ledger["recent"] and ledger["recent"][-1]["b"] == size
        # The repeat is inlined again (the summary swallowed it), and the second
        # picture now fits because the budget only holds what the tail replays.
        caps(session_b64=2 * size)
        await _turn(_handle(tmp_path, sent), f"again {p}")
        assert [b["type"] for b in sent[3]["prompt"]] == ["text", "image"]
        await sm.aclose()

    @pytest.mark.asyncio
    async def test_a_fanned_out_compaction_is_not_this_sessions(self, tmp_path):
        p = _png(tmp_path, "shot.png")
        sent: list[dict] = []
        handle = _handle(tmp_path, sent)
        await _turn(handle, f"see {p}")
        foreign = _compaction_frame()
        foreign.fanout_no_owner = True
        handle2 = _handle(tmp_path, sent, frames=[foreign])
        handle2._image_budget = handle._image_budget
        await _turn(handle2, "someone else compacted")
        assert handle._image_budget._local["hashes"], "ledger kept"
        await _turn(handle2, f"again {p}")
        assert [b["type"] for b in sent[2]["prompt"]] == ["text"]

    @pytest.mark.asyncio
    async def test_a_failed_or_started_compaction_refunds_nothing(self, tmp_path):
        p = _png(tmp_path, "shot.png")
        sent: list[dict] = []
        handle = _handle(tmp_path, sent)
        await _turn(handle, f"see {p}")
        before = dict(handle._image_budget._local)
        frames = [_compaction_frame("started"), _compaction_frame("failed")]
        handle2 = _handle(tmp_path, sent, frames=frames)
        handle2._image_budget = handle._image_budget
        await _turn(handle2, "try")
        after = handle._image_budget._local
        assert (after["hashes"], after["b64_bytes"]) == (before["hashes"], before["b64_bytes"])

    @pytest.mark.asyncio
    async def test_the_wait_for_compaction_drain_refunds_too(self, tmp_path):
        """The threshold-triggered compaction bypasses the prompt dispatch loop."""
        p = _png(tmp_path, "shot.png")
        sent: list[dict] = []
        handle = _handle(tmp_path, sent)
        await _turn(handle, f"see {p}")
        assert handle._image_budget._local["hashes"]
        handle._queue.put_nowait(_compaction_frame())
        result = await handle.wait_for_compaction(timeout=2.0)
        assert result["type"] == "completed"
        assert handle._image_budget._local["hashes"] == []

    @pytest.mark.asyncio
    async def test_the_drain_leaves_the_ledger_alone_for_a_fanned_out_compaction(self, tmp_path):
        """A co-tenant's completed frame reaches the drain too; it summarized THEIR replay."""
        p = _png(tmp_path, "shot.png")
        sent: list[dict] = []
        handle = _handle(tmp_path, sent)
        await _turn(handle, f"see {p}")
        before = dict(handle._image_budget._local)
        assert before["hashes"]
        foreign = _compaction_frame()
        foreign.fanout_no_owner = True
        handle._queue.put_nowait(foreign)
        result = await handle.wait_for_compaction(timeout=2.0)
        assert result["type"] == "completed"
        after = handle._image_budget._local
        assert (after["hashes"], after["b64_bytes"]) == (before["hashes"], before["b64_bytes"])
        await _turn(handle, f"again {p}")
        assert [b["type"] for b in sent[1]["prompt"]] == ["text"], "still deduped"

    @pytest.mark.asyncio
    async def test_the_direct_client_refunds_on_its_compaction_chokepoint(self, tmp_path):
        p = _png(tmp_path, "shot.png")
        client = AcpClient(work_dir=tmp_path, session_key="dashboard:9")
        client._session_id = "s9"
        client._agent_version = VERIFIED_VERSION

        async def send_request(method, params):
            return 1

        client._send_request = send_request
        await client._send_prompt(f"one {p}")
        client._image_budget.confirm()  # the turn's first frame, read by _prompt_loop
        assert client._image_budget._local["hashes"]
        client._handle_compaction_status(_compaction_frame("failed", "s9"))
        assert client._image_budget._local["hashes"], "a failure refunds nothing"
        client._handle_compaction_status(_compaction_frame("completed", "s9"))
        assert client._image_budget._local["hashes"] == []

    @pytest.mark.asyncio
    async def test_an_unverified_kiro_cli_keeps_the_ledger_across_its_compaction(self, tmp_path):
        """A build the range cannot place may keep a longer tail than the walk
        mirrors; its compaction leaves the ledger charged, and the repeat deduped."""
        p = _png(tmp_path, "shot.png")
        sent: list[dict] = []
        handle = _handle(tmp_path, sent, agent_version=NEWER_VERSION)
        await _turn(handle, f"see {p}")
        before = dict(handle._image_budget._local)
        assert before["hashes"]
        handle2 = _handle(tmp_path, sent, frames=[_compaction_frame()], agent_version=NEWER_VERSION)
        handle2._image_budget = handle._image_budget
        await _turn(handle2, "a long story")
        after = handle._image_budget._local
        assert (after["hashes"], after["b64_bytes"]) == (before["hashes"], before["b64_bytes"])
        await _turn(handle2, f"again {p}")
        assert [b["type"] for b in sent[2]["prompt"]] == ["text"], "still deduped"

    @pytest.mark.asyncio
    async def test_the_drain_keeps_the_ledger_for_an_unverified_kiro_cli(self, tmp_path):
        p = _png(tmp_path, "shot.png")
        sent: list[dict] = []
        handle = _handle(tmp_path, sent, agent_version="0.0.0-dev")
        await _turn(handle, f"see {p}")
        before = dict(handle._image_budget._local)
        handle._queue.put_nowait(_compaction_frame())
        result = await handle.wait_for_compaction(timeout=2.0)
        assert result["type"] == "completed"
        after = handle._image_budget._local
        assert (after["hashes"], after["b64_bytes"]) == (before["hashes"], before["b64_bytes"])

    @pytest.mark.asyncio
    async def test_the_direct_client_keeps_the_ledger_for_an_unverified_kiro_cli(self, tmp_path):
        p = _png(tmp_path, "shot.png")
        client = AcpClient(work_dir=tmp_path, session_key="dashboard:9")
        client._session_id = "s9"
        client._agent_version = "2.24.1-nightly.3"

        async def send_request(method, params):
            return 1

        client._send_request = send_request
        await client._send_prompt(f"one {p}")
        before = dict(client._image_budget._local)
        client._handle_compaction_status(_compaction_frame("completed", "s9"))
        after = client._image_budget._local
        assert (after["hashes"], after["b64_bytes"]) == (before["hashes"], before["b64_bytes"])

    @pytest.mark.asyncio
    async def test_the_decision_follows_the_version_the_resumed_process_reports(
        self, tmp_path, patched_map
    ):
        """The version is per process: after a restart the new handshake decides.
        The durable ledger charged under a verified build is kept by an
        unverified one, and refunded again once a verified build is back."""
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        image_ledger.set_image_ledger_store(sm)
        p = _png(tmp_path, "shot.png")
        sent: list[dict] = []
        await _turn(_handle(tmp_path, sent), f"see {p}")
        charged = dict(sm.get_image_ledger("dashboard:1"))
        assert charged["hashes"] and charged["b64_bytes"]
        # Restart onto a newer kiro-cli: its compaction leaves the record alone.
        newer = _handle(tmp_path, sent, frames=[_compaction_frame()], agent_version=NEWER_VERSION)
        await _turn(newer, "more")
        kept = sm.get_image_ledger("dashboard:1")
        assert (kept["hashes"], kept["b64_bytes"]) == (charged["hashes"], charged["b64_bytes"])
        # Restart back onto a verified kiro-cli: its compaction refunds.
        verified = _handle(tmp_path, sent, frames=[_compaction_frame()])
        await _turn(verified, "more still")
        assert sm.get_image_ledger("dashboard:1")["hashes"] == []
        await sm.aclose()


class TestUncertainWrites:
    """A prompt is charged when written and KNOWN only once the runtime speaks for
    it. A runtime that dies after the drained write leaves nobody able to say
    whether the conversation holds the prompt: its bytes stay charged for good
    (an over-charge costs allowance; an under-charge is the wire growth this
    layer stops), while its digests and record advance are dropped so the
    re-queued retry inlines the picture again instead of calling it sent."""

    @pytest.mark.asyncio
    async def test_a_death_after_the_write_leaves_the_prompt_charged_but_unknown(
        self, tmp_path, patched_map
    ):
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        image_ledger.set_image_ledger_store(sm)
        p = _png(tmp_path, "shot.png")
        size = len(base64.b64encode(p.read_bytes()))
        sent: list[dict] = []
        dying = _handle(tmp_path, sent, die_after_write=True)
        with pytest.raises(AcpProcessDied):
            await _turn(dying, f"see {p}")
        written = sm.get_image_ledger("dashboard:1")
        assert written["b64_bytes"] == size, "charged at the write"
        assert written["hashes"] == [] and written["recent"] == []
        assert written["unconfirmed"]["hashes"] == [image_digest(sent[0]["prompt"][1]["data"])]
        # Recovery resumes the SAME sid and re-queues the message (a new handle on
        # the same record): the retry inlines the picture again, whatever the
        # dead runtime did with the first copy.
        await _turn(_handle(tmp_path, sent), f"see {p}")
        assert [b["type"] for b in sent[1]["prompt"]] == ["text", "image"], "no false sent-earlier"
        ledger = sm.get_image_ledger("dashboard:1")
        assert ledger["uncertain_bytes"] == size, "the first copy stays charged"
        assert ledger["b64_bytes"] == 2 * size, "both copies charged: the backend may hold both"
        assert ledger["hashes"] == [image_digest(sent[1]["prompt"][1]["data"])]
        assert ledger["recent"] == _recent((size, 0, 0)), "one position advanced, not two"
        # Known from here: the next repeat is deduped.
        await _turn(_handle(tmp_path, sent), f"again {p}")
        assert [b["type"] for b in sent[2]["prompt"]] == ["text"]
        await sm.aclose()

    @pytest.mark.asyncio
    async def test_repeated_deaths_charge_each_copy_and_never_dedup_the_retry(
        self, tmp_path, patched_map
    ):
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        image_ledger.set_image_ledger_store(sm)
        p = _png(tmp_path, "shot.png")
        size = len(base64.b64encode(p.read_bytes()))
        sent: list[dict] = []
        for _ in range(3):
            with pytest.raises(AcpProcessDied):
                await _turn(_handle(tmp_path, sent, die_after_write=True), f"see {p}")
        await _turn(_handle(tmp_path, sent), f"see {p}")
        assert all([b["type"] for b in s["prompt"]] == ["text", "image"] for s in sent)
        ledger = sm.get_image_ledger("dashboard:1")
        assert ledger["uncertain_bytes"] == 3 * size and ledger["b64_bytes"] == 4 * size
        # A compaction refunds only what the records describe; the uncertain
        # copies stay charged, since no compaction can say whether the replay
        # carries them.
        compacted = compact_ledger(ledger)
        assert compacted["b64_bytes"] == 4 * size and compacted["uncertain_bytes"] == 3 * size
        await sm.aclose()

    @pytest.mark.asyncio
    async def test_an_unconfirmed_write_survives_reload_and_the_next_writer_invalidates_it(
        self, tmp_path, patched_map
    ):
        first = SessionMap()
        first.set("dashboard:1", SID)
        image_ledger.set_image_ledger_store(first)
        p = _png(tmp_path, "shot.png")
        size = len(base64.b64encode(p.read_bytes()))
        sent: list[dict] = []
        with pytest.raises(AcpProcessDied):
            await _turn(_handle(tmp_path, sent, die_after_write=True), f"see {p}")
        await first.aclose()  # the gateway restarts: the deferred flush had landed
        second = SessionMap()
        image_ledger.set_image_ledger_store(second)
        reloaded = second.get_image_ledger("dashboard:1")
        assert reloaded["unconfirmed"] is not None and reloaded["b64_bytes"] == size
        assert normalize_ledger(json.loads(json.dumps(reloaded))) == reloaded
        await _turn(_handle(tmp_path, sent), f"see {p}")
        assert [b["type"] for b in sent[1]["prompt"]] == ["text", "image"]
        after = second.get_image_ledger("dashboard:1")
        assert after["unconfirmed"] is None and after["uncertain_bytes"] == size
        await second.aclose()

    @pytest.mark.asyncio
    async def test_an_unaccepted_prompt_does_not_advance_the_retention_walk(self, tmp_path):
        """Two records sit within the kept pairs. A text prompt whose runtime died
        unconfirmed, then its retry, must move them ONE position -- the retry's
        -- never two, or the older picture would face the walk a prompt early."""
        p1, p2 = _png(tmp_path, "one.png"), _png(tmp_path, "two.png", seed=2)
        sent: list[dict] = []
        handle = _handle(tmp_path, sent)
        await _turn(handle, f"see {p1}")
        await _turn(handle, f"see {p2}")
        assert [e["after"] for e in handle._image_budget._local["recent"]] == [1, 0]
        dying = _handle(tmp_path, sent, die_after_write=True)
        dying._image_budget = handle._image_budget
        with pytest.raises(AcpProcessDied):
            await _turn(dying, "a long story " * 100)
        assert [e["after"] for e in handle._image_budget._local["recent"]] == [1, 0], "unknown yet"
        await _turn(handle, "a long story " * 100)  # the re-queued retry
        assert [e["after"] for e in handle._image_budget._local["recent"]] == [2, 1]

    @pytest.mark.asyncio
    async def test_an_error_answer_to_the_prompt_confirms_nothing(self, tmp_path):
        """The runtime refusing the request is its only frame: the prompt is not in
        the conversation, so its digests must not become known."""
        p = _png(tmp_path, "shot.png")
        size = len(base64.b64encode(p.read_bytes()))
        sent: list[dict] = []
        handle = _handle(tmp_path, sent)
        queue = handle._queue
        runtime = handle._runtime

        async def refusing(method, params):
            sent.append(params)
            queue.put_nowait(
                JsonRpcMessage.from_dict(
                    {
                        "jsonrpc": "2.0",
                        "id": len(sent),
                        "error": {"code": -32602, "message": "Invalid params"},
                    }
                )
            )
            return len(sent)

        runtime.send_request = refusing
        with pytest.raises(Exception):
            await _turn(handle, f"see {p}")
        ledger = handle._image_budget._local
        assert ledger["unconfirmed"] is not None and ledger["hashes"] == []
        # The same picture attached again is inlined again, not called sent.
        runtime.send_request = _handle(tmp_path, sent)._runtime.send_request
        await _turn(handle, f"see {p}")
        assert [b["type"] for b in sent[1]["prompt"]] == ["text", "image"]
        assert handle._image_budget._local["uncertain_bytes"] == size

    @pytest.mark.asyncio
    async def test_a_compaction_frame_confirms_the_written_prompt_first(self, tmp_path, caps):
        """The completed compaction kiro-cli reports during the turn is the backend
        speaking for a conversation that holds the prompt: it counts, then refunds."""
        p = _png(tmp_path, "shot.png")
        size = len(base64.b64encode(p.read_bytes()))
        sent: list[dict] = []
        handle = _handle(tmp_path, sent, frames=[_compaction_frame()])
        await _turn(handle, f"see {p}")
        ledger = handle._image_budget._local
        assert ledger["unconfirmed"] is None and ledger["uncertain_bytes"] == 0
        assert ledger["hashes"] == [], "the compaction forgot the digest"
        assert ledger["b64_bytes"] == size, "the prompt in flight is kept and charged"
        assert ledger["recent"] == _recent((size, 0, 0))


class TestStoreFailures:
    """``store_image_ledger`` reports a refused write instead of raising; the
    budget must not lose the charge on that path, and what it cannot save is
    named, not assumed small."""

    @pytest.mark.asyncio
    async def test_repeated_refusals_keep_the_charge_in_memory(self, tmp_path, patched_map):
        """The entry is gone (deleted under a live handle): every durable write is
        refused, and the ledger lives on the handle for the rest of its life."""
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        image_ledger.set_image_ledger_store(sm)
        p = _png(tmp_path, "shot.png")
        size = len(base64.b64encode(p.read_bytes()))
        sent: list[dict] = []
        handle = _handle(tmp_path, sent)
        await _turn(handle, f"see {p}")
        assert sm.get_image_ledger("dashboard:1")["hashes"], "durable while the entry exists"
        sm.delete("dashboard:1")
        assert sm.get_image_ledger("dashboard:1") is None
        # The record is gone: the next prompts are refused by the store, three
        # times over, and nothing is lost on the handle.
        for name, seed in (("two.png", 2), ("three.png", 3), ("four.png", 4)):
            await _turn(handle, f"see {_png(tmp_path, name, seed=seed)}")
        assert sm.get_image_ledger("dashboard:1") is None, "no entry was re-materialized"
        local = handle._image_budget._local
        assert len(local["hashes"]) == 3 and local["b64_bytes"] == 3 * size
        await _turn(handle, f"again {_png(tmp_path, 'two.png', seed=2)}")
        assert [b["type"] for b in sent[-1]["prompt"]] == ["text"], "still deduped in memory"
        await sm.aclose()

    @pytest.mark.asyncio
    async def test_flush_failures_leave_a_restart_without_a_ledger(
        self, tmp_path, patched_map, monkeypatch
    ):
        """RESIDUAL, pinned: the ledger shares the session map's durability. A
        map whose flushes keep failing (disk full, permissions) answers every
        read from memory, so the live process stays consistent, but the file
        never learns the ledger: the next process reads NO ledger -- the first
        image's bytes and every later one's -- and the conversation resumes in
        the pre-ledger shape. This is bounded by the map's contract, not by one
        prompt."""
        sm = SessionMap()
        sm.set("dashboard:1", SID)
        await sm.aclose()  # the entry itself is on disk
        sm = SessionMap()
        image_ledger.set_image_ledger_store(sm)

        def failing_write(payload: str, seq: int) -> None:
            raise OSError("disk full")

        monkeypatch.setattr(sm, "_write_payload", failing_write)
        p = _png(tmp_path, "shot.png")
        sent: list[dict] = []
        handle = _handle(tmp_path, sent)
        for name, seed in (("shot.png", 1), ("two.png", 2), ("three.png", 3)):
            await _turn(handle, f"see {_png(tmp_path, name, seed=seed)}")
        assert len(sm.get_image_ledger("dashboard:1")["hashes"]) == 3, "live reads are served"
        await _turn(handle, f"again {p}")
        assert [b["type"] for b in sent[-1]["prompt"]] == ["text"]
        with pytest.raises(OSError):
            await sm.aclose()  # the final flush is where the disk error surfaces
        restarted = SessionMap()
        assert restarted.get_image_ledger("dashboard:1") == {}, "nothing reached the file"


class TestWithheldNotice:
    """An image kept off the wire as over the budget is told to the user, not
    only to the model and the log."""

    def test_the_notice_names_counts_and_caps_only(self):
        one = withheld_notice(1, refunds_on_compaction=True)
        assert one.startswith("\u26a0\ufe0f One image was not sent to the model")
        assert "20 images or 12 MiB per message, 24 MiB per conversation" in one
        assert "/new" in one
        assert withheld_notice(3, refunds_on_compaction=True).startswith(
            "\u26a0\ufe0f 3 images were not sent"
        )

    def test_the_notice_promises_the_refund_only_where_a_compaction_refunds(self):
        kiro = withheld_notice(1, refunds_on_compaction=True)
        other = withheld_notice(1, refunds_on_compaction=False)
        assert "refunded when the conversation is compacted" in kiro
        assert "refund" not in other and "compact" not in other
        assert "24 MiB per conversation)." in other
        assert other.startswith("\u26a0\ufe0f One image was not sent to the model")
        assert "/new starts a conversation with a fresh budget" in other

    @pytest.mark.asyncio
    async def test_commit_reports_the_withheld_count_even_when_nothing_was_charged(self, caps):
        caps(prompt_images=0)
        budget = _budget("k")
        blocks = await budget.apply(_prompt((1, "a.png", "/t/a.png"), (2, "b.png", "/t/b.png")))
        assert _image_blocks(blocks) == []
        assert budget.commit() == 2
        assert budget.commit() == 0, "reported once"
        await budget.apply(_prompt((3, "c.png", "")))
        budget.discard()
        assert budget.commit() == 0
        assert await budget.apply(_text("hi")) and budget.commit() == 0

    @pytest.mark.asyncio
    async def test_the_handle_yields_the_notice_before_the_turns_own_events(self, tmp_path, caps):
        caps(prompt_images=0)
        p = _png(tmp_path, "shot.png")
        sent: list[dict] = []
        handle = _handle(tmp_path, sent)
        events = [e async for e in handle.prompt(f"see {p}", timeout=3.0)]
        assert [b["type"] for b in sent[0]["prompt"]] == ["text"]
        assert events[0].kind == EVENT_IMAGE_BUDGET
        assert events[0].text == withheld_notice(1, refunds_on_compaction=True)
        assert events[-1].kind == EVENT_COMPLETE
        # A backend whose compaction never refunds is not promised a refund.
        kas = _handle(tmp_path, sent, acp_backend=ACP_BACKEND_KAS)
        events = [e async for e in kas.prompt(f"see {p}", timeout=3.0)]
        assert events[0].kind == EVENT_IMAGE_BUDGET
        assert events[0].text == withheld_notice(1, refunds_on_compaction=False)
        assert "compact" not in events[0].text
        # Nor is a kiro-cli the verified range cannot place -- and the compaction
        # that follows acts on the same answer the notice gave.
        newer = _handle(tmp_path, sent, frames=[_compaction_frame()], agent_version=NEWER_VERSION)
        events = [e async for e in newer.prompt(f"see {p}", timeout=3.0)]
        assert events[0].text == withheld_notice(1, refunds_on_compaction=False)
        caps(prompt_images=MAX_PROMPT_IMAGE_BLOCKS)
        # This turn inlines the picture, then carries the completed compaction.
        await _turn(newer, f"now {p}")
        assert newer._image_budget._local["hashes"], "kept, as the notice said nothing else"
        # Nothing withheld, nothing said.
        events = [e async for e in handle.prompt(f"see {p}", timeout=3.0)]
        assert all(e.kind != EVENT_IMAGE_BUDGET for e in events)
        # A repeat is not a loss: the conversation already carries the picture.
        events = [e async for e in handle.prompt(f"again {p}", timeout=3.0)]
        assert "sent earlier" in sent[-1]["prompt"][0]["text"]
        assert all(e.kind != EVENT_IMAGE_BUDGET for e in events)

    @pytest.mark.asyncio
    async def test_the_direct_client_yields_the_same_notice(self, tmp_path, caps):
        from unittest.mock import AsyncMock

        caps(prompt_images=0)
        p = _png(tmp_path, "shot.png")
        client = AcpClient(work_dir=tmp_path, session_key="dashboard:9")
        client._session_id = "s1"
        client._agent_version = VERIFIED_VERSION
        sent: list[dict] = []

        async def send_request(method, params):
            sent.append(params)
            return 1

        client._send_request = send_request
        complete_msg = JsonRpcMessage(id=1, result={"stopReason": "end_turn"})

        async def fake_prompt_loop(req_id, timeout):
            yield "complete", complete_msg

        client.ensure_ready = AsyncMock()
        client._prompt_loop = fake_prompt_loop
        events = [e async for e in client.stream_events(f"see {p}")]
        assert [b["type"] for b in sent[0]["prompt"]] == ["text"]
        assert events[0].kind == EVENT_IMAGE_BUDGET
        assert events[0].text == withheld_notice(1, refunds_on_compaction=True)
        events = [e async for e in client.stream_events("text only")]
        assert all(e.kind != EVENT_IMAGE_BUDGET for e in events)
        # A kiro-cli the verified range cannot place is promised no refund...
        client._agent_version = NEWER_VERSION
        events = [e async for e in client.stream_events(f"see {_png(tmp_path, 'two.png', seed=2)}")]
        assert events[0].kind == EVENT_IMAGE_BUDGET
        assert events[0].text == withheld_notice(1, refunds_on_compaction=False)
        # ...and neither is a backend that never refunds.
        client._agent_version = VERIFIED_VERSION
        client._acp_backend = ACP_BACKEND_KAS
        events = [
            e async for e in client.stream_events(f"see {_png(tmp_path, 'three.png', seed=3)}")
        ]
        assert events[0].kind == EVENT_IMAGE_BUDGET
        assert events[0].text == withheld_notice(1, refunds_on_compaction=False)


class TestResume:
    """After a gateway restart the resumed session is judged by the conversation it
    lands on: the same native conversation still replays the picture, so its
    repeat is deduped; a fresh one does not, so its repeat is inlined."""

    @pytest.mark.asyncio
    async def test_a_conversation_that_predates_the_ledger_resumes_with_an_empty_one(
        self, tmp_path, patched_map, caps
    ):
        """RESIDUAL, pinned: a session record written before this module existed
        has no ledger, yet the native conversation it resumes (``session/load``,
        same sid) may already carry pictures inlined under the old code. The
        budget cannot see them -- kiro-cli's load replays only text blocks, so
        nothing on the wire names them -- and so it admits a full allowance on top
        of them: a picture the conversation already holds is inlined again and
        charged as if first, and the per-session cap counts from zero. The same
        shape is reached by any conversation whose entry gains no ledger: a
        transferred Layer B context window joined to a fresh entry, a kept
        subagent conversation seeded for continuation after its in-memory
        ledger died with the run."""
        sm = SessionMap()
        sm.set("dashboard:1", SID)  # the legacy record: a sid, no image_ledger field
        image_ledger.set_image_ledger_store(sm)
        assert sm.get_image_ledger("dashboard:1") == {}, "no ledger, not an empty one"
        p = _png(tmp_path, "shot.png")
        size = len(base64.b64encode(p.read_bytes()))
        # The conversation already replays shot.png (pre-module turn); nothing
        # tells the ledger so. The resumed session attaches it again:
        sent: list[dict] = []
        await _turn(_handle(tmp_path, sent), f"again {p}")
        assert [b["type"] for b in sent[0]["prompt"]] == ["text", "image"], "inlined, not deduped"
        ledger = sm.get_image_ledger("dashboard:1")
        assert ledger["b64_bytes"] == size, "charged as the first picture of the conversation"
        # From here on the budget holds: the repeat is deduped and the cap binds.
        await _turn(_handle(tmp_path, sent), f"once more {p}")
        assert [b["type"] for b in sent[1]["prompt"]] == ["text"]
        caps(session_b64=size)
        await _turn(_handle(tmp_path, sent), f"new {_png(tmp_path, 'two.png', seed=2)}")
        assert [b["type"] for b in sent[2]["prompt"]] == ["text"], "over the (zero-based) cap"
        await sm.aclose()

    @pytest.mark.asyncio
    async def test_a_restart_that_resumes_the_same_conversation_dedups(self, tmp_path, patched_map):
        first_map = SessionMap()
        first_map.set("dashboard:1", SID)
        image_ledger.set_image_ledger_store(first_map)
        p = _png(tmp_path, "shot.png")
        sent: list[dict] = []
        await _turn(_handle(tmp_path, sent), f"see {p}")
        await first_map.aclose()  # the deferred flush lands before the "restart"

        second_map = SessionMap()
        image_ledger.set_image_ledger_store(second_map)
        assert second_map.mapped_sid("dashboard:1") == SID, "resume found the same sid"
        await _turn(_handle(tmp_path, sent), f"again {p}")
        assert [b["type"] for b in sent[1]["prompt"]] == ["text"]
        assert sent[1]["prompt"][0]["text"] == "again " + _sent("shot.png", str(p))
        await second_map.aclose()

    @pytest.mark.asyncio
    async def test_a_restart_that_lands_on_a_fresh_conversation_inlines(
        self, tmp_path, patched_map
    ):
        first_map = SessionMap()
        first_map.set("dashboard:1", SID)
        image_ledger.set_image_ledger_store(first_map)
        p = _png(tmp_path, "shot.png")
        sent: list[dict] = []
        await _turn(_handle(tmp_path, sent), f"see {p}")
        await first_map.aclose()

        # The resume could not load the old conversation: a new sid is recorded.
        second_map = SessionMap()
        second_map.set("dashboard:1", "sid-after-restart")
        image_ledger.set_image_ledger_store(second_map)
        assert second_map.get_image_ledger("dashboard:1") == {}
        await _turn(_handle(tmp_path, sent, session_id="sid-after-restart"), f"again {p}")
        assert [b["type"] for b in sent[1]["prompt"]] == ["text", "image"]
        assert second_map.get_image_ledger("dashboard:1")["sid"] == "sid-after-restart"
        await second_map.aclose()


class TestSpec:
    def test_the_layer_is_listed_in_the_spec_beside_the_per_image_caps(self):
        text = SPEC.read_text(encoding="utf-8")
        assert "image_ledger.py" in text and "SessionImageBudget" in text

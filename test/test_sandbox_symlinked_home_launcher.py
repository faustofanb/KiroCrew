"""A symlinked home hands the launcher ONE name per directory, and the launcher runs.

``/home/u -> /mnt/home/u``: ``Path.home()`` keeps the link spelling and
``config_dir()`` returns the resolved one, so every crew-home path has two
spellings that reach one directory. The launcher keeps its records per NAME --
``MASK_OCCUPANTS`` from the pre-spawn pass, ``_MASKED_NAMES`` from the loops --
and compares them against the filesystem by identity, so two names for one
object make those records disagree with what a name reaches. Every spawn
failure this layout has produced had that one shape.

This suite pins the two halves of the answer: the producers emit one spelling
per directory (the one the tier lists carry, so the occupant pass records
under a name the launcher looks up), and the launcher's own hiding region runs
to the end against the script those producers actually write for such a host,
with a bind that HIDES its target the way a real mount does.
"""

from __future__ import annotations

import ast
import ctypes
import os
import re
import runpy
import stat
import sys
import tempfile
import textwrap
from pathlib import Path

import pytest
from test_sandbox_mount_pinned_target import _CoveringLibc, _region

import kiro_crew.sandbox as sb
from kiro_crew import kiro_prerequisite as kp
from kiro_crew import platform_compat

pytestmark = pytest.mark.skipif(
    not platform_compat.IS_POSIX,
    reason="the launcher script and the symlinked home are POSIX mechanisms",
)


@pytest.fixture()
def symlinked_home(tmp_path, monkeypatch):
    """``$HOME`` is a link into the real tree; the data home sits under both spellings."""
    real_home = tmp_path / "mnt" / "home" / "u"
    data_home = real_home / ".kirocrew"
    for leaf in ("diag", "run", "apps/aws-control/data", "quarantined-clones"):
        (data_home / leaf).mkdir(parents=True)
    (data_home / ".env").write_text("SECRET=1\n")
    (tmp_path / "home").symlink_to(tmp_path / "mnt" / "home", target_is_directory=True)
    link_home = tmp_path / "home" / "u"
    assert link_home.is_dir() and not (link_home / ".kiro").exists()
    monkeypatch.setattr(sb.Path, "home", classmethod(lambda _cls: link_home))
    monkeypatch.setattr(sb, "config_dir", lambda: data_home)
    monkeypatch.setattr(sb, "_backend", "namespace")
    return link_home, data_home


def _lists(script: str) -> dict:
    def get(name: str):
        match = re.search(r"^%s *= *(.*)$" % re.escape(name), script, re.M)
        assert match, f"the launcher does not emit {name}"
        value = match.group(1)
        if value.startswith("frozenset("):
            value = value[len("frozenset(") : -1]
        return ast.literal_eval(value)

    return {
        name: get(name)
        for name in (
            "SENSITIVE_DIRS",
            "SENSITIVE_DIR_IDS",
            "PRIVATE_DIRS",
            "PRIVATE_DIR_IDS",
            "READONLY_DIRS",
            "WRITABLE_DIRS",
            "SENSITIVE_FILES",
            "REQUIRED_MASK_TARGETS",
            "FAIL_CLOSED_FILE_MASKS",
            "MASK_OCCUPANTS",
            "CREW_HOME_ALIASES",
        )
    }


def _probe_script(link_home: Path, data_home: Path) -> str:
    """The launcher the readiness probe writes for this host, through the real pass."""
    service = kp.KiroPrerequisiteService(
        platform_name="linux", home=link_home, data_home=data_home, environ={}
    )
    argv = sb.namespace_argv(
        ["/usr/bin/env", "kiro-cli", "--version"],
        "strict",
        extra_hidden_dirs=service._hidden_probe_dirs,
    )
    script_path = next(a for a in argv if a.endswith(".py") and "kirocrew_sandbox_" in a)
    try:
        return Path(script_path).read_text()
    finally:
        os.unlink(script_path)


def _identity(path: str) -> tuple[int, int] | None:
    try:
        info = os.stat(path)
    except OSError:
        return None
    return (info.st_dev, info.st_ino)


def test_the_probes_home_spellings_fold_onto_the_data_home(symlinked_home) -> None:
    """The probe names the data home three ways; the launcher receives it once."""
    link_home, data_home = symlinked_home
    service = kp.KiroPrerequisiteService(
        platform_name="linux", home=link_home, data_home=data_home, environ={}
    )
    assert str(link_home / ".kirocrew") in service._hidden_probe_dirs, "fixture drifted"
    dirs = _lists(_probe_script(link_home, data_home))["SENSITIVE_DIRS"]
    assert dirs.count(str(data_home)) == 1
    assert str(link_home / ".kirocrew") not in dirs


def test_a_relocated_home_is_still_listed_under_its_own_spelling(tmp_path, monkeypatch) -> None:
    """The identity check narrows the duplicate case only; a real relocation keeps its rule."""
    elsewhere = tmp_path / "srv" / "crew"
    (elsewhere / "diag").mkdir(parents=True)
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(sb.Path, "home", classmethod(lambda _cls: home))
    monkeypatch.setattr(sb, "config_dir", lambda: elsewhere)
    assert str(elsewhere / "diag") in sb._relocated_crew_targets(("diag",))


def test_the_launcher_is_handed_one_spelling_per_directory(symlinked_home) -> None:
    link_home, data_home = symlinked_home
    lists = _lists(_probe_script(link_home, data_home))

    seen: dict[tuple[int, int], str] = {}
    for name in lists["SENSITIVE_DIRS"]:
        ident = _identity(name)
        if ident is None:
            continue
        assert ident not in seen, f"{name} and {seen[ident]} are two names for one directory"
        seen[ident] = name
    # The resolved spelling is the canonical one: it is how the pre-spawn passes
    # already spell the leaves they record, and how ``.vault`` -- a tier entry with
    # no relocated twin -- is still masked after the fold.
    assert str(data_home / "diag") in lists["SENSITIVE_DIRS"]
    assert str(data_home / ".vault") in lists["SENSITIVE_DIRS"]
    assert not any(
        name.startswith(str(link_home / ".kirocrew")) for name in lists["SENSITIVE_DIRS"]
    )


def test_the_carried_leaf_identity_is_under_the_spelling_the_launcher_lists(
    symlinked_home,
) -> None:
    """The record and the list agree on the name, so the identity check runs for the leaf."""
    link_home, data_home = symlinked_home
    lists = _lists(_probe_script(link_home, data_home))
    leaf = str(data_home / "diag")
    assert leaf in lists["SENSITIVE_DIRS"]
    assert leaf in lists["MASK_OCCUPANTS"], "the crew leaf lost its carried identity"
    assert not any(
        name.startswith(str(link_home / ".kirocrew")) for name in lists["MASK_OCCUPANTS"]
    ), "an occupant was recorded under the alias spelling"


def _replay_namespace(link_home: Path, lists: dict, tmpfs: Path, libc: _CoveringLibc) -> dict:
    return {
        "_libc": libc,
        "_HARNESS_VERIFY": lambda name, stand_in, what: None,
        "_MS_BIND": 4096,
        "_MS_REC": 16384,
        "_MS_PRIVATE": 1 << 18,
        "_MS_RDONLY": 1,
        "_MS_REMOUNT": 32,
        "_MS_NOSUID": 2,
        "_MS_NODEV": 4,
        "_MS_NOEXEC": 8,
        "_MNT_DETACH": 2,
        "ctypes": ctypes,
        "os": os,
        "stat": stat,
        "sys": sys,
        "tempfile": tempfile,
        "_tmpfs_src": str(tmpfs),
        "_src_prefix": "kirocrew_sb_%d_" % os.getpid(),
        "expose_data": {},
        "EXPOSE_FILES": [],
        "REQUIRED_MASK_TARGETS": frozenset(lists["REQUIRED_MASK_TARGETS"]),
        "SSH_DIR": str(link_home / ".ssh"),
        "SSH_KNOWN_HOSTS": str(link_home / ".ssh" / "known_hosts"),
        "HIDE_SSH": True,
        **{k: v for k, v in lists.items() if k != "REQUIRED_MASK_TARGETS"},
    }


def _replay(script: str, namespace: dict, tmp_path: Path) -> dict:
    region_file = tmp_path / "region.py"
    region_file.write_text(_region(script))
    return runpy.run_path(str(region_file), init_globals=namespace)


def test_the_hiding_region_runs_to_the_end_on_a_symlinked_home(symlinked_home, tmp_path) -> None:
    """The script the producers write for this host, replayed with a covering bind."""
    link_home, data_home = symlinked_home
    (link_home / ".ssh").mkdir()
    (link_home / ".ssh" / "known_hosts").write_text("example.com ssh-rsa AAAA\n")
    (link_home / ".kiro" / "agents").mkdir(parents=True)
    script = _probe_script(link_home, data_home)
    lists = _lists(script)
    tmpfs = tmp_path / "tmpfs"
    tmpfs.mkdir()
    libc = _CoveringLibc()
    try:
        result = _replay(script, _replay_namespace(link_home, lists, tmpfs, libc), tmp_path)
    except SystemExit as exc:
        pytest.fail(f"the launcher refused on a symlinked home: {exc.code}")
    assert libc.covered.count(str(data_home)) == 1, "the data home was masked more than once"
    assert not (data_home / "diag").exists(), "the stand-in is not empty"
    for name, stand_in_id in result["_MASKED_NAMES"].items():
        assert stand_in_id in result["_OWN_STAND_INS"], name


def test_the_folded_alias_travels_with_the_identity_it_rested_on(symlinked_home) -> None:
    link_home, data_home = symlinked_home
    aliases = _lists(_probe_script(link_home, data_home))["CREW_HOME_ALIASES"]
    info = os.stat(data_home)
    assert [str(link_home / ".kirocrew"), str(data_home), info.st_dev, info.st_ino] in aliases
    # ``.kiro/crew`` is absent on this host, so it is no alias and keeps its own rules.
    assert not any(alias.endswith(".kiro/crew") for alias, *_ in aliases)


def test_a_plain_home_folds_nothing(tmp_path, monkeypatch) -> None:
    home = tmp_path / "home"
    (home / ".kirocrew").mkdir(parents=True)
    monkeypatch.setattr(sb.Path, "home", classmethod(lambda _cls: home))
    monkeypatch.setattr(sb, "config_dir", lambda: home / ".kirocrew")
    assert sb._crew_home_alias_roots() == ()


_ALIAS_START = "        # A crew-home alias is a ``$HOME`` spelling the producer folded onto the"
_ALIAS_END = "        # Pre-read files that must survive dir hiding."


def _alias_check(script: str) -> str:
    """The launcher's alias re-read, lifted from the script as the loop harness lifts the loops."""
    a = script.rindex("\n", 0, script.index(_ALIAS_START)) + 1
    b = script.rindex("\n", 0, script.index(_ALIAS_END, a)) + 1
    return textwrap.dedent(script[a:b])


def test_an_alias_re_aimed_after_the_fold_refuses_before_any_mask(symlinked_home, tmp_path) -> None:
    """The fold is decided in the producer and acted on in the child; the link in between is a name.

    A writer re-aims the home link after the producer looked and before the child
    mounts. The alias spelling then reaches another directory, one no folded rule
    covers. The child reads the alias again, ahead of every hiding mount, and
    refuses the spawn. The same block passes while the link still holds.
    """
    link_home, data_home = symlinked_home
    script = _probe_script(link_home, data_home)
    lists = _lists(script)
    assert lists["CREW_HOME_ALIASES"], "the fixture produced no alias to re-aim"
    check = tmp_path / "alias_check.py"
    check.write_text(_alias_check(script))
    namespace = {"os": os, "sys": sys, "CREW_HOME_ALIASES": lists["CREW_HOME_ALIASES"]}

    runpy.run_path(str(check), init_globals=dict(namespace))  # the link holds: no refusal

    elsewhere = tmp_path / "elsewhere" / "home" / "u"
    (elsewhere / ".kirocrew").mkdir(parents=True)
    (elsewhere / ".kirocrew" / ".env").write_text("PLANTED=1\n")
    home_link = tmp_path / "home"
    home_link.unlink()
    home_link.symlink_to(tmp_path / "elsewhere" / "home", target_is_directory=True)
    assert not os.path.samefile(link_home / ".kirocrew", data_home)

    with pytest.raises(SystemExit) as refused:
        runpy.run_path(str(check), init_globals=dict(namespace))
    assert "reaches a different directory now" in str(refused.value.code)


def test_the_alias_re_read_runs_ahead_of_every_hiding_mount() -> None:
    """Ordering is the guarantee: the re-read sits before the first mask the loops place."""
    script = sb._build_launcher_script("strict")
    assert script.index(_ALIAS_START) < script.index(_ALIAS_END)
    assert script.index(_ALIAS_START) > script.index("def _mount_or_die(")

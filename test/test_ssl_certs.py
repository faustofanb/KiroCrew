"""Tests for _ssl_compat SSL certificate bootstrap."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from conftest import forget_env_at_teardown
from kiro_crew import _ssl_compat
from kiro_crew._ssl_compat import _CA_CANDIDATES, _EXPORTED_BUNDLE_ENV, _ensure_ssl_certs


@pytest.fixture(autouse=True)
def _reset_ssl_bootstrap(monkeypatch):
    """Keep tests independent and file-bootstrap cases platform-neutral."""
    monkeypatch.setattr(_ssl_compat, "_TRUSTSTORE_INJECTED", False)
    monkeypatch.setattr(sys, "platform", "linux")
    # _ensure_ssl_certs() WRITES these three variables. A plain delenv(raising=False)
    # on a key that is absent records no undo, so the value the code exports would
    # outlive the test and pre-empt every later bootstrap on this worker.
    forget_env_at_teardown(monkeypatch, "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", _EXPORTED_BUNDLE_ENV)


class TestEnsureSslCerts:
    """Tests for _ensure_ssl_certs()."""

    def test_noop_when_ssl_cert_file_already_set(self, monkeypatch):
        """Should return immediately if SSL_CERT_FILE is already set."""
        monkeypatch.setenv("SSL_CERT_FILE", "/custom/ca.pem")
        monkeypatch.delenv("REQUESTS_CA_BUNDLE", raising=False)

        _ensure_ssl_certs()

        import os

        assert os.environ["SSL_CERT_FILE"] == "/custom/ca.pem"
        assert os.environ.get("REQUESTS_CA_BUNDLE") is None

    def test_noop_when_default_cafile_exists(self, monkeypatch, tmp_path):
        """Should return if ssl.get_default_verify_paths().cafile exists."""
        monkeypatch.delenv("SSL_CERT_FILE", raising=False)
        monkeypatch.delenv("REQUESTS_CA_BUNDLE", raising=False)

        ca_file = tmp_path / "system-ca.pem"
        ca_file.write_text("fake cert bundle")

        mock_paths = type("P", (), {"cafile": str(ca_file), "capath": None})()
        with patch("ssl.get_default_verify_paths", return_value=mock_paths):
            _ensure_ssl_certs()

        import os

        assert os.environ.get("SSL_CERT_FILE") is None

    def test_sets_env_from_first_existing_candidate(self, monkeypatch, tmp_path):
        """Should set SSL_CERT_FILE and REQUESTS_CA_BUNDLE from the first candidate found."""
        monkeypatch.delenv("SSL_CERT_FILE", raising=False)
        monkeypatch.delenv("REQUESTS_CA_BUNDLE", raising=False)

        # Simulate: cafile is None (no default bundle)
        mock_paths = type("P", (), {"cafile": None, "capath": None})()

        # Make the second candidate exist
        fake_bundle = tmp_path / "ca-bundle.crt"
        fake_bundle.write_text("fake cert bundle")

        candidates = (
            "/nonexistent/cert.pem",
            str(fake_bundle),
            "/also/nonexistent.crt",
        )

        with (
            patch("ssl.get_default_verify_paths", return_value=mock_paths),
            patch("kiro_crew._ssl_compat._CA_CANDIDATES", candidates),
        ):
            _ensure_ssl_certs()

        import os

        assert os.environ["SSL_CERT_FILE"] == str(fake_bundle)
        assert os.environ["REQUESTS_CA_BUNDLE"] == str(fake_bundle)

    def test_does_not_overwrite_existing_requests_ca_bundle(self, monkeypatch, tmp_path):
        """REQUESTS_CA_BUNDLE should not be overwritten if already set."""
        monkeypatch.delenv("SSL_CERT_FILE", raising=False)
        monkeypatch.setenv("REQUESTS_CA_BUNDLE", "/existing/bundle.crt")

        mock_paths = type("P", (), {"cafile": None, "capath": None})()

        fake_bundle = tmp_path / "cert.pem"
        fake_bundle.write_text("fake cert bundle")
        candidates = (str(fake_bundle),)

        with (
            patch("ssl.get_default_verify_paths", return_value=mock_paths),
            patch("kiro_crew._ssl_compat._CA_CANDIDATES", candidates),
        ):
            _ensure_ssl_certs()

        import os

        assert os.environ["SSL_CERT_FILE"] == str(fake_bundle)
        assert os.environ["REQUESTS_CA_BUNDLE"] == "/existing/bundle.crt"

    def test_no_env_set_when_no_candidate_exists(self, monkeypatch):
        """Should leave env vars unset if no candidate file exists and certifi is unavailable."""
        monkeypatch.delenv("SSL_CERT_FILE", raising=False)
        monkeypatch.delenv("REQUESTS_CA_BUNDLE", raising=False)

        mock_paths = type("P", (), {"cafile": None, "capath": None})()
        candidates = ("/nonexistent/a.pem", "/nonexistent/b.crt")

        with (
            patch("ssl.get_default_verify_paths", return_value=mock_paths),
            patch("kiro_crew._ssl_compat._CA_CANDIDATES", candidates),
            patch.dict("sys.modules", {"certifi": None}),
        ):
            _ensure_ssl_certs()

        import os

        assert os.environ.get("SSL_CERT_FILE") is None
        assert os.environ.get("REQUESTS_CA_BUNDLE") is None

    def test_falls_back_to_certifi_when_no_system_path_exists(self, monkeypatch, tmp_path):
        """macOS has none of the Linux system paths — should fall back to certifi's bundle."""
        monkeypatch.delenv("SSL_CERT_FILE", raising=False)
        monkeypatch.delenv("REQUESTS_CA_BUNDLE", raising=False)

        mock_paths = type("P", (), {"cafile": None, "capath": None})()
        candidates = ("/nonexistent/a.pem", "/nonexistent/b.crt")

        fake_certifi_bundle = tmp_path / "certifi-cacert.pem"
        fake_certifi_bundle.write_text("fake certifi bundle")
        mock_certifi = type("M", (), {"where": staticmethod(lambda: str(fake_certifi_bundle))})()

        with (
            patch("ssl.get_default_verify_paths", return_value=mock_paths),
            patch("kiro_crew._ssl_compat._CA_CANDIDATES", candidates),
            patch.dict("sys.modules", {"certifi": mock_certifi}),
        ):
            _ensure_ssl_certs()

        import os

        assert os.environ["SSL_CERT_FILE"] == str(fake_certifi_bundle)
        assert os.environ["REQUESTS_CA_BUNDLE"] == str(fake_certifi_bundle)

    def test_win32_exports_nothing_even_when_a_bundle_is_discoverable(self, monkeypatch, tmp_path):
        """win32 must export NEITHER variable, however findable a bundle is.

        The mirror of ``test_falls_back_to_certifi_when_no_system_path_exists``:
        identical setup, only the platform differs, opposite outcome.  Every
        bundle discovery below the guard is made to succeed -- a candidate path
        exists AND certifi resolves -- so this pins that the return sits ABOVE
        the discovery block rather than merely that certifi is not reached.  A
        future edit that moves the guard down, or adds a Windows-shaped path to
        ``_CA_CANDIDATES``, fails here.

        Why nothing may be exported: for ``rustls-native-certs``, which the
        kiro-cli child uses, ``SSL_CERT_FILE`` REPLACES the platform store
        rather than adding to it, and anything discovered here is a
        public-roots-only bundle.  Exporting one therefore SUBTRACTS every
        private CA the Windows ROOT store holds, breaking the child on any host
        behind TLS inspection while this process -- CPython reads the variable
        additively -- keeps working and hides it.
        """
        monkeypatch.setattr(sys, "platform", "win32")
        monkeypatch.delenv("SSL_CERT_FILE", raising=False)
        monkeypatch.delenv("REQUESTS_CA_BUNDLE", raising=False)

        mock_paths = type("P", (), {"cafile": None, "capath": None})()

        existing_candidate = tmp_path / "ca-bundle.crt"
        existing_candidate.write_text("fake cert bundle")

        fake_certifi_bundle = tmp_path / "certifi-cacert.pem"
        fake_certifi_bundle.write_text("fake certifi bundle")
        mock_certifi = type("M", (), {"where": staticmethod(lambda: str(fake_certifi_bundle))})()

        with (
            patch("ssl.get_default_verify_paths", return_value=mock_paths),
            patch("kiro_crew._ssl_compat._CA_CANDIDATES", (str(existing_candidate),)),
            patch.dict("sys.modules", {"certifi": mock_certifi}),
        ):
            _ensure_ssl_certs()

        import os

        assert os.environ.get("SSL_CERT_FILE") is None
        assert os.environ.get("REQUESTS_CA_BUNDLE") is None

    def test_win32_still_honours_an_explicit_ssl_cert_file(self, monkeypatch):
        """An operator's own bundle outranks the win32 guard and survives it.

        The guard is placed BELOW the explicit-override check on purpose:
        exporting a public-roots bundle is what breaks the child, but an
        operator naming their own bundle is the supported way to add a private
        CA on a host whose store this process cannot read.  That escape hatch is
        the current workaround for affected users, so it must not regress.
        """
        monkeypatch.setattr(sys, "platform", "win32")
        monkeypatch.setenv("SSL_CERT_FILE", r"C:\corp\ca-bundle.pem")
        monkeypatch.delenv("REQUESTS_CA_BUNDLE", raising=False)

        _ensure_ssl_certs()

        import os

        assert os.environ["SSL_CERT_FILE"] == r"C:\corp\ca-bundle.pem"
        assert os.environ.get("REQUESTS_CA_BUNDLE") is None

    def test_cafile_missing_on_disk_falls_through(self, monkeypatch, tmp_path):
        """If cafile is set but the file doesn't exist, should fall through to candidates."""
        monkeypatch.delenv("SSL_CERT_FILE", raising=False)
        monkeypatch.delenv("REQUESTS_CA_BUNDLE", raising=False)

        # cafile points to a nonexistent path
        mock_paths = type("P", (), {"cafile": "/ghost/cert.pem", "capath": None})()

        fake_bundle = tmp_path / "ca-bundle.crt"
        fake_bundle.write_text("fake cert bundle")
        candidates = (str(fake_bundle),)

        with (
            patch("ssl.get_default_verify_paths", return_value=mock_paths),
            patch("kiro_crew._ssl_compat._CA_CANDIDATES", candidates),
        ):
            _ensure_ssl_certs()

        import os

        assert os.environ["SSL_CERT_FILE"] == str(fake_bundle)

    def test_candidates_match_expected_paths(self):
        """Verify the candidate list covers AL2 and Debian/Ubuntu paths."""
        assert "/etc/pki/tls/cert.pem" in _CA_CANDIDATES
        assert "/etc/pki/tls/certs/ca-bundle.crt" in _CA_CANDIDATES
        assert "/etc/ssl/certs/ca-certificates.crt" in _CA_CANDIDATES

    def test_cli_invokes_ensure_ssl_certs(self):
        """Reloading cli.py must trigger _ensure_ssl_certs()."""
        import importlib
        from unittest.mock import MagicMock
        from unittest.mock import patch as _patch

        mock_fn = MagicMock()
        with _patch("kiro_crew._ssl_compat._ensure_ssl_certs", mock_fn):
            import kiro_crew.cli

            importlib.reload(kiro_crew.cli)
        mock_fn.assert_called()

    def test_macos_injects_system_trust(self, monkeypatch, tmp_path):
        """macOS should delegate TLS validation to Security.framework."""
        monkeypatch.setattr(sys, "platform", "darwin")
        monkeypatch.delenv("SSL_CERT_FILE", raising=False)
        inject = MagicMock()
        mock_truststore = type("Truststore", (), {"inject_into_ssl": inject})()
        ca_file = tmp_path / "system-ca.pem"
        ca_file.write_text("fake cert bundle")
        mock_paths = type("P", (), {"cafile": str(ca_file), "capath": None})()

        with (
            patch.object(_ssl_compat, "truststore", mock_truststore),
            patch("ssl.get_default_verify_paths", return_value=mock_paths),
        ):
            _ensure_ssl_certs()

        inject.assert_called_once_with()
        assert _ssl_compat._TRUSTSTORE_INJECTED is True

    def test_macos_explicit_bundle_wins(self, monkeypatch):
        """An operator-supplied SSL_CERT_FILE must bypass system injection."""
        monkeypatch.setattr(sys, "platform", "darwin")
        monkeypatch.setenv("SSL_CERT_FILE", "/operator/ca.pem")
        inject = MagicMock()
        mock_truststore = type("Truststore", (), {"inject_into_ssl": inject})()

        with patch.object(_ssl_compat, "truststore", mock_truststore):
            _ensure_ssl_certs()

        inject.assert_not_called()
        assert _ssl_compat._TRUSTSTORE_INJECTED is False

    def test_macos_injection_is_idempotent(self, monkeypatch, tmp_path):
        """Both application entry points may call the prelude in one process."""
        monkeypatch.setattr(sys, "platform", "darwin")
        monkeypatch.delenv("SSL_CERT_FILE", raising=False)
        inject = MagicMock()
        mock_truststore = type("Truststore", (), {"inject_into_ssl": inject})()
        ca_file = tmp_path / "system-ca.pem"
        ca_file.write_text("fake cert bundle")
        mock_paths = type("P", (), {"cafile": str(ca_file), "capath": None})()

        with (
            patch.object(_ssl_compat, "truststore", mock_truststore),
            patch("ssl.get_default_verify_paths", return_value=mock_paths),
        ):
            _ensure_ssl_certs()
            _ensure_ssl_certs()

        inject.assert_called_once_with()

    def test_macos_injection_still_exports_child_env(self, monkeypatch, tmp_path):
        """Injection covers this process only; children still need the env vars.

        MCP subprocesses (kiro-cli, Node servers) inherit ``os.environ`` and
        cannot inherit a process-local monkey-patch, so a successful macOS
        injection must not short-circuit the file-based export they rely on.
        """
        monkeypatch.setattr(sys, "platform", "darwin")
        monkeypatch.delenv("SSL_CERT_FILE", raising=False)
        monkeypatch.delenv("REQUESTS_CA_BUNDLE", raising=False)
        inject = MagicMock()
        mock_truststore = type("Truststore", (), {"inject_into_ssl": inject})()

        mock_paths = type("P", (), {"cafile": None, "capath": None})()
        fake_certifi_bundle = tmp_path / "certifi-cacert.pem"
        fake_certifi_bundle.write_text("fake certifi bundle")
        mock_certifi = type("M", (), {"where": staticmethod(lambda: str(fake_certifi_bundle))})()

        with (
            patch.object(_ssl_compat, "truststore", mock_truststore),
            patch.dict(sys.modules, {"certifi": mock_certifi}),
            patch("ssl.get_default_verify_paths", return_value=mock_paths),
            patch("kiro_crew._ssl_compat._CA_CANDIDATES", ("/nonexistent/a.pem",)),
        ):
            _ensure_ssl_certs()

        import os

        inject.assert_called_once_with()
        assert os.environ["SSL_CERT_FILE"] == str(fake_certifi_bundle)
        assert os.environ["REQUESTS_CA_BUNDLE"] == str(fake_certifi_bundle)

    def test_macos_injection_failure_falls_back(self, monkeypatch, tmp_path, caplog):
        """A system-trust failure must not prevent the prior CA bootstrap."""
        monkeypatch.setattr(sys, "platform", "darwin")
        monkeypatch.delenv("SSL_CERT_FILE", raising=False)
        ca_file = tmp_path / "fallback-ca.pem"
        ca_file.write_text("fake cert bundle")
        mock_paths = type("P", (), {"cafile": str(ca_file), "capath": None})()
        inject = MagicMock(side_effect=RuntimeError("unavailable"))
        mock_truststore = type("Truststore", (), {"inject_into_ssl": inject})()

        with (
            patch.object(_ssl_compat, "truststore", mock_truststore),
            patch("ssl.get_default_verify_paths", return_value=mock_paths),
            caplog.at_level("WARNING", logger="kiro_crew._ssl_compat"),
        ):
            _ensure_ssl_certs()

        inject.assert_called_once_with()
        assert _ssl_compat._TRUSTSTORE_INJECTED is False
        assert "falling back" in caplog.text

        import os

        assert os.environ.get("SSL_CERT_FILE") is None

    def test_macos_missing_truststore_falls_back(self, monkeypatch, tmp_path, caplog):
        """An absent truststore package degrades to file discovery, not a crash."""
        monkeypatch.setattr(sys, "platform", "darwin")
        monkeypatch.delenv("SSL_CERT_FILE", raising=False)
        ca_file = tmp_path / "fallback-ca.pem"
        ca_file.write_text("fake cert bundle")
        mock_paths = type("P", (), {"cafile": str(ca_file), "capath": None})()

        with (
            patch.object(_ssl_compat, "truststore", None),
            patch("ssl.get_default_verify_paths", return_value=mock_paths),
            caplog.at_level("WARNING", logger="kiro_crew._ssl_compat"),
        ):
            _ensure_ssl_certs()

        assert _ssl_compat._TRUSTSTORE_INJECTED is False
        assert "falling back" in caplog.text

    def test_gatewayd_invokes_ensure_ssl_certs(self):
        """The separate gateway process must install process-local trust."""
        import importlib

        mock_fn = MagicMock()
        with patch("kiro_crew._ssl_compat._ensure_ssl_certs", mock_fn):
            import kiro_crew.mcp_gateway.gatewayd

            importlib.reload(kiro_crew.mcp_gateway.gatewayd)
        mock_fn.assert_called()

    def test_context_trust_uses_openssl_ca_count(self, monkeypatch):
        """Regular OpenSSL contexts retain the concrete CA-count check."""
        context = MagicMock()
        context.cert_store_stats.return_value = {"x509_ca": 1}

        assert _ssl_compat._ssl_context_has_ca_trust(context) is True
        context.cert_store_stats.assert_called_once_with()

    def test_context_trust_accepts_injected_dynamic_store(self, monkeypatch):
        """Security.framework trust is valid even though it cannot list CAs."""
        monkeypatch.setattr(_ssl_compat, "_TRUSTSTORE_INJECTED", True)
        context = MagicMock()
        context.cert_store_stats.side_effect = NotImplementedError

        assert _ssl_compat._ssl_context_has_ca_trust(context) is True


def _install_bundle(root: Path, install: str) -> Path:
    """The certifi bundle path of a Kiro Crew install rooted at *root*/*install*.

    The shape every pip, venv and desktop-bundle install shares:
    ``<prefix>/lib/pythonX.Y/site-packages/certifi/cacert.pem``. Built from the
    test's own ``tmp_path`` so the path is native on every CI platform.
    """
    return root / install / "lib" / "python3.12" / "site-packages" / "certifi" / "cacert.pem"


def _no_system_bundle():
    """Patches that make the host look like one with no system CA bundle.

    The macOS desktop bundle and standalone/source installs: ``ssl`` reports no
    default cafile and none of the Linux candidate paths exist, so the
    derivation falls through to certifi -- the only branch that exports an
    install-pinned path.
    """
    mock_paths = type("P", (), {"cafile": None, "capath": None})()
    return (
        patch("ssl.get_default_verify_paths", return_value=mock_paths),
        patch("kiro_crew._ssl_compat._CA_CANDIDATES", ("/nonexistent/a.pem", "/nonexistent/b.crt")),
    )


def _certifi_at(bundle) -> object:
    """A stand-in ``certifi`` module whose ``where()`` names *bundle*."""
    return type("M", (), {"where": staticmethod(lambda: str(bundle))})()


def _inherited_lines(caplog) -> list:
    return [
        r for r in caplog.records if "inherited from another Kiro Crew process" in r.getMessage()
    ]


class TestInheritedInstallPinnedBundle:
    """An in-app restart successor must resolve its OWN CA bundle.

    ``_ensure_ssl_certs`` exports ``SSL_CERT_FILE`` / ``REQUESTS_CA_BUNDLE`` set
    to ``certifi.where()`` when the host has no system bundle -- a path inside
    the running install's site-packages.  The restart successors (``os.execve``
    in ``_process_group_supervisor``, ``os.execv`` in ``_spawn_exec_shim``)
    inherit that environment.  Without the rule under test the successor's own
    bootstrap sees the predecessor's value, takes the operator-override early
    return, and keeps pointing at the PREVIOUS install's bundle; once an
    upgrade prunes that tree every TLS handshake fails until a restart from a
    clean environment.

    The rule: a value the runtime exported -- known by the provenance it
    publishes beside the export, or, for a predecessor that published none, by
    an install-shaped path whose file is gone -- is re-derived for this
    install.  An operator's value, including a certifi bundle they chose
    themselves, is never touched.
    """

    def test_restart_after_an_upgrade_re_derives_the_pruned_predecessor_bundle(
        self, monkeypatch, tmp_path, caplog
    ):
        """Two bootstraps, the first run's environment carried into the second.

        Run 1 is the predecessor on install ``v1``: no system bundle, so it
        exports its own certifi path and its provenance.  The upgrade then
        prunes ``v1`` and the successor on ``v2`` re-enters the bootstrap
        holding ``v1``'s environment.  It must end up with ``v2``'s bundle in
        BOTH variables, not a pointer to a deleted file, and say so once at a
        level the unconfigured prelude logger actually emits.
        """
        monkeypatch.delenv("SSL_CERT_FILE", raising=False)
        monkeypatch.delenv("REQUESTS_CA_BUNDLE", raising=False)
        old_bundle = _install_bundle(tmp_path, "v1")
        old_bundle.parent.mkdir(parents=True)
        old_bundle.write_text("v1 certifi bundle")
        new_bundle = _install_bundle(tmp_path, "v2")
        new_bundle.parent.mkdir(parents=True)
        new_bundle.write_text("v2 certifi bundle")
        no_cafile, no_candidates = _no_system_bundle()

        with (
            no_cafile,
            no_candidates,
            patch.dict("sys.modules", {"certifi": _certifi_at(old_bundle)}),
        ):
            _ensure_ssl_certs()

        import os

        assert os.environ["SSL_CERT_FILE"] == str(old_bundle)
        assert os.environ["REQUESTS_CA_BUNDLE"] == str(old_bundle)
        assert os.environ[_EXPORTED_BUNDLE_ENV] == str(old_bundle)

        old_bundle.unlink()  # the upgrade pruned the predecessor's install tree
        with (
            no_cafile,
            no_candidates,
            patch.dict("sys.modules", {"certifi": _certifi_at(new_bundle)}),
            caplog.at_level("INFO", logger="kiro_crew._ssl_compat"),
        ):
            _ensure_ssl_certs()

        assert os.environ["SSL_CERT_FILE"] == str(new_bundle)
        assert os.environ["REQUESTS_CA_BUNDLE"] == str(new_bundle)
        assert os.environ[_EXPORTED_BUNDLE_ENV] == str(new_bundle)
        lines = _inherited_lines(caplog)
        assert len(lines) == 1, caplog.text
        assert lines[0].levelname == "WARNING"
        assert str(old_bundle) in lines[0].getMessage()

    def test_predecessor_bundle_that_still_exists_is_still_re_derived(self, monkeypatch, tmp_path):
        """A still-present predecessor bundle is not a reason to keep pointing at it.

        An installer that keeps the last two versions leaves exactly this behind,
        and the NEXT upgrade prunes it under a successor that is still running.
        The provenance the predecessor published is what identifies the value as
        the runtime's; the file's presence does not make it an operator's.
        """
        old_bundle = _install_bundle(tmp_path, "v1")
        old_bundle.parent.mkdir(parents=True)
        old_bundle.write_text("v1 certifi bundle")
        new_bundle = _install_bundle(tmp_path, "v2")
        new_bundle.parent.mkdir(parents=True)
        new_bundle.write_text("v2 certifi bundle")
        monkeypatch.setenv("SSL_CERT_FILE", str(old_bundle))
        monkeypatch.setenv("REQUESTS_CA_BUNDLE", str(old_bundle))
        monkeypatch.setenv(_EXPORTED_BUNDLE_ENV, str(old_bundle))
        no_cafile, no_candidates = _no_system_bundle()

        with (
            no_cafile,
            no_candidates,
            patch.dict("sys.modules", {"certifi": _certifi_at(new_bundle)}),
        ):
            _ensure_ssl_certs()

        import os

        assert os.environ["SSL_CERT_FILE"] == str(new_bundle)
        assert os.environ["REQUESTS_CA_BUNDLE"] == str(new_bundle)
        assert old_bundle.exists()  # the file was never the question

    def test_pruned_install_bundle_without_provenance_is_re_derived(
        self, monkeypatch, tmp_path, caplog
    ):
        """The bridge: a predecessor from before the provenance existed.

        Its export carries no ``KIROCREW_EXPORTED_CA_BUNDLE``, so the shape plus
        the missing file is all the successor has -- and a pointer to a file
        that is gone is nobody's working policy, so re-deriving it erases none.
        """
        old_bundle = _install_bundle(tmp_path, "v1")  # never created: pruned
        new_bundle = _install_bundle(tmp_path, "v2")
        new_bundle.parent.mkdir(parents=True)
        new_bundle.write_text("v2 certifi bundle")
        monkeypatch.setenv("SSL_CERT_FILE", str(old_bundle))
        monkeypatch.setenv("REQUESTS_CA_BUNDLE", str(old_bundle))
        monkeypatch.delenv(_EXPORTED_BUNDLE_ENV, raising=False)
        no_cafile, no_candidates = _no_system_bundle()

        with (
            no_cafile,
            no_candidates,
            patch.dict("sys.modules", {"certifi": _certifi_at(new_bundle)}),
            caplog.at_level("INFO", logger="kiro_crew._ssl_compat"),
        ):
            _ensure_ssl_certs()

        import os

        assert os.environ["SSL_CERT_FILE"] == str(new_bundle)
        assert os.environ["REQUESTS_CA_BUNDLE"] == str(new_bundle)
        assert len(_inherited_lines(caplog)) == 1, caplog.text

    def test_runtime_export_yields_to_a_system_bundle(self, monkeypatch, tmp_path):
        """Re-deriving means the clean-start order: the system bundle wins over certifi.

        A successor on a host whose ``ssl`` default cafile exists exports
        nothing on a clean start, so the inherited export is dropped rather
        than replaced, its provenance with it, and the operator's own
        ``REQUESTS_CA_BUNDLE`` beside it is left exactly as they set it.
        """
        old_bundle = _install_bundle(tmp_path, "v1")
        monkeypatch.setenv("SSL_CERT_FILE", str(old_bundle))
        monkeypatch.setenv(_EXPORTED_BUNDLE_ENV, str(old_bundle))
        monkeypatch.setenv("REQUESTS_CA_BUNDLE", str(tmp_path / "corp" / "ca-bundle.pem"))
        ca_file = tmp_path / "system-ca.pem"
        ca_file.write_text("fake cert bundle")
        mock_paths = type("P", (), {"cafile": str(ca_file), "capath": None})()

        with patch("ssl.get_default_verify_paths", return_value=mock_paths):
            _ensure_ssl_certs()

        import os

        assert os.environ.get("SSL_CERT_FILE") is None
        assert os.environ.get(_EXPORTED_BUNDLE_ENV) is None
        assert os.environ["REQUESTS_CA_BUNDLE"] == str(tmp_path / "corp" / "ca-bundle.pem")

    def test_operator_certifi_bundle_on_macos_keeps_its_exclusion(
        self, monkeypatch, tmp_path, caplog
    ):
        """An operator's own certifi pin is a policy, not a leaked export.

        ``SSL_CERT_FILE=$(python -m certifi)`` is install-shaped and the file
        exists, and on macOS it is also an EXCLUSION: an explicit bundle bypasses
        the Security.framework injection, so the Keychain's CAs are not trusted.
        Re-deriving over it would trust a CA the operator chose to exclude.  It
        carries no provenance, so it is theirs: untouched, no injection, no
        export, nothing logged.
        """
        monkeypatch.setattr(sys, "platform", "darwin")
        pinned = _install_bundle(tmp_path, "operators-python")
        pinned.parent.mkdir(parents=True)
        pinned.write_text("the operator's certifi bundle")
        monkeypatch.setenv("SSL_CERT_FILE", str(pinned))
        monkeypatch.delenv("REQUESTS_CA_BUNDLE", raising=False)
        monkeypatch.delenv(_EXPORTED_BUNDLE_ENV, raising=False)
        inject = MagicMock()
        mock_truststore = type("Truststore", (), {"inject_into_ssl": inject})()
        own_bundle = _install_bundle(tmp_path, "kiro-crew")
        own_bundle.parent.mkdir(parents=True)
        own_bundle.write_text("this install's certifi bundle")
        no_cafile, no_candidates = _no_system_bundle()

        with (
            patch.object(_ssl_compat, "truststore", mock_truststore),
            no_cafile,
            no_candidates,
            patch.dict("sys.modules", {"certifi": _certifi_at(own_bundle)}),
            caplog.at_level("INFO", logger="kiro_crew._ssl_compat"),
        ):
            _ensure_ssl_certs()

        import os

        inject.assert_not_called()
        assert os.environ["SSL_CERT_FILE"] == str(pinned)
        assert os.environ.get("REQUESTS_CA_BUNDLE") is None
        assert os.environ.get(_EXPORTED_BUNDLE_ENV) is None
        assert caplog.records == []

    def test_operator_bundle_not_install_shaped_is_untouched(self, monkeypatch, tmp_path, caplog):
        """An operator's own bundle keeps its highest-precedence behaviour, byte for byte.

        A corporate CA file is not shaped like any install's certifi bundle and
        carries no provenance, so the early return stands: nothing is exported,
        nothing is re-derived, and nothing is logged.
        """
        corp_bundle = tmp_path / "corp" / "ca-bundle.pem"
        corp_bundle.parent.mkdir()
        corp_bundle.write_text("corporate roots")
        monkeypatch.setenv("SSL_CERT_FILE", str(corp_bundle))
        monkeypatch.delenv("REQUESTS_CA_BUNDLE", raising=False)
        new_bundle = _install_bundle(tmp_path, "v2")
        new_bundle.parent.mkdir(parents=True)
        new_bundle.write_text("v2 certifi bundle")
        no_cafile, no_candidates = _no_system_bundle()

        with (
            no_cafile,
            no_candidates,
            patch.dict("sys.modules", {"certifi": _certifi_at(new_bundle)}),
            caplog.at_level("INFO", logger="kiro_crew._ssl_compat"),
        ):
            _ensure_ssl_certs()

        import os

        assert os.environ["SSL_CERT_FILE"] == str(corp_bundle)
        assert os.environ.get("REQUESTS_CA_BUNDLE") is None
        assert caplog.records == []

    def test_operator_bundle_that_is_missing_is_respected_with_one_warning(
        self, monkeypatch, tmp_path, caplog
    ):
        """A missing operator file is still theirs to fix: respected, warned once."""
        missing = tmp_path / "corp" / "gone.pem"
        monkeypatch.setenv("SSL_CERT_FILE", str(missing))
        monkeypatch.delenv("REQUESTS_CA_BUNDLE", raising=False)

        with caplog.at_level("WARNING", logger="kiro_crew._ssl_compat"):
            _ensure_ssl_certs()

        import os

        assert os.environ["SSL_CERT_FILE"] == str(missing)
        assert os.environ.get("REQUESTS_CA_BUNDLE") is None
        warnings = [r for r in caplog.records if r.levelname == "WARNING"]
        assert len(warnings) == 1, caplog.text
        assert str(missing) in warnings[0].getMessage()
        assert _inherited_lines(caplog) == []

    def test_stale_requests_bundle_beside_an_operator_ssl_cert_file_is_dropped(
        self, monkeypatch, tmp_path, caplog
    ):
        """The runtime's ``REQUESTS_CA_BUNDLE`` does not survive behind an operator's ``SSL_CERT_FILE``.

        Each variable is judged on its own and the runtime's values are dropped
        BEFORE the operator check, so the operator's bundle is honoured exactly
        as before while ``requests`` falls back to its own certifi instead of a
        pruned file.
        """
        corp_bundle = tmp_path / "corp" / "ca-bundle.pem"
        corp_bundle.parent.mkdir()
        corp_bundle.write_text("corporate roots")
        stale = _install_bundle(tmp_path, "v1")
        monkeypatch.setenv("SSL_CERT_FILE", str(corp_bundle))
        monkeypatch.setenv("REQUESTS_CA_BUNDLE", str(stale))
        monkeypatch.setenv(_EXPORTED_BUNDLE_ENV, str(stale))

        with caplog.at_level("INFO", logger="kiro_crew._ssl_compat"):
            _ensure_ssl_certs()

        import os

        assert os.environ["SSL_CERT_FILE"] == str(corp_bundle)
        assert os.environ.get("REQUESTS_CA_BUNDLE") is None
        assert os.environ.get(_EXPORTED_BUNDLE_ENV) is None
        lines = _inherited_lines(caplog)
        assert len(lines) == 1, caplog.text
        assert "REQUESTS_CA_BUNDLE" in lines[0].getMessage()
        assert "SSL_CERT_FILE=" not in lines[0].getMessage()

    def test_own_export_seen_again_in_the_same_process_is_kept_silently(
        self, monkeypatch, tmp_path, caplog
    ):
        """Both entry points may run the prelude in one process; the second sees the first's export.

        The value is this install's own, so re-deriving reproduces it: the
        environment is unchanged and nothing is logged -- a restart onto the
        SAME install behaves the same way.
        """
        monkeypatch.delenv("SSL_CERT_FILE", raising=False)
        monkeypatch.delenv("REQUESTS_CA_BUNDLE", raising=False)
        bundle = _install_bundle(tmp_path, "v1")
        bundle.parent.mkdir(parents=True)
        bundle.write_text("v1 certifi bundle")
        no_cafile, no_candidates = _no_system_bundle()

        with (
            no_cafile,
            no_candidates,
            patch.dict("sys.modules", {"certifi": _certifi_at(bundle)}),
            caplog.at_level("INFO", logger="kiro_crew._ssl_compat"),
        ):
            _ensure_ssl_certs()
            _ensure_ssl_certs()

        import os

        assert os.environ["SSL_CERT_FILE"] == str(bundle)
        assert os.environ["REQUESTS_CA_BUNDLE"] == str(bundle)
        assert os.environ[_EXPORTED_BUNDLE_ENV] == str(bundle)
        assert caplog.records == []

    def test_win32_leaves_an_inherited_or_operator_value_alone(self, monkeypatch, tmp_path):
        """On win32 the derivation exports nothing, so nothing there can be the runtime's.

        A Windows operator who set ``SSL_CERT_FILE`` to their own interpreter's
        certifi bundle is the only author that value can have; neither the
        provenance rule nor the shape rule touches it, even with a stray
        provenance beside it.  Mirrors
        ``test_win32_still_honours_an_explicit_ssl_cert_file``.
        """
        monkeypatch.setattr(sys, "platform", "win32")
        bundle = _install_bundle(tmp_path, "py312")  # never created
        monkeypatch.setenv("SSL_CERT_FILE", str(bundle))
        monkeypatch.setenv(_EXPORTED_BUNDLE_ENV, str(bundle))
        monkeypatch.delenv("REQUESTS_CA_BUNDLE", raising=False)

        _ensure_ssl_certs()

        import os

        assert os.environ["SSL_CERT_FILE"] == str(bundle)
        assert os.environ[_EXPORTED_BUNDLE_ENV] == str(bundle)
        assert os.environ.get("REQUESTS_CA_BUNDLE") is None

    def test_install_shape_predicate(self, tmp_path):
        """The shape is ``.../site-packages/certifi/cacert.pem`` with a parent, nothing else."""
        from kiro_crew._ssl_compat import _is_install_pinned_bundle

        assert _is_install_pinned_bundle(str(_install_bundle(tmp_path, "v1")))
        assert _is_install_pinned_bundle(str(tmp_path / "site-packages" / "certifi" / "cacert.pem"))
        # A system bundle, an operator's file, certifi outside site-packages, the
        # package directory itself, and the bare tail without an install around it.
        assert not _is_install_pinned_bundle("/etc/ssl/certs/ca-certificates.crt")
        assert not _is_install_pinned_bundle(str(tmp_path / "corp" / "ca-bundle.pem"))
        assert not _is_install_pinned_bundle(str(tmp_path / "certifi" / "cacert.pem"))
        assert not _is_install_pinned_bundle(str(tmp_path / "site-packages" / "certifi"))
        assert not _is_install_pinned_bundle(str(Path("site-packages") / "certifi" / "cacert.pem"))
        assert not _is_install_pinned_bundle("")

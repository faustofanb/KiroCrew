"""Make platform trust available before any HTTPS client caches an SSL context.

macOS trust is policy-aware and cannot be represented faithfully as a static
PEM bundle: the Keychain carries user/admin/system trust, explicit distrust,
hostname policy, and validity decisions. Applications must therefore ask
Security.framework to evaluate each connection. Other platforms keep the
file-based bootstrap used for Linux distributions whose Python default points
at the wrong CA location.
"""

from __future__ import annotations

import logging
import os
import ssl
import sys
from pathlib import Path

try:  # macOS-only dependency (setup.cfg marker); absent on other platforms.
    import truststore
except ImportError:
    truststore = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

_CA_CANDIDATES = (
    "/etc/pki/tls/cert.pem",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/certs/ca-certificates.crt",
)
# The two variables _ensure_ssl_certs exports for the children that cannot
# inherit a process-local trust injection (kiro-cli, Node MCP servers).
_CA_BUNDLE_ENV = ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE")
# The provenance of that export: the bundle path this runtime wrote into the
# two variables above, published beside them. A value equal to it is the
# runtime's own -- an earlier pass in this process, or a predecessor's that an
# in-app restart handed down -- never an operator's (see _is_runtime_export).
_EXPORTED_BUNDLE_ENV = "KIROCREW_EXPORTED_CA_BUNDLE"
# The path tail every Kiro Crew install's own CA bundle shares: the one file
# certifi ships, at the one place pip puts the package. An export of it is
# INSTALL-PINNED -- it names this install's site-packages, which an upgrade
# prunes (see _is_install_pinned_bundle).
_INSTALL_BUNDLE_PATH_TAIL = ("site-packages", "certifi", "cacert.pem")
_TRUSTSTORE_INJECTED = False


def _inject_macos_system_trust() -> bool:
    """Install Security.framework-backed SSL contexts once per process.

    ``truststore`` evaluates the real server chain through SecTrust instead of
    flattening every certificate stored in a Keychain into an unconditional
    OpenSSL trust anchor.  Return ``False`` on failure so startup can retain the
    prior file-based behavior rather than losing all HTTPS capability.
    """
    global _TRUSTSTORE_INJECTED

    if _TRUSTSTORE_INJECTED:
        return True

    if truststore is None:
        logger.warning("truststore is not installed; falling back to file-based CA discovery")
        return False

    try:
        truststore.inject_into_ssl()
    except Exception as exc:
        # A log line rather than warnings.warn: under a strict warnings filter
        # a warning becomes an exception inside the startup prelude, turning
        # the fallback this function promises into a startup crash.
        logger.warning(
            "Could not enable the macOS system trust store; falling back to "
            "file-based CA discovery: %s",
            exc,
        )
        return False

    _TRUSTSTORE_INJECTED = True
    return True


def _ssl_context_has_ca_trust(context: ssl.SSLContext) -> bool:
    """Return whether *context* has a usable CA trust source.

    OpenSSL contexts expose a concrete CA count. Security.framework-backed
    truststore contexts evaluate anchors dynamically and intentionally cannot
    enumerate that count, so a successful process-level injection is their
    equivalent trust-source signal.
    """
    try:
        return context.cert_store_stats()["x509_ca"] > 0
    except NotImplementedError:
        return _TRUSTSTORE_INJECTED


def _is_install_pinned_bundle(value: str) -> bool:
    """Whether *value* names SOME Kiro Crew install's own certifi bundle.

    Some install's, not only this one's: the shape is
    ``.../site-packages/certifi/cacert.pem``, the one file certifi ships at the
    one place pip puts it, under every pip, venv and desktop-bundle install.
    :func:`_derive_trust` exports exactly that path when the host has no system
    CA bundle (the macOS desktop bundle, standalone and source installs), and
    the in-app restart successors (``os.execve`` in
    ``_process_group_supervisor``, ``os.execv`` in ``_spawn_exec_shim``) inherit
    the environment it was written into. The export is install-pinned: an
    upgrade prunes the site-packages it names, so a successor that keeps the
    predecessor's value points at a file that is gone.

    The shape is the same reasoning ``LLAMA_CPP_LIB_PATH`` applies
    (``embeddings._is_bundled_libs_dir``): a value shaped like the runtime's own
    export was most plausibly written by a Kiro Crew process. Here it is NOT
    enough on its own -- see :func:`_is_runtime_export` for why an existing
    file of this shape may be an operator's working policy -- so it decides
    only together with the file being gone, the one state in which the value is
    nobody's working policy.
    """
    parts = Path(value).parts
    return (
        len(parts) > len(_INSTALL_BUNDLE_PATH_TAIL)
        and parts[-len(_INSTALL_BUNDLE_PATH_TAIL) :] == _INSTALL_BUNDLE_PATH_TAIL
    )


def _is_runtime_export(value: str) -> bool:
    """Whether *value*, read from one of ``_CA_BUNDLE_ENV``, is this runtime's own export.

    Two ways, and no third:

    * It equals ``KIROCREW_EXPORTED_CA_BUNDLE``, the provenance
      :func:`_export_ca_bundle` publishes beside every bundle it exports. A
      successor inherits both variables together, so it reads its predecessor's
      export as what it is. An operator's value never carries it: they set
      ``SSL_CERT_FILE`` alone, and the two differ.
    * It is shaped like an install's certifi bundle
      (:func:`_is_install_pinned_bundle`) and the file is gone. Nobody's working
      trust policy points at a missing file -- every handshake already fails on
      it -- and the one thing such a pointer plausibly is, is a pruned
      predecessor's export from a version that published no provenance. That is
      the bridge across the upgrade onto this rule; the provenance carries every
      restart after it.

    Shape alone is deliberately not enough while the file exists. An operator
    who set ``SSL_CERT_FILE`` to a certifi bundle -- ``$(python -m certifi)``,
    or one they appended a private CA to -- holds a working policy, and on
    macOS it is also an exclusion: an explicit bundle bypasses the
    Security.framework injection, so the Keychain's CAs are not trusted.
    Re-deriving over it would widen trust past what the operator chose.
    """
    exported = os.environ.get(_EXPORTED_BUNDLE_ENV)
    if exported and value == exported:
        return True
    # os.path.exists, not Path.exists: the latter re-raises a stat error other
    # than "not found" (an unreadable parent), and this is the startup prelude.
    return _is_install_pinned_bundle(value) and not os.path.exists(value)


def _ensure_ssl_certs() -> None:
    """Configure platform trust before any HTTPS library caches its context.

    An explicit ``SSL_CERT_FILE`` remains the highest-precedence escape hatch,
    with one exception: a value that is this runtime's own export
    (:func:`_is_runtime_export`), inherited from the predecessor an in-app
    restart replaced, names THAT install. It is dropped -- from
    ``REQUESTS_CA_BUNDLE`` too, and before the operator check, so a stale
    export beside an operator's ``SSL_CERT_FILE`` does not survive either --
    and trust is derived for this install exactly as a clean start derives it
    (:func:`_derive_trust`), with one warning when the value changes. An
    operator's own bundle is left untouched, with one warning when the file it
    names cannot be found.

    Windows takes none of this: the derivation exports nothing there, so no
    Kiro Crew process can have left a value behind and whatever is set is an
    operator's.

    macOS additionally installs Security.framework evaluation for this
    process's own clients, but ``inject_into_ssl()`` is process-local, so the
    file-based discovery still runs to export ``SSL_CERT_FILE`` /
    ``REQUESTS_CA_BUNDLE`` for child processes (kiro-cli, Node MCP servers)
    that inherit this environment and cannot inherit a monkey-patch.
    """
    inherited: dict[str, str] = {}
    if sys.platform != "win32":
        inherited = {
            name: value
            for name in _CA_BUNDLE_ENV
            if (value := os.environ.get(name)) and _is_runtime_export(value)
        }
        for name in inherited:
            del os.environ[name]
        # The provenance describes the export this process makes below, if any;
        # an inherited one has been read and is stale from here on.
        os.environ.pop(_EXPORTED_BUNDLE_ENV, None)

    _derive_trust()

    replaced = [
        f"{name}={stale}" for name, stale in inherited.items() if os.environ.get(name) != stale
    ]
    if replaced:
        # WARNING, not INFO: the prelude runs before logging is configured, and
        # the default last-resort handler drops everything below WARNING.
        logger.warning(
            "Ignoring %s inherited from another Kiro Crew process; "
            "this install resolves its own CA bundle",
            " and ".join(replaced),
        )


def _derive_trust() -> None:
    """The clean-start trust derivation, in precedence order.

    An operator's ``SSL_CERT_FILE`` wins outright; Windows exports nothing;
    macOS injects system trust for this process; then the interpreter's own
    default cafile (nothing to export), the Linux distribution bundles, and
    this install's certifi bundle, exported for children by
    :func:`_export_ca_bundle`.
    """
    preset = os.environ.get("SSL_CERT_FILE")
    if preset:
        if not os.path.exists(preset):
            logger.warning(
                "SSL_CERT_FILE=%s names a file this process cannot find; TLS "
                "connections will fail until it is corrected or unset",
                preset,
            )
        return

    if sys.platform == "win32":
        return

    if sys.platform == "darwin":
        _inject_macos_system_trust()

    defaults = ssl.get_default_verify_paths()
    if defaults.cafile and Path(defaults.cafile).exists():
        return

    for candidate in _CA_CANDIDATES:
        if Path(candidate).exists():
            _export_ca_bundle(candidate)
            return

    # The file-based fallback keeps standalone/source installations usable when
    # the OS-specific bootstrap is unavailable.  requests makes certifi part of
    # Kiro Crew's installed dependency closure, including the desktop bundle.
    try:
        import certifi

        bundle = certifi.where()
    except ImportError:
        return
    if Path(bundle).exists():
        _export_ca_bundle(bundle)


def _export_ca_bundle(bundle: str) -> None:
    """Export *bundle* for child processes, with its provenance.

    ``REQUESTS_CA_BUNDLE`` is only defaulted: an operator's own value there is
    theirs. The provenance names the bundle exported here, which is what lets
    a successor tell this export from an operator's (:func:`_is_runtime_export`).
    """
    os.environ["SSL_CERT_FILE"] = bundle
    os.environ.setdefault("REQUESTS_CA_BUNDLE", bundle)
    os.environ[_EXPORTED_BUNDLE_ENV] = bundle

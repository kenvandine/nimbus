from __future__ import annotations

import datetime
import ipaddress
import logging
import os
import socket
from pathlib import Path

logger = logging.getLogger(__name__)

_TLS_DIR_ENV = "NIMBUS_TLS_DIR"
_DEFAULT_TLS_DIR = "/var/snap/nimbus/common/tls"
# Regenerate when fewer than this many days remain on the cert.
_RENEW_BEFORE_DAYS = 30


def _tls_dir() -> Path:
    env = os.environ.get(_TLS_DIR_ENV, "")
    snap_common = os.environ.get("SNAP_COMMON", "")
    if env:
        return Path(env)
    if snap_common:
        return Path(snap_common) / "tls"
    return Path(_DEFAULT_TLS_DIR)


def cert_path() -> Path:
    return _tls_dir() / "nimbus.crt"


def key_path() -> Path:
    return _tls_dir() / "nimbus.key"


def _collect_local_ips() -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    """Return all IP addresses assigned to this host."""
    ips: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    seen: set[str] = set()
    for addr_str in ("127.0.0.1", "::1"):
        ips.append(ipaddress.ip_address(addr_str))
        seen.add(addr_str)
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None):
            addr_str = info[4][0]
            if addr_str in seen:
                continue
            try:
                ips.append(ipaddress.ip_address(addr_str))
                seen.add(addr_str)
            except ValueError:
                pass
    except Exception:
        pass
    return ips


def _cert_needs_renewal(crt: Path) -> bool:
    """Return True when the cert is missing, unreadable, or expiring soon."""
    try:
        from cryptography import x509
        cert = x509.load_pem_x509_certificate(crt.read_bytes())
        try:
            not_after = cert.not_valid_after_utc
        except AttributeError:
            # cryptography < 42 returns a naive datetime in UTC
            not_after = cert.not_valid_after.replace(tzinfo=datetime.timezone.utc)
        remaining = not_after - datetime.datetime.now(datetime.timezone.utc)
        return remaining.days < _RENEW_BEFORE_DAYS
    except Exception:
        return True


def ensure_tls_cert(hostname: str = "nimbus.local") -> tuple[Path, Path]:
    """Return (cert_path, key_path), generating a self-signed cert if needed."""
    crt = cert_path()
    key = key_path()
    if crt.exists() and key.exists() and not _cert_needs_renewal(crt):
        return crt, key

    logger.info("Generating self-signed TLS certificate for %s", hostname)
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
    except ImportError as exc:
        raise RuntimeError(f"cryptography package required for TLS: {exc}") from exc

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    subject = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, hostname),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Nimbus Appliance"),
    ])

    san_entries: list = [x509.DNSName(hostname), x509.DNSName("localhost")]
    for ip in _collect_local_ips():
        san_entries.append(x509.IPAddress(ip))

    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.SubjectAlternativeName(san_entries), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .sign(private_key, hashes.SHA256())
    )

    tls_dir = _tls_dir()
    tls_dir.mkdir(parents=True, exist_ok=True)

    key.write_bytes(private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ))
    key.chmod(0o600)

    crt.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    crt.chmod(0o644)

    logger.info("TLS certificate written to %s", tls_dir)
    return crt, key


def get_cert_fingerprint() -> str | None:
    """Return the SHA-256 fingerprint of the current cert, or None if not present."""
    crt = cert_path()
    if not crt.exists():
        return None
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes
        cert = x509.load_pem_x509_certificate(crt.read_bytes())
        fp = cert.fingerprint(hashes.SHA256()).hex()
        return ":".join(fp[i:i+2].upper() for i in range(0, len(fp), 2))
    except Exception as exc:
        logger.warning("Could not read cert fingerprint: %s", exc)
        return None

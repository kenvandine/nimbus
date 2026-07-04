import datetime
import ipaddress
import os
import socket
from pathlib import Path
from unittest import mock
import pytest

from services.tls import (
    _tls_dir,
    cert_path,
    key_path,
    _collect_local_ips,
    _cert_needs_renewal,
    ensure_tls_cert,
    get_cert_fingerprint,
)


def test_tls_dir_env_override(monkeypatch):
    """Test that NIMBUS_TLS_DIR overrides everything."""
    monkeypatch.setenv("NIMBUS_TLS_DIR", "/custom/tls/dir")
    monkeypatch.setenv("SNAP_COMMON", "/snap/common")
    assert _tls_dir() == Path("/custom/tls/dir")


def test_tls_dir_snap_common(monkeypatch):
    """Test that SNAP_COMMON is used if NIMBUS_TLS_DIR is not set."""
    monkeypatch.delenv("NIMBUS_TLS_DIR", raising=False)
    monkeypatch.setenv("SNAP_COMMON", "/snap/common")
    assert _tls_dir() == Path("/snap/common/tls")


def test_tls_dir_default(monkeypatch):
    """Test default fallback when no env variables are set."""
    monkeypatch.delenv("NIMBUS_TLS_DIR", raising=False)
    monkeypatch.delenv("SNAP_COMMON", raising=False)
    assert _tls_dir() == Path("/var/snap/nimbus/common/tls")


def test_cert_and_key_paths(monkeypatch):
    """Test cert_path and key_path helpers."""
    monkeypatch.setenv("NIMBUS_TLS_DIR", "/custom/tls")
    assert cert_path() == Path("/custom/tls/nimbus.crt")
    assert key_path() == Path("/custom/tls/nimbus.key")


def test_collect_local_ips(monkeypatch):
    """Test collecting host IP addresses including loopbacks."""
    with mock.patch("socket.gethostname", return_value="test-host"):
        with mock.patch(
            "socket.getaddrinfo",
            return_value=[
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.168.1.50", 0)),
                (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("fe80::1", 0)),
            ],
        ):
            ips = _collect_local_ips()
            
            # Should contain loopbacks
            assert ipaddress.ip_address("127.0.0.1") in ips
            assert ipaddress.ip_address("::1") in ips
            # Should contain the mocked IPs
            assert ipaddress.ip_address("192.168.1.50") in ips
            assert ipaddress.ip_address("fe80::1") in ips


def test_cert_needs_renewal_missing_file():
    """Test that a missing certificate requires renewal."""
    assert _cert_needs_renewal(Path("/nonexistent/file.crt")) is True


def test_ensure_tls_cert_generates_files(tmp_path, monkeypatch):
    """Test that ensure_tls_cert creates new cert and private key files."""
    monkeypatch.setenv("NIMBUS_TLS_DIR", str(tmp_path))
    
    crt, key = ensure_tls_cert(hostname="test.nimbus.local")
    
    assert crt.exists()
    assert key.exists()
    
    # Check that cert fingerprint can be read and is not None
    fingerprint = get_cert_fingerprint()
    assert fingerprint is not None
    assert len(fingerprint.split(":")) == 32  # SHA-256 is 32 bytes hex colon-separated


def test_ensure_tls_cert_existing_valid(tmp_path, monkeypatch):
    """Test that ensure_tls_cert does not regenerate a valid certificate."""
    monkeypatch.setenv("NIMBUS_TLS_DIR", str(tmp_path))
    
    # Generate the certificate first
    crt1, key1 = ensure_tls_cert(hostname="test.nimbus.local")
    mtime_crt1 = crt1.stat().st_mtime
    mtime_key1 = key1.stat().st_mtime
    
    # Calling it again immediately should reuse the certificate
    crt2, key2 = ensure_tls_cert(hostname="test.nimbus.local")
    
    assert crt2.stat().st_mtime == mtime_crt1
    assert key2.stat().st_mtime == mtime_key1

"""TLS certificate provisioning.

When NIMBUS_PROVISIONING_URL is set, uses ACME DNS-01 via Let's Encrypt to
obtain a publicly-trusted certificate for the device's assigned subdomain
(e.g. <device-id>.devices.nimbusappliance.app).  The backend handles both device
registration (IP → subdomain) and DNS-01 challenge TXT record management.

When NIMBUS_PROVISIONING_URL is not set, falls back to a self-signed cert
(see services/tls.py) so the snap works offline or without infrastructure.

This module is called synchronously from nimbus-launch *before* uvicorn
starts, so the cert is always present when the server binds.
"""
from __future__ import annotations

import hashlib
import logging
import time
from pathlib import Path

logger = logging.getLogger(__name__)

ACME_PROD = "https://acme-v02.api.letsencrypt.org/directory"
ACME_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory"


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def provision_tls() -> tuple[Path, Path]:
    """Return (cert_path, key_path), provisioning via ACME when configured.

    Guaranteed to return usable paths: on ACME failure the function logs the
    error and returns a self-signed cert so the server still starts over HTTPS.
    """
    from config import settings
    from services.tls import cert_path, key_path, _cert_needs_renewal, ensure_tls_cert

    if not settings.provisioning_url:
        return ensure_tls_cert()

    crt = cert_path()
    key = key_path()
    if crt.exists() and key.exists() and not _cert_needs_renewal(crt):
        logger.debug("ACME cert is valid, skipping renewal")
        return crt, key

    logger.info("Provisioning TLS certificate via ACME DNS-01...")
    try:
        return _provision_acme(settings)
    except Exception as exc:
        logger.error("ACME provisioning failed: %s", exc)
        if crt.exists() and key.exists():
            logger.warning("Using existing cert despite renewal failure")
            return crt, key
        logger.warning("Falling back to self-signed certificate")
        return ensure_tls_cert()


# ---------------------------------------------------------------------------
# Device registration
# ---------------------------------------------------------------------------

def _get_lan_ip() -> str:
    try:
        from services.network import get_primary_interface_ip
        ip = get_primary_interface_ip()
        return ip or "127.0.0.1"
    except Exception:
        return "127.0.0.1"


def _register_device(backend_url: str, token: str, device_id: str) -> str:
    """Register device with the provisioning backend; return assigned domain."""
    import httpx
    resp = httpx.post(
        f"{backend_url}/api/v1/devices/register",
        json={"device_id": device_id, "ip": _get_lan_ip()},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["domain"]


# ---------------------------------------------------------------------------
# DNS-01 challenge helpers
# ---------------------------------------------------------------------------

def _dns01_txt_value(key_authorization: str) -> str:
    """Return the base64url-encoded SHA-256 of key_authorization."""
    import base64
    digest = hashlib.sha256(key_authorization.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def _set_dns_challenge(backend_url: str, token: str, device_id: str, txt: str) -> None:
    import httpx
    resp = httpx.post(
        f"{backend_url}/api/v1/acme/challenge",
        json={"device_id": device_id, "txt": txt},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    resp.raise_for_status()
    logger.debug("DNS-01 TXT record set")


def _clear_dns_challenge(backend_url: str, token: str, device_id: str) -> None:
    import httpx
    try:
        httpx.delete(
            f"{backend_url}/api/v1/acme/challenge",
            json={"device_id": device_id},
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        logger.debug("DNS-01 TXT record cleared")
    except Exception as exc:
        logger.warning("Could not clear DNS-01 challenge record: %s", exc)


# ---------------------------------------------------------------------------
# ACME key + CSR helpers
# ---------------------------------------------------------------------------

def _account_key_path() -> Path:
    from services.tls import _tls_dir
    return _tls_dir() / "acme-account.key"


def _load_or_create_account_key():
    import josepy as jose
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.serialization import load_pem_private_key

    path = _account_key_path()
    if path.exists():
        try:
            key = load_pem_private_key(path.read_bytes(), password=None)
            return jose.JWKRSA(key=key)
        except Exception:
            pass

    logger.info("Generating ACME account key")
    raw = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    ))
    path.chmod(0o600)
    return jose.JWKRSA(key=raw)


def _build_csr_pem(domain: str, cert_key) -> bytes:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.x509.oid import NameOID

    csr = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, domain)]))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(domain)]), critical=False)
        .sign(cert_key, hashes.SHA256())
    )
    return csr.public_bytes(serialization.Encoding.PEM)


def _load_or_create_cert_key():
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
    from services.tls import key_path

    path = key_path()
    if path.exists():
        try:
            return load_pem_private_key(path.read_bytes(), password=None)
        except Exception:
            pass

    raw = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    ))
    path.chmod(0o600)
    return raw


# ---------------------------------------------------------------------------
# Core ACME provisioning
# ---------------------------------------------------------------------------

def _provision_acme(settings) -> tuple[Path, Path]:
    import datetime
    import josepy as jose
    from acme import client as acme_client_mod, messages, challenges, errors
    from services.device_id import get_device_id
    from services.tls import cert_path, key_path

    device_id = get_device_id()
    token = settings.provisioning_token or ""
    backend = settings.provisioning_url

    # Register device and obtain its subdomain
    domain = _register_device(backend, token, device_id)
    logger.info("Assigned domain: %s", domain)

    # Set up ACME client
    account_key = _load_or_create_account_key()
    acme_url = ACME_STAGING if settings.acme_staging else ACME_PROD
    net = acme_client_mod.ClientNetwork(account_key, user_agent="nimbus-appliance/1.0")
    directory = acme_client_mod.ClientV2.get_directory(acme_url, net)
    acme = acme_client_mod.ClientV2(directory, net)

    # Create or recover ACME account
    new_reg = messages.NewRegistration.from_data(terms_of_service_agreed=True)
    try:
        acme.new_account(new_reg)
    except errors.ConflictError:
        pass  # Account already registered

    # Build CSR
    cert_key = _load_or_create_cert_key()
    csr_pem = _build_csr_pem(domain, cert_key)

    # Order certificate
    orderr = acme.new_order(csr_pem)

    # Answer DNS-01 challenges
    dns_set = False
    try:
        for authz in orderr.authorizations:
            for challenge in authz.body.challenges:
                if isinstance(challenge.chall, challenges.DNS01):
                    txt = challenge.chall.validation(account_key)
                    logger.info("Setting DNS-01 TXT record for %s", domain)
                    _set_dns_challenge(backend, token, device_id, txt)
                    dns_set = True

                    logger.info("Waiting for DNS propagation (20 s)...")
                    time.sleep(20)

                    acme.answer_challenge(challenge, challenge.chall.response(account_key))
                    break

        # Poll until Let's Encrypt validates and issues the cert
        deadline = datetime.datetime.now() + datetime.timedelta(minutes=5)
        orderr = acme.poll_and_finalize(orderr, deadline=deadline)

    finally:
        if dns_set:
            _clear_dns_challenge(backend, token, device_id)

    # Persist cert (full chain) and return paths
    crt = cert_path()
    crt.parent.mkdir(parents=True, exist_ok=True)
    crt.write_bytes(orderr.fullchain_pem.encode())
    crt.chmod(0o644)

    logger.info("Let's Encrypt certificate issued for %s", domain)
    return crt, key_path()

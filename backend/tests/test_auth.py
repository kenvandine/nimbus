from unittest import mock
import pytest
from fastapi import HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials

from auth import require_api_token, require_api_token_or_local, _is_trusted_local


class MockClient:
    def __init__(self, host):
        self.host = host


class MockRequest:
    def __init__(self, host=None, headers=None, cookies=None):
        self.client = MockClient(host) if host else None
        self.headers = headers or {}
        self.cookies = cookies or {}


def test_is_trusted_local():
    # True case: host is 127.0.0.1 and header is "1"
    req_ok_ipv4 = MockRequest(host="127.0.0.1", headers={"x-nimbus-local": "1"})
    assert _is_trusted_local(req_ok_ipv4) is True

    req_ok_ipv6 = MockRequest(host="::1", headers={"x-nimbus-local": "1"})
    assert _is_trusted_local(req_ok_ipv6) is True

    # False cases
    req_no_client = MockRequest(host=None, headers={"x-nimbus-local": "1"})
    assert _is_trusted_local(req_no_client) is False

    req_wrong_host = MockRequest(host="192.168.1.1", headers={"x-nimbus-local": "1"})
    assert _is_trusted_local(req_wrong_host) is False

    req_no_header = MockRequest(host="127.0.0.1", headers={})
    assert _is_trusted_local(req_no_header) is False

    req_wrong_header = MockRequest(host="127.0.0.1", headers={"x-nimbus-local": "0"})
    assert _is_trusted_local(req_wrong_header) is False


@pytest.mark.asyncio
@mock.patch("services.auth.account_exists", return_value=False)
async def test_require_api_token_oobe(mock_account_exists):
    """If no account exists (OOBE), authentication is bypassed."""
    req = MockRequest()
    # Should not raise any exception
    await require_api_token(req, credentials=None)


@pytest.mark.asyncio
@mock.patch("services.auth.account_exists", return_value=True)
async def test_require_api_token_no_auth(mock_account_exists):
    """If account exists and no credentials or cookie, raises 401."""
    req = MockRequest()
    with pytest.raises(HTTPException) as exc_info:
        await require_api_token(req, credentials=None)
    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
@mock.patch("services.auth.account_exists", return_value=True)
@mock.patch("auth.settings")
async def test_require_api_token_bearer_valid(mock_settings, mock_account_exists):
    """If Bearer token is provided and matches settings.api_token, allows access."""
    mock_settings.api_token = "secret-api-token"
    req = MockRequest()
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="secret-api-token")
    
    # Should run without error
    await require_api_token(req, credentials=creds)


@pytest.mark.asyncio
@mock.patch("services.auth.account_exists", return_value=True)
@mock.patch("auth.settings")
async def test_require_api_token_bearer_invalid(mock_settings, mock_account_exists):
    """If Bearer token is invalid, raises 401."""
    mock_settings.api_token = "secret-api-token"
    req = MockRequest()
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="wrong-token")
    
    with pytest.raises(HTTPException) as exc_info:
        await require_api_token(req, credentials=creds)
    assert exc_info.value.status_code == 401



@pytest.mark.asyncio
@mock.patch("services.auth.account_exists", return_value=True)
@mock.patch("services.auth.verify_session_token", return_value=True)
async def test_require_api_token_cookie_valid(mock_verify, mock_account_exists):
    """If valid session token exists in cookies, allows access."""
    req = MockRequest(cookies={"nimbus-session": "valid-session-token"})
    await require_api_token(req, credentials=None)
    mock_verify.assert_called_once_with("valid-session-token")


@pytest.mark.asyncio
@mock.patch("services.auth.account_exists", return_value=True)
@mock.patch("services.auth.verify_session_token", return_value=False)
async def test_require_api_token_cookie_invalid(mock_verify, mock_account_exists):
    """If invalid session token in cookies, raises 401."""
    req = MockRequest(cookies={"nimbus-session": "invalid-session-token"})
    with pytest.raises(HTTPException) as exc_info:
        await require_api_token(req, credentials=None)
    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
@mock.patch("services.auth.account_exists", return_value=True)
async def test_require_api_token_or_local_trusted(mock_account_exists):
    """If request is trusted local, require_api_token_or_local allows it."""
    req = MockRequest(host="127.0.0.1", headers={"x-nimbus-local": "1"})
    # Should allow it even without any credentials/cookies
    await require_api_token_or_local(req, credentials=None)


@pytest.mark.asyncio
@mock.patch("services.auth.account_exists", return_value=True)
async def test_require_api_token_or_local_not_trusted(mock_account_exists):
    """If request is not trusted local, require_api_token_or_local performs normal auth."""
    req = MockRequest(host="192.168.1.1", headers={"x-nimbus-local": "1"})
    with pytest.raises(HTTPException) as exc_info:
        await require_api_token_or_local(req, credentials=None)
    assert exc_info.value.status_code == 401

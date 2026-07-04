import json
from unittest import mock
import pytest

from agent.daemon import _route, _nimbus_uid, _state


@pytest.mark.asyncio
async def test_agent_health_endpoint():
    """Test GET /health API endpoint."""
    status_code, body = await _route("GET", "/health", b"")
    assert status_code == 200
    assert body["ok"] is True
    assert "version" in body
    assert "dns_ok" in body


@pytest.mark.asyncio
async def test_agent_apps_endpoint():
    """Test GET /apps API endpoint."""
    # Temporarily set state apps
    original_apps = _state["apps"]
    _state["apps"] = {"test-app": {"running": True}}
    try:
        status_code, body = await _route("GET", "/apps", b"")
        assert status_code == 200
        assert body == {"apps": {"test-app": {"running": True}}}
    finally:
        _state["apps"] = original_apps


@pytest.mark.asyncio
async def test_agent_snaps_install_validation():
    """Test POST /snaps/install inputs validation."""
    # Invalid JSON
    status_code, body = await _route("POST", "/snaps/install", b"invalid-json")
    assert status_code == 400
    assert "error" in body

    # Missing name
    status_code, body = await _route("POST", "/snaps/install", b'{"channel": "stable"}')
    assert status_code == 400
    assert "name required" in body["error"]


@pytest.mark.asyncio
async def test_agent_files_read_permitted():
    """Test GET /files/read path restrictions and functionality."""
    # Missing path
    status_code, body = await _route("GET", "/files/read", b"")
    assert status_code == 400
    assert "path query parameter required" in body["error"]

    # Disallowed path prefix
    status_code, body = await _route("GET", "/files/read?path=/var/log/syslog", b"")
    assert status_code == 403
    assert "path not permitted" in body["error"]

    # Allowed but missing file
    status_code, body = await _route("GET", "/files/read?path=/home/nimbus/nonexistent.txt", b"")
    assert status_code == 404
    assert "file not found" in body["error"]

    # Allowed and successful read
    mock_content = "hello world"
    with mock.patch("builtins.open", mock.mock_open(read_data=mock_content)):
        status_code, body = await _route("GET", "/files/read?path=/home/nimbus/test.txt", b"")
        assert status_code == 200
        assert body["content"] == mock_content
        assert body["path"] == "/home/nimbus/test.txt"


@pytest.mark.asyncio
async def test_agent_files_write_permitted():
    """Test POST /files/write path restrictions and functionality."""
    # Invalid JSON
    status_code, body = await _route("POST", "/files/write", b"invalid-json")
    assert status_code == 400
    assert "error" in body

    # Missing parameters
    status_code, body = await _route("POST", "/files/write", b'{"path": "/home/nimbus/test.txt"}')
    assert status_code == 400
    assert "path and content required" in body["error"]

    # Disallowed path prefix
    status_code, body = await _route("POST", "/files/write", b'{"path": "/etc/shadow", "content": "bad"}')
    assert status_code == 403
    assert "path not permitted" in body["error"]

    # Allowed and successful write
    m_open = mock.mock_open()
    with mock.patch("builtins.open", m_open), mock.patch("os.makedirs") as mock_makedirs:
        status_code, body = await _route("POST", "/files/write", b'{"path": "/home/nimbus/test.txt", "content": "saved"}')
        assert status_code == 200
        assert body["ok"] is True
        mock_makedirs.assert_called_once_with("/home/nimbus", exist_ok=True)
        m_open.assert_called_once_with("/home/nimbus/test.txt", "w")
        m_open().write.assert_called_once_with("saved")


def test_nimbus_uid_resolution():
    """Test UID resolution logic for nimbus user."""
    # Mocking standard pwd getpwnam lookup
    mock_pw = mock.MagicMock()
    mock_pw.pw_uid = 1001
    with mock.patch("pwd.getpwnam", return_value=mock_pw):
        assert _nimbus_uid() == 1001

    # Handled exceptions (when nimbus user does not exist)
    with mock.patch("pwd.getpwnam", side_effect=KeyError()):
        assert _nimbus_uid() is None

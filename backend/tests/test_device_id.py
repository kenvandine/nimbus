import os
import uuid
from pathlib import Path
from unittest import mock
import pytest

from services.device_id import _device_id_path, get_device_id


def test_device_id_path_with_snap_common(monkeypatch):
    """Test path resolution when SNAP_COMMON env var is set."""
    monkeypatch.setenv("SNAP_COMMON", "/test/snap/common")
    path = _device_id_path()
    assert path == Path("/test/snap/common/device-id")


def test_device_id_path_without_snap_common(monkeypatch):
    """Test path resolution when SNAP_COMMON is not set (falls back to home)."""
    monkeypatch.delenv("SNAP_COMMON", raising=False)
    path = _device_id_path()
    assert path == Path.home() / ".nimbus" / "device-id"


def test_get_device_id_creates_new(tmp_path, monkeypatch):
    """Test that get_device_id generates and saves a new UUID if none exists."""
    monkeypatch.setenv("SNAP_COMMON", str(tmp_path))
    
    device_id = get_device_id()
    
    # Check that it's a valid UUID
    val = uuid.UUID(device_id)
    assert str(val) == device_id
    
    # Check that it was saved to the file
    path = tmp_path / "device-id"
    assert path.exists()
    assert path.read_text().strip() == device_id


def test_get_device_id_returns_existing(tmp_path, monkeypatch):
    """Test that get_device_id reads and returns an existing UUID from file."""
    monkeypatch.setenv("SNAP_COMMON", str(tmp_path))
    existing_uuid = str(uuid.uuid4())
    
    path = tmp_path / "device-id"
    path.write_text(existing_uuid)
    
    device_id = get_device_id()
    assert device_id == existing_uuid


def test_get_device_id_handles_write_error(tmp_path, monkeypatch):
    """Test that get_device_id still returns a UUID if saving to file fails."""
    monkeypatch.setenv("SNAP_COMMON", str(tmp_path))
    
    # Mock write_text to raise an exception
    with mock.patch.object(Path, "write_text", side_effect=OSError("Read-only file system")):
        device_id = get_device_id()
        
        # Should still generate and return a UUID
        val = uuid.UUID(device_id)
        assert str(val) == device_id

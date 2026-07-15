from types import SimpleNamespace

import pytest

from services import crypto_store


@pytest.fixture
def isolated_secret(tmp_path, monkeypatch):
    """Point crypto_store at a throwaway auth-secret + SNAP_DATA dir."""
    (tmp_path / "auth-secret").write_bytes(b"test-passphrase")
    monkeypatch.setattr(
        "config.settings",
        SimpleNamespace(installed_dir=tmp_path / "installed"),
    )
    monkeypatch.setenv("SNAP_DATA", str(tmp_path))
    return tmp_path


def test_round_trip(isolated_secret):
    import json

    path = isolated_secret / "store.json"
    data = {"a": "1", "b": "2"}
    crypto_store.save_encrypted_json(path, data, "test-salt")
    assert crypto_store.load_encrypted_json(path, "test-salt") == data
    # Ciphertext on disk must not be the plaintext JSON encoding.
    assert path.read_bytes() != json.dumps(data).encode()


def test_load_missing_file_returns_empty_dict(isolated_secret):
    path = isolated_secret / "missing.json"
    assert crypto_store.load_encrypted_json(path, "test-salt") == {}


def test_salt_file_persisted_and_reused(isolated_secret):
    path = isolated_secret / "store.json"
    crypto_store.save_encrypted_json(path, {"x": "y"}, "test-salt")
    salt_file = isolated_secret / "test-salt"
    assert salt_file.exists()
    salt_before = salt_file.read_bytes()

    crypto_store.save_encrypted_json(path, {"x": "z"}, "test-salt")
    assert salt_file.read_bytes() == salt_before


def test_get_fernet_raises_without_auth_secret(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "config.settings",
        SimpleNamespace(installed_dir=tmp_path / "installed"),
    )
    monkeypatch.setenv("SNAP_DATA", str(tmp_path))
    with pytest.raises(RuntimeError):
        crypto_store.get_fernet("test-salt")

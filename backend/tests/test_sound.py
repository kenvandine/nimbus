import asyncio
from pathlib import Path
from unittest import mock

from services import sound


def test_sound_dir_with_snap(monkeypatch):
    monkeypatch.setenv("SNAP", "/snap/nimbus/current")
    assert sound.sound_dir() == "/snap/nimbus/current/share/sounds/nimbus"


def test_sound_dir_without_snap(monkeypatch):
    monkeypatch.delenv("SNAP", raising=False)
    assert sound.sound_dir() == "/usr/share/sounds/Yaru/stereo"


def test_sound_path():
    assert sound.sound_path("bell").endswith("bell.oga")


def test_play_missing_sound_returns_false(monkeypatch, tmp_path):
    monkeypatch.delenv("SNAP", raising=False)
    monkeypatch.setattr(sound, "sound_dir", lambda: str(tmp_path))
    assert sound.play("no-such-sound") is False


def test_play_runs_paplay(monkeypatch, tmp_path):
    sound_file = tmp_path / "bell.oga"
    sound_file.write_bytes(b"fake")
    monkeypatch.delenv("SNAP", raising=False)
    monkeypatch.setattr(sound, "sound_dir", lambda: str(tmp_path))
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/paplay")
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)

        class R:
            returncode = 0
        return R()

    monkeypatch.setattr(sound.subprocess, "run", fake_run)
    assert sound.play("bell") is True
    assert calls and calls[0] == ["/usr/bin/paplay", str(sound_file)]


def test_play_with_snap_uses_staged_paplay(monkeypatch, tmp_path):
    snap = tmp_path / "snap"
    (snap / "usr" / "bin").mkdir(parents=True)
    (snap / "share" / "sounds" / "nimbus").mkdir(parents=True)
    paplay = snap / "usr" / "bin" / "paplay"
    paplay.write_text("#!/bin/sh\n")
    sound_file = snap / "share" / "sounds" / "nimbus" / "bell.oga"
    sound_file.write_bytes(b"fake")
    monkeypatch.setenv("SNAP", str(snap))
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)

        class R:
            returncode = 0
        return R()

    monkeypatch.setattr(sound.subprocess, "run", fake_run)
    assert sound.play("bell") is True
    assert calls and calls[0] == [str(paplay), str(sound_file)]


def test_chime_marker_with_snap_common(monkeypatch):
    monkeypatch.setenv("SNAP_COMMON", "/test/common")
    assert sound._chime_marker() == Path("/test/common/.boot-chime-boot-id")


def test_chime_marker_without_snap_common(monkeypatch):
    monkeypatch.delenv("SNAP_COMMON", raising=False)
    assert sound._chime_marker() is None


def test_announce_boot_ready_skips_when_already_played(tmp_path, monkeypatch):
    monkeypatch.setenv("SNAP_COMMON", str(tmp_path))
    (tmp_path / ".boot-chime-boot-id").write_text(sound._boot_id())
    with mock.patch.object(sound, "play") as play_mock:
        asyncio.run(sound.announce_boot_ready())
    play_mock.assert_not_called()


def test_announce_boot_ready_plays_when_ready(tmp_path, monkeypatch):
    monkeypatch.setenv("SNAP_COMMON", str(tmp_path))
    real_sleep = asyncio.sleep
    with mock.patch.object(sound, "_web_service_up", return_value=True), \
         mock.patch.object(sound, "_on_network", return_value=True), \
         mock.patch.object(sound, "play", return_value=True) as play_mock, \
         mock.patch("asyncio.sleep", new=lambda s, _rs=real_sleep: _rs(0.01)):
        asyncio.run(sound.announce_boot_ready())
    play_mock.assert_called_once_with(sound.BOOT_CHIME_SOUND)
    assert (tmp_path / ".boot-chime-boot-id").exists()


def test_announce_boot_ready_waits_for_network(tmp_path, monkeypatch):
    monkeypatch.setenv("SNAP_COMMON", str(tmp_path))
    states = iter([False, True])
    real_sleep = asyncio.sleep

    with mock.patch.object(sound, "_web_service_up", return_value=True), \
         mock.patch.object(sound, "_on_network", side_effect=lambda: next(states)), \
         mock.patch.object(sound, "play", return_value=True) as play_mock, \
         mock.patch("asyncio.sleep", new=lambda s, _rs=real_sleep: _rs(0.01)):
        asyncio.run(sound.announce_boot_ready())
    play_mock.assert_called_once_with(sound.BOOT_CHIME_SOUND)

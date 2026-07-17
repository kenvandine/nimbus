from unittest import mock

import pytest
from fastapi.testclient import TestClient

with mock.patch("services.control_plane.get_control_plane") as mock_get_control_plane, \
     mock.patch("services.openclaw.start") as mock_openclaw_start, \
     mock.patch("services.store.ensure_store") as mock_ensure_store:

    from main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def bypass_auth():
    with mock.patch("services.auth.account_exists", return_value=False):
        yield


def test_get_status_endpoint():
    with mock.patch("services.model_router.get_state", return_value={
            "cloud_offload_enabled": False, "cloud_provider": None, "cloud_model": None,
            "toggles": {}, "advanced_json": None,
        }), \
        mock.patch("services.model_router.is_ready", return_value=False), \
        mock.patch("services.model_router.get_router_model_name", return_value="user.NimbusModel"), \
        mock.patch("services.lemonade.get_active_model_spec", return_value={"model_name": "user.Local"}), \
        mock.patch("services.lemonade.status") as mock_status:
        async def _status():
            from services.lemonade import LemonadeStatus
            return LemonadeStatus(reachable=True, base_url="http://localhost:13305")
        mock_status.side_effect = _status

        response = client.get("/api/cloud/status")

    assert response.status_code == 200
    data = response.json()
    assert data["cloud_offload_enabled"] is False
    assert data["router_model_name"] == "user.NimbusModel"
    assert data["local_model_id"] == "user.Local"
    assert data["lemonade_reachable"] is True


def test_get_presets_endpoint():
    response = client.get("/api/cloud/presets")
    assert response.status_code == 200
    assert "fireworks" in response.json()


def test_add_provider_validation_rejects_empty_base_url():
    response = client.post("/api/cloud/providers", json={
        "provider": "custom", "display_name": "Custom", "base_url": "", "api_key": "",
    })
    assert response.status_code == 422


def test_add_provider_success():
    with mock.patch("services.model_router.register_cloud_provider") as mock_register:
        async def _register(*args, **kwargs):
            return {"models_discovered": 2}
        mock_register.side_effect = _register

        response = client.post("/api/cloud/providers", json={
            "provider": "fireworks", "display_name": "Fireworks",
            "base_url": "https://api.fireworks.ai/inference/v1", "api_key": "fw-x",
        })

    assert response.status_code == 200
    assert response.json()["status"] == "added"


def test_add_provider_surfaces_lemonade_error_as_400():
    with mock.patch("services.model_router.register_cloud_provider", side_effect=RuntimeError("bad base_url")):
        response = client.post("/api/cloud/providers", json={
            "provider": "fireworks", "display_name": "Fireworks",
            "base_url": "https://bad", "api_key": "",
        })
    assert response.status_code == 400
    assert "bad base_url" in response.json()["detail"]


def test_delete_provider_endpoint():
    with mock.patch("services.model_router.remove_cloud_provider") as mock_remove:
        async def _remove(*args, **kwargs):
            return None
        mock_remove.side_effect = _remove
        response = client.delete("/api/cloud/providers/fireworks")
    assert response.status_code == 200
    assert response.json()["status"] == "removed"


def test_save_policy_success_and_triggers_autoconfig():
    with mock.patch("services.model_router.apply_cloud_policy") as mock_apply, \
         mock.patch("services.control_plane.run_lemonade_autoconfig", new=mock.AsyncMock()) as mock_autoconfig:
        async def _apply(*args, **kwargs):
            return {"cloud_offload_enabled": True}
        mock_apply.side_effect = _apply
        response = client.post("/api/cloud/policy", json={
            "enabled": True, "cloud_provider": "fireworks", "cloud_model": "fireworks.kimi-k2p5",
            "toggles": {"offload_tools": True}, "advanced_json": None,
        })
    assert response.status_code == 200
    assert response.json()["status"] == "saved"
    assert mock_autoconfig.called


def test_save_policy_surfaces_validation_error_as_400():
    with mock.patch("services.model_router.apply_cloud_policy", side_effect=RuntimeError("invalid routing policy")), \
         mock.patch("services.control_plane.run_lemonade_autoconfig", new=mock.AsyncMock()) as mock_autoconfig:
        response = client.post("/api/cloud/policy", json={"enabled": True})
    assert response.status_code == 400
    assert "invalid routing policy" in response.json()["detail"]
    assert not mock_autoconfig.called


def test_get_usage_endpoint():
    summary = {
        "totals": {"local_requests": 12, "cloud_requests": 3},
        "daily": [{"date": "2026-07-16", "local_requests": 12, "cloud_requests": 3}],
        "reachable": True,
    }
    with mock.patch("services.usage_metrics.get_summary", return_value=summary):
        response = client.get("/api/cloud/usage")
    assert response.status_code == 200
    assert response.json() == summary


def test_get_usage_endpoint_passes_days_query_param():
    with mock.patch("services.usage_metrics.get_summary", return_value={}) as mock_summary:
        response = client.get("/api/cloud/usage?days=30")
    assert response.status_code == 200
    mock_summary.assert_called_once_with(30)

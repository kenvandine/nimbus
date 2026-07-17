from unittest import mock
from types import SimpleNamespace

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


def test_status_endpoint_includes_raw_local_model_id_alongside_router_model_id():
    # model_id resolves to Nimbus's stable router name once it's ready;
    # local_model_id must stay the raw local model regardless, so the
    # frontend can tell them apart instead of conflating the two.
    with mock.patch("services.model_provider.current_provider", return_value="lemonade-server"), \
         mock.patch("services.model_provider.get_provider_config",
                     return_value=SimpleNamespace(model_id="user.NimbusModel", base_url="http://x")), \
         mock.patch("services.model_provider.get_state",
                     return_value=SimpleNamespace(status="ready", model="", error=None)), \
         mock.patch("services.lemonade.get_active_model_spec",
                     return_value={"model_name": "user.Qwen3.5-9B-Q4_K_M.gguf"}), \
         mock.patch("services.lemonade.get_pull_state",
                     return_value=SimpleNamespace(status="ready", model="", percent=0, file_index=0, total_files=0, error=None)), \
         mock.patch("services.lemonade.status") as mock_status:
        async def _status():
            from services.lemonade import LemonadeStatus
            return LemonadeStatus(reachable=True, base_url="http://localhost:13305")
        mock_status.side_effect = _status

        response = client.get("/api/models/status")

    assert response.status_code == 200
    data = response.json()
    assert data["model_id"] == "user.NimbusModel"
    assert data["local_model_id"] == "user.Qwen3.5-9B-Q4_K_M.gguf"

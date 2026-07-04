from unittest import mock
import pytest
from fastapi.testclient import TestClient
from models import SystemStats

# Import the app. Since it runs its lifespan on startup (which initializes LXD/openclaw),
# we patch the lifespan tasks or mock the control plane and openclaw service.
with mock.patch("services.control_plane.get_control_plane") as mock_get_control_plane, \
     mock.patch("services.openclaw.start") as mock_openclaw_start, \
     mock.patch("services.store.ensure_store") as mock_ensure_store:
     
    from main import app

client = TestClient(app)


@pytest.fixture
def mock_control_plane():
    with mock.patch("routers.system.get_control_plane") as mock_get:
        cp = mock.MagicMock()
        mock_get.return_value = cp
        yield cp


@mock.patch("services.auth.account_exists", return_value=False)
def test_oobe_complete_endpoint(mock_account_exists):
    """Test OOBE complete endpoint works when account doesn't exist yet (OOBE mode)."""
    with mock.patch("routers.system.mark_oobe_complete") as mock_mark:
        response = client.post("/api/system/oobe-complete")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
        mock_mark.assert_called_once()


@mock.patch("services.auth.account_exists", return_value=True)
def test_endpoints_require_auth_when_not_oobe(mock_account_exists):
    """Test that authenticated endpoints return 401 when account exists and no credentials are provided."""
    response = client.post("/api/system/oobe-complete")
    assert response.status_code == 401


@mock.patch("services.auth.account_exists", return_value=False)
def test_get_stats_endpoint(mock_account_exists, mock_control_plane):
    """Test the GET /api/system/stats endpoint."""
    dummy_stats = SystemStats(
        cpu_pct=12.5,
        mem_pct=45.2,
        disk_pct=60.1,
        app_count=5
    )
    # Configure mock control plane to return dummy stats (async function)
    async def mock_get_stats():
        return dummy_stats
    
    mock_control_plane.get_stats = mock_get_stats

    response = client.get("/api/system/stats")
    assert response.status_code == 200
    data = response.json()
    assert data["cpu_pct"] == 12.5
    assert data["mem_pct"] == 45.2
    assert data["disk_pct"] == 60.1
    assert data["app_count"] == 5


@mock.patch("services.auth.account_exists", return_value=False)
def test_restart_system_endpoint(mock_account_exists, mock_control_plane):
    """Test POST /api/system/restart calls the control plane."""
    async def mock_restart():
        return {"status": "restarting"}
    mock_control_plane.restart_system = mock_restart

    response = client.post("/api/system/restart")
    assert response.status_code == 200
    assert response.json() == {"status": "restarting"}

from types import SimpleNamespace
from unittest import mock

import httpx
import pytest

from services import model_router


@pytest.fixture(autouse=True)
def isolated_state(tmp_path, monkeypatch):
    """Point model_router's persisted state at a throwaway location and reset
    the in-memory ready flag between tests."""
    monkeypatch.setattr(model_router, "_STATE_PATH", tmp_path / "model_router.json")
    (tmp_path / "auth-secret").write_bytes(b"test-passphrase")
    monkeypatch.setattr(
        "config.settings",
        SimpleNamespace(installed_dir=tmp_path / "installed"),
    )
    monkeypatch.setenv("SNAP_DATA", str(tmp_path))
    model_router._router_ready = False
    yield
    model_router._router_ready = False


def _mock_response(status_code=200, json_body=None, text=""):
    resp = mock.Mock()
    resp.status_code = status_code
    resp.json.return_value = json_body or {}
    resp.text = text
    return resp


# ---------------------------------------------------------------------------
# build_routing_block — pure function
# ---------------------------------------------------------------------------

def test_build_routing_block_no_cloud_model_has_only_catch_all():
    routing = model_router.build_routing_block("user.Local-GGUF", None, {})
    assert routing["candidates"] == ["user.Local-GGUF"]
    assert routing["default_model"] == "user.Local-GGUF"
    assert routing["rules"] == [{"id": "default-local", "match": {"min_chars": 0}, "route_to": "user.Local-GGUF"}]


def test_build_routing_block_rule_order_and_catch_all_last():
    toggles = {
        "offload_tools": True,
        "offload_images": True,
        "offload_long_input": True,
        "long_input_chars": 5000,
        "offload_keywords": ["prove", "derive"],
    }
    routing = model_router.build_routing_block("user.Local-GGUF", "fireworks.kimi-k2p5", toggles)
    ids = [r["id"] for r in routing["rules"]]
    assert ids == ["tools", "images", "keywords", "long-input", "default-local"]
    assert routing["rules"][0]["match"] == {"has_tools": True}
    assert routing["rules"][1]["match"] == {"has_images": True}
    assert routing["rules"][2]["match"] == {"keywords_any": ["prove", "derive"]}
    assert routing["rules"][3]["match"] == {"min_chars": 5000}
    for r in routing["rules"][:4]:
        assert r["route_to"] == "fireworks.kimi-k2p5"
    assert routing["rules"][-1]["route_to"] == "user.Local-GGUF"
    assert routing["candidates"] == ["user.Local-GGUF", "fireworks.kimi-k2p5"]
    assert routing["default_model"] == "user.Local-GGUF"


def test_build_routing_block_toggles_off_produce_no_cloud_rules():
    routing = model_router.build_routing_block("user.Local-GGUF", "fireworks.kimi-k2p5", {})
    assert routing["rules"] == [{"id": "default-local", "match": {"min_chars": 0}, "route_to": "user.Local-GGUF"}]


def test_build_routing_block_empty_keywords_list_contributes_no_rule():
    toggles = {"offload_keywords": ["", "  "]}
    routing = model_router.build_routing_block("user.Local-GGUF", "fireworks.kimi-k2p5", toggles)
    assert not any(r["id"] == "keywords" for r in routing["rules"])


def test_build_router_collection_body_includes_version_and_components():
    routing = {"candidates": ["a", "b"], "default_model": "a", "rules": []}
    body = model_router.build_router_collection_body("a", "b", routing)
    assert body["version"] == "1"
    assert body["model_name"] == model_router.ROUTER_MODEL_NAME
    assert body["recipe"] == "collection.router"
    assert body["components"] == ["a", "b"]
    assert body["routing"] is routing


def test_build_router_collection_body_no_cloud_model_single_component():
    routing = {"candidates": ["a"], "default_model": "a", "rules": []}
    body = model_router.build_router_collection_body("a", None, routing)
    assert body["components"] == ["a"]


# ---------------------------------------------------------------------------
# register_router_collection / is_ready gating
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_register_router_collection_success_sets_ready():
    routing = model_router.build_routing_block("a", None, {})
    with mock.patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = mock.AsyncMock()
        mock_client.post.return_value = _mock_response(200, {})
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        assert model_router.is_ready() is False
        await model_router.register_router_collection("a", None, routing)
    assert model_router.is_ready() is True


@pytest.mark.asyncio
async def test_register_router_collection_failure_raises_and_leaves_ready_state():
    routing = model_router.build_routing_block("a", None, {})
    with mock.patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = mock.AsyncMock()
        mock_client.post.return_value = _mock_response(400, text="invalid policy")
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        with pytest.raises(RuntimeError, match="invalid policy"):
            await model_router.register_router_collection("a", None, routing)
    assert model_router.is_ready() is False


@pytest.mark.asyncio
async def test_register_router_collection_failure_does_not_erase_prior_ready_state():
    model_router._router_ready = True
    routing = model_router.build_routing_block("a", None, {})
    with mock.patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = mock.AsyncMock()
        mock_client.post.return_value = _mock_response(400, text="invalid policy")
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        with pytest.raises(RuntimeError):
            await model_router.register_router_collection("a", None, routing)
    assert model_router.is_ready() is True


# ---------------------------------------------------------------------------
# Cloud provider registration
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_register_cloud_provider_calls_install_with_api_key():
    with mock.patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = mock.AsyncMock()
        mock_client.post.return_value = _mock_response(200, {"models_discovered": 3})
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        result = await model_router.register_cloud_provider(
            "fireworks", "https://api.fireworks.ai/inference/v1", "fw-secret", "Fireworks"
        )

    assert result == {"models_discovered": 3}
    call = mock_client.post.call_args
    assert call.args[0].endswith("/api/v1/install")
    assert call.kwargs["json"] == {
        "backend": "cloud",
        "provider": "fireworks",
        "base_url": "https://api.fireworks.ai/inference/v1",
        "api_key": "fw-secret",
    }
    providers = model_router.list_providers()
    assert providers == [{"provider": "fireworks", "display_name": "Fireworks", "base_url": "https://api.fireworks.ai/inference/v1"}]


@pytest.mark.asyncio
async def test_register_cloud_provider_persists_even_on_lemonade_error():
    with mock.patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = mock.AsyncMock()
        mock_client.post.return_value = _mock_response(500, text="boom")
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        with pytest.raises(RuntimeError):
            await model_router.register_cloud_provider(
                "fireworks", "https://api.fireworks.ai/inference/v1", "fw-secret", "Fireworks"
            )

    providers = model_router.list_providers()
    assert len(providers) == 1
    assert providers[0]["provider"] == "fireworks"


def test_list_providers_never_returns_api_key():
    model_router._save_providers({"fireworks": {"display_name": "Fireworks", "base_url": "u", "api_key": "secret"}})
    providers = model_router.list_providers()
    assert "api_key" not in providers[0]


# ---------------------------------------------------------------------------
# Orchestration: reconcile_on_startup / reconcile_local_model_change
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_reconcile_on_startup_never_raises_on_httpx_error():
    with mock.patch("httpx.AsyncClient") as mock_client_cls:
        mock_client_cls.side_effect = httpx.ConnectError("connection refused")
        with mock.patch.object(model_router.lemonade, "get_active_model_spec", return_value={"model_name": "user.Local"}):
            await model_router.reconcile_on_startup()  # must not raise
    assert model_router.is_ready() is False


@pytest.mark.asyncio
async def test_reconcile_on_startup_registers_collection_when_no_providers():
    with mock.patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = mock.AsyncMock()
        mock_client.post.return_value = _mock_response(200, {})
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        with mock.patch.object(model_router.lemonade, "get_active_model_spec", return_value={"model_name": "user.Local"}):
            await model_router.reconcile_on_startup()
    assert model_router.is_ready() is True


@pytest.mark.asyncio
async def test_reconcile_local_model_change_rebuilds_with_new_local_model():
    model_router._save_state({
        **model_router._DEFAULT_STATE,
        "cloud_offload_enabled": True,
        "cloud_model": "fireworks.kimi-k2p5",
        "toggles": {**model_router._DEFAULT_STATE["toggles"], "offload_tools": True},
    })
    with mock.patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = mock.AsyncMock()
        mock_client.post.return_value = _mock_response(200, {})
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        await model_router.reconcile_local_model_change("user.NewLocal-GGUF")

        body = mock_client.post.call_args.kwargs["json"]
    assert body["components"] == ["user.NewLocal-GGUF", "fireworks.kimi-k2p5"]
    assert body["routing"]["default_model"] == "user.NewLocal-GGUF"
    assert any(r["id"] == "tools" for r in body["routing"]["rules"])


@pytest.mark.asyncio
async def test_reconcile_local_model_change_never_raises():
    with mock.patch("httpx.AsyncClient") as mock_client_cls:
        mock_client_cls.side_effect = httpx.ConnectError("down")
        await model_router.reconcile_local_model_change("user.NewLocal-GGUF")  # must not raise


# ---------------------------------------------------------------------------
# apply_cloud_policy
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_apply_cloud_policy_raises_on_failure_and_persists_state_first():
    with mock.patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = mock.AsyncMock()
        mock_client.post.return_value = _mock_response(400, text="bad policy")
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        with mock.patch.object(model_router.lemonade, "get_active_model_spec", return_value={"model_name": "user.Local"}):
            with pytest.raises(RuntimeError):
                await model_router.apply_cloud_policy(
                    True, "fireworks", "fireworks.kimi-k2p5", {"offload_tools": True}, None
                )
    state = model_router.get_state()
    assert state["cloud_offload_enabled"] is True
    assert state["cloud_model"] == "fireworks.kimi-k2p5"


@pytest.mark.asyncio
async def test_apply_cloud_policy_disable_drops_cloud_candidate():
    with mock.patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = mock.AsyncMock()
        mock_client.post.return_value = _mock_response(200, {})
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        with mock.patch.object(model_router.lemonade, "get_active_model_spec", return_value={"model_name": "user.Local"}):
            await model_router.apply_cloud_policy(False, "fireworks", "fireworks.kimi-k2p5", {}, None)
        body = mock_client.post.call_args.kwargs["json"]
    assert body["components"] == ["user.Local"]

from unittest import mock

import pytest

from services import usage_metrics


@pytest.fixture(autouse=True)
def isolated_state(tmp_path, monkeypatch):
    monkeypatch.setattr(usage_metrics, "_STATE_PATH", tmp_path / "usage_metrics.json")
    usage_metrics._reachable = False
    yield


_SCRAPE_BODY = """\
# HELP lemonade_model_requests_total Cumulative inference requests observed for a model.
# TYPE lemonade_model_requests_total counter
lemonade_model_requests_total{checkpoint="unsloth/Qwen3.6-27B-MTP-GGUF:Q4",device="gpu",model_name="user.Local-GGUF",recipe="llamacpp",type="llm"} 5
lemonade_model_requests_total{checkpoint="n/a",device="cpu",model_name="fireworks.kimi-k2p5",recipe="cloud",type="llm"} 2
lemonade_model_requests_total{checkpoint="n/a",device="cpu",model_name="user.Other-Embedding",recipe="llamacpp",type="embedding"} 9
"""


# ---------------------------------------------------------------------------
# Prometheus line parsing
# ---------------------------------------------------------------------------

def test_parse_model_request_counts():
    counts = usage_metrics.parse_model_request_counts(_SCRAPE_BODY)
    assert counts == {
        "user.Local-GGUF": 5.0,
        "fireworks.kimi-k2p5": 2.0,
        "user.Other-Embedding": 9.0,
    }


def test_parse_model_request_counts_ignores_unrelated_metric_families():
    body = '# HELP lemonade_server_up\nlemonade_server_up 1\n'
    assert usage_metrics.parse_model_request_counts(body) == {}


# ---------------------------------------------------------------------------
# scrape_once — classification, accumulation, resets
# ---------------------------------------------------------------------------

async def _scrape_with(scrape_text, local_model, cloud_model, cloud_enabled=True):
    resp = mock.Mock(status_code=200, text=scrape_text)
    with mock.patch("httpx.AsyncClient") as mock_client_cls, \
         mock.patch("services.usage_metrics.lemonade.get_active_model_spec",
                     return_value={"model_name": local_model}), \
         mock.patch("services.usage_metrics.model_router.get_state", return_value={
             "cloud_offload_enabled": cloud_enabled, "cloud_model": cloud_model,
         }):
        mock_client = mock.AsyncMock()
        mock_client.get.return_value = resp
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        await usage_metrics.scrape_once()


@pytest.mark.asyncio
async def test_scrape_once_classifies_local_and_cloud_and_ignores_others():
    await _scrape_with(_SCRAPE_BODY, "user.Local-GGUF", "fireworks.kimi-k2p5")
    summary = usage_metrics.get_summary(days=1)
    assert summary["totals"]["local_requests"] == 5
    assert summary["totals"]["cloud_requests"] == 2
    assert summary["reachable"] is True
    assert summary["daily"][-1]["local_requests"] == 5
    assert summary["daily"][-1]["cloud_requests"] == 2


@pytest.mark.asyncio
async def test_scrape_once_ignores_cloud_model_when_offload_disabled():
    await _scrape_with(_SCRAPE_BODY, "user.Local-GGUF", "fireworks.kimi-k2p5", cloud_enabled=False)
    summary = usage_metrics.get_summary(days=1)
    assert summary["totals"]["local_requests"] == 5
    assert summary["totals"]["cloud_requests"] == 0


@pytest.mark.asyncio
async def test_scrape_once_accumulates_deltas_across_polls():
    first = _SCRAPE_BODY
    second = _SCRAPE_BODY.replace('model_name="user.Local-GGUF"', 'model_name="user.Local-GGUF"').replace(" 5\n", " 8\n").replace(" 2\n", " 6\n")
    await _scrape_with(first, "user.Local-GGUF", "fireworks.kimi-k2p5")
    await _scrape_with(second, "user.Local-GGUF", "fireworks.kimi-k2p5")
    summary = usage_metrics.get_summary(days=1)
    assert summary["totals"]["local_requests"] == 8
    assert summary["totals"]["cloud_requests"] == 6


@pytest.mark.asyncio
async def test_scrape_once_treats_counter_reset_as_fresh_baseline():
    high = _SCRAPE_BODY.replace(" 5\n", " 50\n")
    await _scrape_with(high, "user.Local-GGUF", "fireworks.kimi-k2p5")
    assert usage_metrics.get_summary(days=1)["totals"]["local_requests"] == 50

    reset = _SCRAPE_BODY.replace(" 5\n", " 3\n")
    await _scrape_with(reset, "user.Local-GGUF", "fireworks.kimi-k2p5")
    assert usage_metrics.get_summary(days=1)["totals"]["local_requests"] == 53


@pytest.mark.asyncio
async def test_scrape_once_local_model_switch_keeps_accumulating_under_local_bucket():
    await _scrape_with(_SCRAPE_BODY, "user.Local-GGUF", "fireworks.kimi-k2p5")
    switched = _SCRAPE_BODY.replace("user.Local-GGUF", "user.New-Local-GGUF")
    await _scrape_with(switched, "user.New-Local-GGUF", "fireworks.kimi-k2p5")
    summary = usage_metrics.get_summary(days=1)
    # Old name's 5 plus new name's first-seen 5 (its own baseline starts at 0).
    assert summary["totals"]["local_requests"] == 10


@pytest.mark.asyncio
async def test_scrape_once_matches_local_model_when_lemonade_strips_user_prefix():
    # lemonade reports a locally-registered model's requests under its
    # 'user.'-stripped name in /metrics, even though the prefixed name is
    # what's actually used for registration/routing (confirmed live).
    body = (
        '# TYPE lemonade_model_requests_total counter\n'
        'lemonade_model_requests_total{model_name="Local-GGUF",recipe="llamacpp"} 7\n'
    )
    await _scrape_with(body, "user.Local-GGUF", None, cloud_enabled=False)
    assert usage_metrics.get_summary(days=1)["totals"]["local_requests"] == 7


@pytest.mark.asyncio
async def test_scrape_once_marks_unreachable_on_http_error():
    with mock.patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = mock.AsyncMock()
        mock_client.get.side_effect = Exception("connection refused")
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        await usage_metrics.scrape_once()
    assert usage_metrics.get_summary(days=1)["reachable"] is False


# ---------------------------------------------------------------------------
# get_summary — day-window shape and pruning
# ---------------------------------------------------------------------------

def test_get_summary_zero_fills_days_with_no_data():
    summary = usage_metrics.get_summary(days=5)
    assert len(summary["daily"]) == 5
    assert all(d["local_requests"] == 0 and d["cloud_requests"] == 0 for d in summary["daily"])


def test_save_state_prunes_daily_to_retention_window():
    state = usage_metrics._load_state()
    for i in range(40):
        state["daily"][f"2026-01-{i + 1:02d}" if i < 31 else f"2026-02-{i - 30:02d}"] = {
            "local_requests": 1, "cloud_requests": 0,
        }
    usage_metrics._save_state(state)
    assert len(usage_metrics._load_state()["daily"]) == usage_metrics._DAYS_RETAINED

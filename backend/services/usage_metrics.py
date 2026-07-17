"""Local-vs-cloud inference request counts, scraped from lemonade's own
Prometheus endpoint (`GET /metrics`).

Nimbus never sits in the chat-completion request path (claw apps talk to
lemonade directly), so it cannot count requests itself. Lemonade already
tracks per-model cumulative counters (`lemonade_model_requests_total{model_name=...}`)
that this module polls, classifies against the two names Nimbus itself
registered as router candidates (services.model_router), and accumulates
into a durable local/cloud split — without touching lemonade's OpenTelemetry
tracing path (opt-in, and would include raw prompt/response content).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from services import lemonade, model_router

logger = logging.getLogger(__name__)

_state_dir = os.getenv("SNAP_COMMON", "/var/lib/nimbus")
_STATE_PATH = Path(_state_dir) / "usage_metrics.json"

_DEFAULT_STATE: dict = {
    "totals": {
        "local_requests": 0,
        "cloud_requests": 0,
        "local_input_tokens": 0,
        "local_output_tokens": 0,
        "cloud_input_tokens": 0,
        "cloud_output_tokens": 0,
    },
    "daily": {},
    "last_seen": {},
}

_DAYS_RETAINED = 30
_POLL_INTERVAL = 60  # seconds

_REQUESTS_LINE_RE = re.compile(r"^lemonade_model_requests_total\{([^}]*)\}\s+([0-9eE.+-]+)$")
_MODEL_NAME_RE = re.compile(r'model_name="([^"]*)"')

_reachable: bool = False


def _load_state() -> dict:
    try:
        data = json.loads(_STATE_PATH.read_text())
    except FileNotFoundError:
        return json.loads(json.dumps(_DEFAULT_STATE))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Could not read usage_metrics.json: %s", exc)
        return json.loads(json.dumps(_DEFAULT_STATE))
    merged = json.loads(json.dumps(_DEFAULT_STATE))
    merged.update(data)
    merged["totals"] = {**_DEFAULT_STATE["totals"], **(data.get("totals") or {})}
    merged["daily"] = data.get("daily") or {}
    merged["last_seen"] = data.get("last_seen") or {}
    return merged


def _save_state(state: dict) -> None:
    if len(state["daily"]) > _DAYS_RETAINED:
        for day in sorted(state["daily"])[: len(state["daily"]) - _DAYS_RETAINED]:
            del state["daily"][day]
    _STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _STATE_PATH.write_text(json.dumps(state, indent=2))


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def parse_model_request_counts(scrape_text: str) -> dict[str, float]:
    """Parse `lemonade_model_requests_total{model_name="...",...} <value>` lines
    from a Prometheus text-exposition scrape into {model_name: raw_value}."""
    counts: dict[str, float] = {}
    for line in scrape_text.splitlines():
        m = _REQUESTS_LINE_RE.match(line.strip())
        if not m:
            continue
        labels, value = m.group(1), m.group(2)
        name_match = _MODEL_NAME_RE.search(labels)
        if not name_match:
            continue
        try:
            counts[name_match.group(1)] = float(value)
        except ValueError:
            continue
    return counts


def _accumulate(state: dict, model_name: str, raw: float, bucket: str) -> None:
    last_seen = state["last_seen"].get(model_name, 0)
    delta = raw - last_seen if raw >= last_seen else raw
    state["last_seen"][model_name] = raw
    if delta <= 0:
        return
    state["totals"][f"{bucket}_requests"] += delta
    day = state["daily"].setdefault(_today(), {"local_requests": 0, "cloud_requests": 0})
    day[f"{bucket}_requests"] += delta


def _match_count(counts: dict[str, float], name: str) -> tuple[str, float] | None:
    """Match a Nimbus-registered model name against lemonade's scraped counters.

    lemonade strips the 'user.' namespace prefix in its own reporting surfaces
    (GET /metrics model_name label, GET /v1/models id field) even though the
    prefixed name is what's actually used for registration and routing —
    confirmed live: a model registered as 'user.Qwen3.5-9B-Q4_K_M.gguf' is
    reported in /metrics as 'Qwen3.5-9B-Q4_K_M.gguf'. Try the exact name
    first (cloud model ids are never 'user.'-prefixed, so this is normally
    what matches for those), then the stripped form.
    """
    if name in counts:
        return name, counts[name]
    stripped = name.removeprefix("user.")
    if stripped != name and stripped in counts:
        return stripped, counts[stripped]
    return None


async def scrape_once() -> None:
    global _reachable
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{lemonade.LEMONADE_BASE_URL}/metrics")
        if r.status_code != 200:
            _reachable = False
            return
        counts = parse_model_request_counts(r.text)
        _reachable = True
    except Exception as exc:
        logger.warning("Could not scrape lemonade /metrics: %s", exc)
        _reachable = False
        return

    local_model = lemonade.get_active_model_spec().get("model_name")
    router_state = model_router.get_state()
    cloud_model = router_state.get("cloud_model") if router_state.get("cloud_offload_enabled") else None

    state = _load_state()
    local_match = _match_count(counts, local_model) if local_model else None
    if local_match:
        key, raw = local_match
        _accumulate(state, key, raw, "local")
    cloud_match = _match_count(counts, cloud_model) if cloud_model else None
    if cloud_match:
        key, raw = cloud_match
        _accumulate(state, key, raw, "cloud")
    _save_state(state)


def get_summary(days: int = 14) -> dict:
    state = _load_state()
    daily_map = state["daily"]
    today = datetime.now(timezone.utc).date()
    daily = []
    for offset in range(days - 1, -1, -1):
        day = (today - timedelta(days=offset)).isoformat()
        entry = daily_map.get(day, {})
        daily.append({
            "date": day,
            "local_requests": entry.get("local_requests", 0),
            "cloud_requests": entry.get("cloud_requests", 0),
        })
    return {"totals": state["totals"], "daily": daily, "reachable": _reachable}


async def poll_loop() -> None:
    while True:
        await scrape_once()
        await asyncio.sleep(_POLL_INTERVAL)

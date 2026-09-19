"""Live-city adapter — the flag-flip that turns the replay into the city.

``StormReplay`` consumes a rain/tide series shaped like ``storm_replay.json``.
This module produces the same shape from live sources, so nothing else in
the pipeline changes:

    FLOODLIGHT_MODE=live \
    MCGM_RAIN_URL=<json endpoint> python run.py

MCGM's disaster-management portal (dm.mcgm.gov.in) publishes AWS station
rainfall the city already collects every 15 minutes, but offers no
*documented* public API — endpoints observed in the portal's own network
traffic have shifted between monsoons. The poller therefore takes its URL
and field mapping from the environment, and degrades gracefully: when the
feed is unreachable it emits zero-rain windows and flags itself DEGRADED
rather than inventing weather.
"""

from __future__ import annotations

import asyncio
import json
import os
import urllib.request
from dataclasses import dataclass, field


@dataclass
class LiveWindow:
    rain_mm: float
    tide_m: float
    degraded: bool = False


@dataclass
class LiveMCGMFeed:
    """Polls a rainfall endpoint and yields 15-minute windows.

    Field mapping is configured by env so a changed portal schema is a
    config change, not a code change:

      MCGM_RAIN_URL    JSON endpoint returning station readings
      MCGM_RAIN_FIELD  key holding mm-per-15-min (default: "rainfall")
      TIDE_TABLE       comma list of today's tide heights by hour (fallback)
    """

    url: str = field(default_factory=lambda: os.environ.get("MCGM_RAIN_URL", ""))
    rain_field: str = field(default_factory=lambda: os.environ.get("MCGM_RAIN_FIELD", "rainfall"))
    stations: list[str] = field(default_factory=lambda: [
        s for s in os.environ.get("MCGM_STATIONS", "Parel,Dadar").split(",") if s
    ])

    def _fetch(self) -> float | None:
        if not self.url:
            return None
        req = urllib.request.Request(self.url, headers={"User-Agent": "floodlight-node/0.2"})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.load(r)
        rows = data if isinstance(data, list) else data.get("data", data.get("result", []))
        vals = []
        for row in rows:
            name = str(row.get("station", row.get("name", "")))
            if self.stations and not any(s.lower() in name.lower() for s in self.stations):
                continue
            try:
                vals.append(float(row.get(self.rain_field, 0) or 0))
            except (TypeError, ValueError):
                continue
        return max(vals) if vals else None

    def _tide_now(self) -> float:
        import datetime
        table = os.environ.get("TIDE_TABLE", "")
        if table:
            hours = [float(x) for x in table.split(",")]
            return hours[datetime.datetime.now().hour % len(hours)]
        return 2.5                                          # neutral fallback

    async def window(self) -> LiveWindow:
        loop = asyncio.get_running_loop()
        try:
            rain = await loop.run_in_executor(None, self._fetch)
            if rain is None:
                return LiveWindow(0.0, self._tide_now(), degraded=True)
            return LiveWindow(rain, self._tide_now())
        except Exception:
            return LiveWindow(0.0, self._tide_now(), degraded=True)


def live_mode_enabled() -> bool:
    return os.environ.get("FLOODLIGHT_MODE", "replay").lower() == "live"

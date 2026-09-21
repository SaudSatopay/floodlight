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


# --------------------------------------------------------------------------
# Open-Meteo: genuinely live rainfall, no key, 15-minutely — the default
# source for the dashboard's LIVE CITY view.
# --------------------------------------------------------------------------

def fetch_open_meteo(lat: float, lng: float) -> dict:
    """Past 3 h + next 2 h of 15-minutely precipitation for a point, PLUS
    the sky right now (cloud cover, condition) and a 12-hour hourly outlook
    (rain, probability, cloud) — all in one keyless call.

    Returns {"past": [12 × mm], "now": mm, "next": [8 × mm], "time": iso,
             "cloud_now": %, "code_now": wmo, "hours": [12 × {t, mm, prob,
             cloud, code}]}. Raises on network failure — callers degrade.
    """
    url = ("https://api.open-meteo.com/v1/forecast"
           f"?latitude={lat:.4f}&longitude={lng:.4f}"
           "&minutely_15=precipitation&past_minutely_15=12&forecast_minutely_15=9"
           "&current=cloud_cover,weather_code"
           "&hourly=precipitation,precipitation_probability,cloud_cover,weather_code"
           "&forecast_hours=12"
           "&timezone=Asia%2FKolkata")
    req = urllib.request.Request(url, headers={"User-Agent": "floodlight/0.3"})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.load(r)
    vals = [float(v or 0) for v in data["minutely_15"]["precipitation"]]
    times = data["minutely_15"]["time"]
    cur = data.get("current", {})
    hh = data.get("hourly", {})
    ht = hh.get("time", [])
    hours = []
    for i, t in enumerate(ht[:12]):
        def _pick(key, default=0):
            arr = hh.get(key, [])
            return arr[i] if i < len(arr) and arr[i] is not None else default
        hours.append({
            "t": t[-5:],                                   # "…T15:00" → "15:00"
            "mm": round(float(_pick("precipitation")), 2),
            "prob": int(_pick("precipitation_probability")),
            "cloud": int(_pick("cloud_cover")),
            "code": int(_pick("weather_code")),
        })
    return {"past": vals[:12], "now": vals[12] if len(vals) > 12 else 0.0,
            "next": vals[13:], "time": times[12] if len(times) > 12 else "",
            "cloud_now": int(cur.get("cloud_cover", 0) or 0),
            "code_now": int(cur.get("weather_code", 0) or 0),
            "hours": hours}


# WMO weather interpretation codes → the words a ward officer would use.
WMO_LABELS = {
    0: "clear sky", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
    45: "fog", 48: "fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain",
    80: "rain showers", 81: "heavy showers", 82: "violent showers",
    95: "thunderstorm", 96: "thunderstorm + hail", 99: "thunderstorm + hail",
}


def wmo_label(code: int) -> str:
    return WMO_LABELS.get(int(code), "rain")


def summarize_outlook(rain_now: float, cloud_now: int, hours: list[dict]) -> dict:
    """Classify the next 12 hours into one verdict the dashboard can SHOW.

    Pure function (unit-tested, no network). Levels, in escalating order:
    clear · cloudy · overcast · rain-soon · storm-inbound · raining · storm-now.
    """
    hrs = hours[:12]
    next6 = round(sum(h["mm"] for h in hrs[:6]), 1)
    next12 = round(sum(h["mm"] for h in hrs), 1)
    prob_max = max([h["prob"] for h in hrs], default=0)
    peak = max(hrs, key=lambda h: h["mm"], default=None)

    # first hour that qualifies as a real storm / as any rain
    hit = next((h for h in hrs if h["mm"] >= 2.5
                or (h["prob"] >= 70 and h["mm"] >= 0.8)
                or (h["code"] >= 95 and h["prob"] >= 50)), None)
    soon = next((h for h in hrs if h["mm"] >= 0.3 or h["prob"] >= 55), None)

    def eta(h):
        i = hrs.index(h)
        return i, ("within the hour" if i == 0 else f"in ~{i} h")

    if rain_now >= 4.0:
        level, headline = "storm-now", f"HEAVY RAIN NOW · {rain_now:.1f} MM/15 MIN"
        detail = f"{next6:.1f} mm more expected in the next 6 h · peak {peak['mm']:.1f} mm/h ~{peak['t']}" if peak else ""
        eta_h, eta_txt = 0, "now"
    elif rain_now >= 0.2:
        level, headline = "raining", "RAIN FALLING NOW"
        detail = f"{next6:.1f} mm more expected in the next 6 h · {prob_max}% chance it continues"
        eta_h, eta_txt = 0, "now"
    elif hit:
        eta_h, eta_txt = eta(hit)
        level = "storm-inbound"
        headline = f"{wmo_label(hit['code']).upper()} EXPECTED ~{hit['t']}"
        detail = (f"{next6:.1f} mm in the next 6 h · up to {peak['mm']:.1f} mm/h ~{peak['t']}"
                  f" · {prob_max}% chance" if peak else f"{prob_max}% chance")
    elif soon:
        eta_h, eta_txt = eta(soon)
        level = "rain-soon"
        headline = f"RAIN LIKELY FROM ~{soon['t']}"
        detail = f"{next12:.1f} mm over the next 12 h · {prob_max}% chance"
    elif cloud_now >= 70:
        level, headline = "overcast", f"OVERCAST · {cloud_now}% CLOUD"
        detail = "no significant rain reaching the ground in the next 12 h"
        eta_h, eta_txt = -1, ""
    elif cloud_now >= 35:
        level, headline = "cloudy", f"PARTLY CLOUDY · {cloud_now}%"
        detail = "no rain expected in the next 12 h"
        eta_h, eta_txt = -1, ""
    else:
        level, headline = "clear", "CLEAR SKIES"
        detail = "no rain expected in the next 12 h"
        eta_h, eta_txt = -1, ""

    return {"level": level, "headline": headline, "detail": detail,
            "eta_h": eta_h, "eta_txt": eta_txt,
            "next6_mm": next6, "next12_mm": next12, "prob_max": prob_max,
            "peak_mm": peak["mm"] if peak else 0.0,
            "peak_t": peak["t"] if peak else ""}


def fetch_open_meteo_grid(points: list[tuple[float, float]]) -> list[dict]:
    """Current precipitation AND the next-6-h forecast total for MANY points
    in one call (Open-Meteo accepts comma-separated coordinate lists) —
    feeds the live rain heatmap in both its NOW and FORECAST modes."""
    lats = ",".join(f"{p[0]:.3f}" for p in points)
    lngs = ",".join(f"{p[1]:.3f}" for p in points)
    url = ("https://api.open-meteo.com/v1/forecast"
           f"?latitude={lats}&longitude={lngs}"
           "&current=precipitation,cloud_cover&hourly=precipitation&forecast_hours=6"
           "&timezone=Asia%2FKolkata")
    req = urllib.request.Request(url, headers={"User-Agent": "floodlight/0.4"})
    with urllib.request.urlopen(req, timeout=25) as r:
        data = json.load(r)
    rows = data if isinstance(data, list) else [data]
    out = []
    for p, row in zip(points, rows):
        cur = row.get("current", {})
        mm = float(cur.get("precipitation", 0) or 0)
        fc = [float(v or 0) for v in row.get("hourly", {}).get("precipitation", [])]
        out.append({"lat": p[0], "lng": p[1], "mm": mm,
                    "next6": round(sum(fc[:6]), 1),
                    "cloud": int(cur.get("cloud_cover", 0) or 0)})
    return out


def mumbai_grid() -> list[tuple[float, float]]:
    """A coarse grid over the whole Mumbai Metropolitan Region — island
    city to Dahisar, Kurla to Mulund, and across the creek to Thane and
    Mira-Bhayandar — for the live rain heatmap."""
    pts = []
    lat0, lat1, lng0, lng1 = 18.90, 19.48, 72.76, 73.06
    for i in range(7):
        for j in range(6):
            pts.append((round(lat0 + (lat1 - lat0) * i / 6, 3),
                        round(lng0 + (lng1 - lng0) * j / 5, 3)))
    return pts


def fetch_open_meteo_region(points: list[tuple[float, float]]) -> list[dict]:
    """Past-3h + current precipitation for several points (area centres)
    in ONE call — powers the MMR coverage strip."""
    lats = ",".join(f"{p[0]:.4f}" for p in points)
    lngs = ",".join(f"{p[1]:.4f}" for p in points)
    url = ("https://api.open-meteo.com/v1/forecast"
           f"?latitude={lats}&longitude={lngs}"
           "&minutely_15=precipitation&past_minutely_15=12&forecast_minutely_15=5"
           "&current=cloud_cover&hourly=precipitation&forecast_hours=6"
           "&timezone=Asia%2FKolkata")
    req = urllib.request.Request(url, headers={"User-Agent": "floodlight/0.5"})
    with urllib.request.urlopen(req, timeout=25) as r:
        data = json.load(r)
    rows = data if isinstance(data, list) else [data]
    out = []
    for p, row in zip(points, rows):
        vals = [float(v or 0) for v in row.get("minutely_15", {}).get("precipitation", [0] * 13)]
        fc = [float(v or 0) for v in row.get("hourly", {}).get("precipitation", [])]
        out.append({"lat": p[0], "lng": p[1],
                    "past": vals[:12], "now": vals[12] if len(vals) > 12 else 0.0,
                    "next": vals[13:], "next6_mm": round(sum(fc[:6]), 1),
                    "fc_hours": fc[:6],
                    "cloud": int(row.get("current", {}).get("cloud_cover", 0) or 0)})
    return out


def tide_estimate() -> float:
    """Approximate semidiurnal tide for Mumbai (labelled EST in the UI) —
    a 12.4 h cycle between ~1.2 m and ~4.4 m. Good enough to show the
    outfall-lock concept live; production reads the port tide table."""
    import datetime, math
    now = datetime.datetime.now()
    hours = now.hour + now.minute / 60.0
    phase = (hours % 12.42) / 12.42 * 2 * math.pi
    return round(2.8 + 1.6 * math.sin(phase), 1)

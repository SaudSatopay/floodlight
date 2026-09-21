"""Storm-replay orchestrator — any pilot AREA × any STORM, one pipeline:

    gauges → expected model → crowd reports → twin-cause verdicts
           → street alerts (with lead time) → ward dispatches

Areas (road-snapped OSM corridors, each with its own drains and a
notoriously blocked one):  Hindmata–Parel · Milan Subway–Andheri ·
King's Circle–Sion.

Storms (15-min AWS cadence, synthesized from records of the real days):
2026 cloudburst · 26 July 2005 peak window · 29 Aug 2017 peak window ·
a Quiet Tuesday that must stay silent.

Flagship combinations carry hand-authored crowd scripts; every other
pairing gets deterministic traffic from ``crowd_gen`` — so a judge can
throw any storm at any ward and the story still plays.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from .alerts import Alert, dispatch_card, street_alert, watch_alert
from .crowd_gen import generate as generate_crowd
from .hydrology import Segment, project_crossing, step_depth_cm, tide_lock
from .twin_cause import DrainState, classify

DATA = Path(__file__).resolve().parent.parent / "data"
STATIC = Path(__file__).resolve().parent.parent / "static"
AREAS_DIR = DATA / "areas"

STORMS = {
    "cloudburst": {"label": "08 July 2026 cloudburst · 205 mm", "storm": "storm_replay.json"},
    "monsoon-2005": {"label": "26 July 2005 · the 944 mm day", "storm": "storm_2005.json"},
    "monsoon-2017": {"label": "29 Aug 2017 · ~331 mm", "storm": "storm_2017.json"},
    "quiet": {"label": "Quiet Tuesday · 75 mm (zero-alarm test)", "storm": "storm_quiet.json"},
}

# Hand-authored crowd scripts for the flagship combinations.
CURATED = {
    ("hindmata", "cloudburst"): "crowd_script.json",
    ("hindmata", "quiet"): "crowd_quiet.json",
}


def _load_areas() -> dict:
    areas = {}
    for d in sorted(AREAS_DIR.iterdir()):
        if not (d / "drains.json").exists():
            continue
        meta = json.loads((d / "drains.json").read_text(encoding="utf-8"))
        areas[d.name] = {
            "label": meta.get("label", d.name),
            "center": meta.get("center", [19.01, 72.84]),
            "zoom": meta.get("zoom", 15),
            "sensor_seg": meta.get("sensor_seg"),
            "blocked": meta.get("blocked"),
            "dir": d,
        }
    return areas


AREAS = _load_areas()

NOWCAST_WINDOWS = 2
OBSERVATION_FRESH_WINDOWS = 3
LIVE_SENSOR_FRESH_S = 60.0
COVERAGE_RADIUS_M = 750.0        # tap-risk answers only near a monitored street


def _minutes(step: int) -> int:
    return step * 15


def _cv_annotate(report: dict) -> None:
    photo = report.get("photo")
    if not photo:
        return
    try:
        from .cv_depth import estimate_depth
        est = estimate_depth(STATIC / photo)
        if est:
            report["cv"] = est
            if not report.get("depth_cm"):
                report["depth_cm"] = est["depth_cm"]
    except Exception:
        report.setdefault("cv", None)


class StormReplay:
    """Owns all live state for one replay run. One instance per server."""

    def __init__(self, storm_id: str = "cloudburst", area_id: str = "hindmata") -> None:
        self.load(area_id, storm_id)

    # ------------------------------------------------------------------ load

    def load(self, area_id: str, storm_id: str) -> None:
        if area_id not in AREAS:
            area_id = "hindmata"
        if storm_id not in STORMS:
            storm_id = "cloudburst"
        self.area_id, self.storm_id = area_id, storm_id
        area = AREAS[area_id]

        geo = json.loads((area["dir"] / "segments.geojson").read_text(encoding="utf-8"))
        drains_raw = json.loads((area["dir"] / "drains.json").read_text(encoding="utf-8"))
        self.geojson = geo
        self.segments = {}
        for f in geo["features"]:
            p = f["properties"]
            self.segments[p["id"]] = Segment(
                id=p["id"], name=p["name"], bowl=p["bowl"],
                drain_id=p["drain_id"], subscribers=p["subscribers"],
            )
        self.drains = {
            d["id"]: DrainState(id=d["id"], name=d["name"], capacity_mm=d["capacity_mm"])
            for d in drains_raw["drains"]
        }
        self.drain_points = drains_raw["drains"]
        self.sensor_seg = area["sensor_seg"] or next(iter(self.segments))
        self.blocked_drain = area["blocked"]

        self.storm = json.loads((DATA / STORMS[storm_id]["storm"]).read_text(encoding="utf-8"))
        curated = CURATED.get((area_id, storm_id))
        if curated:
            self.script = json.loads((DATA / curated).read_text(encoding="utf-8"))
        else:
            self.script = generate_crowd(self.segments, self.drain_points, self.storm,
                                         self.sensor_seg, self.blocked_drain)
        self.reset()

    def reset(self, storm_id: str | None = None, area_id: str | None = None) -> None:
        if (storm_id and storm_id != self.storm_id) or (area_id and area_id != self.area_id):
            self.load(area_id or self.area_id, storm_id or self.storm_id)
            return
        self.step = -1
        self.expected = {s: 0.0 for s in self.segments}
        self.observed: dict[str, tuple[int, float] | None] = {s: None for s in self.segments}
        self.alerted: set[str] = set()
        self.watched: set[str] = set()
        self.blocked_badge: set[str] = set()
        self.alerts: list[Alert] = []
        self.reports: list[dict] = []
        self.dispatches: list[dict] = []
        self.injected: list[dict] = []
        self.live_sensor: dict[str, tuple[float, float]] = {}
        self._aid = 0
        for d in self.drains.values():
            d.blockage_belief = 0.05
            d.evidence = []
            d.dispatched = False

    def _next_id(self) -> str:
        self._aid += 1
        return f"a{self._aid:03d}"

    @property
    def finished(self) -> bool:
        return self.step >= len(self.storm["rain_mm"]) - 1

    def clock(self, step: int | None = None) -> str:
        s = self.step if step is None else step
        base_h, base_m = map(int, self.storm["start_clock"].split(":"))
        total = base_h * 60 + base_m + max(0, s) * 15 + (15 if s >= 0 else 0)
        return f"{(total // 60) % 24:02d}:{total % 60:02d}"

    # ------------------------------------------------------------------ input

    def inject_report(self, segment_id: str, depth_cm: float | None,
                      text: str = "", source: str = "dashboard",
                      name: str = "", photo: str | None = None) -> dict:
        minute = _minutes(self.step + 1)
        rep = {
            "minute": minute, "segment": segment_id,
            "depth_cm": float(depth_cm) if depth_cm else None,
            "text": text or "(live report)", "photo": photo,
            "name": name, "source": source, "live": True,
        }
        _cv_annotate(rep)
        if not rep.get("depth_cm"):
            rep["depth_cm"] = 10.0
        self.injected.append(rep)
        return rep

    def set_sensor(self, segment_id: str, depth_cm: float) -> None:
        if segment_id in self.segments:
            self.live_sensor[segment_id] = (time.time(), float(depth_cm))

    def nearest_segment(self, lat: float, lng: float) -> str:
        best, best_d = None, 1e18
        for f in self.geojson["features"]:
            for x, y in f["geometry"]["coordinates"]:
                d = (lat - y) ** 2 + (lng - x) ** 2
                if d < best_d:
                    best, best_d = f["properties"]["id"], d
        return best or self.sensor_seg

    # -------------------------------------------------------------- risk

    def risk_at(self, lat: float, lng: float, rain_ctx: dict | None = None) -> dict:
        """Waterlogging probability for an arbitrary tapped point.

        A calibrated logistic over the projected peak depth of the nearest
        street segment, scaled by drain-health belief and proximity — every
        driver is returned so the UI can SHOW the reasoning, not just the
        number. ``rain_ctx`` overrides the storm context (LIVE mode passes
        real past/next rain and the tide estimate).
        """
        import math

        # nearest segment + distance (metres) to its closest vertex
        best, best_d2, best_pt = None, 1e18, None
        for f in self.geojson["features"]:
            for x, y in f["geometry"]["coordinates"]:
                d2 = (lat - y) ** 2 + (lng - x) ** 2
                if d2 < best_d2:
                    best, best_d2, best_pt = f["properties"]["id"], d2, (y, x)
        seg = self.segments[best]
        drain = self.drains[seg.drain_id]
        dist_m = 111320.0 * math.sqrt(best_d2)

        # Far from every monitored street — open sea, the creek, a ward we
        # don't instrument — the honest answer is "not covered here", not a
        # percentage extrapolated from a street kilometres away.
        if dist_m > COVERAGE_RADIUS_M:
            return {
                "covered": False,
                "distance_m": round(dist_m),
                "segment": seg.name,
                "segment_id": best,
                "anchor": {"lat": best_pt[0], "lng": best_pt[1]},
            }

        if rain_ctx:
            past = list(rain_ctx.get("past", []))
            nxt = list(rain_ctx.get("next", []))[:4]
            tide = float(rain_ctx.get("tide", 2.5))
            depth = 0.0
            for mm in past:
                depth = step_depth_cm(depth, mm, tide, seg,
                                      drain.capacity_mm, drain.blockage_belief)
            base_depth, rain_coming = depth, sum(nxt)
            proj = depth
            peak = depth
            for mm in nxt:
                proj = step_depth_cm(proj, mm, tide, seg,
                                     drain.capacity_mm, drain.blockage_belief)
                peak = max(peak, proj)
            tide_now = tide
        else:
            t = self.step
            base_depth = self.expected[best]
            obs = self.observed.get(best)
            if obs and t - obs[0] <= OBSERVATION_FRESH_WINDOWS:
                base_depth = max(base_depth, obs[1])
            nxt = self.storm["rain_mm"][t + 1: t + 5] if t >= 0 else self.storm["rain_mm"][:4]
            tides = self.storm["tide_m"][t + 1: t + 5] if t >= 0 else self.storm["tide_m"][:4]
            rain_coming = sum(nxt)
            proj, peak = base_depth, base_depth
            for i, mm in enumerate(nxt):
                proj = step_depth_cm(proj, mm, tides[i] if i < len(tides) else tides[-1] if tides else 2.5,
                                     seg, drain.capacity_mm, drain.blockage_belief)
                peak = max(peak, proj)
            tide_now = self.storm["tide_m"][t] if t >= 0 else self.storm["tide_m"][0]

        # logistic over projected peak, scaled by drain belief & proximity
        p = 1.0 / (1.0 + math.exp(-(peak - 12.0) / 6.0))
        p *= 1.0 + 0.35 * drain.blockage_belief
        proximity = 1.0 if dist_m <= 120 else max(0.35, 1.0 - (dist_m - 120) / 600.0)
        p *= proximity
        p = max(0.02, min(0.97, p))

        tier = "HIGH" if p >= 0.6 else "MODERATE" if p >= 0.3 else "LOW"
        return {
            "covered": True,
            "probability": round(p, 2),
            "tier": tier,
            "segment_id": best,
            "segment": seg.name,
            "distance_m": round(dist_m),
            "projected_peak_cm": round(peak, 1),
            "current_cm": round(base_depth, 1),
            "rain_next_hour_mm": round(rain_coming, 1),
            "bowl": seg.bowl,
            "drain": drain.id,
            "drain_health": drain.health,
            "tide_lock": round(tide_lock(tide_now), 2),
            "anchor": {"lat": best_pt[0], "lng": best_pt[1]},
        }

    # ------------------------------------------------------------------- tick

    def tick(self) -> dict:
        if self.finished:
            return self.snapshot()
        self.step += 1
        t = self.step
        minute = _minutes(t + 1)
        rain = self.storm["rain_mm"][t]
        tide = self.storm["tide_m"][t]

        # 1 · LISTEN
        window_reports = [
            r for r in self.script["reports"] if _minutes(t) < r["minute"] <= minute
        ] + [r for r in self.injected if _minutes(t) < r["minute"] <= minute]
        for r in window_reports:
            _cv_annotate(r)
            self.reports.append(r)
            self.observed[r["segment"]] = (t, float(r["depth_cm"]))

        def merge_obs(seg_id: str, cm: float) -> None:
            # Multiple sources in one window (report + sensor): keep the max —
            # standing water reported by anyone is standing water.
            prev = self.observed.get(seg_id)
            if prev and prev[0] == t:
                cm = max(cm, prev[1])
            self.observed[seg_id] = (t, cm)

        sensor_seg = self.script["sensor"]["segment"]
        sensor_cm = float(self.script["sensor"]["depth_cm"][min(t, len(self.script["sensor"]["depth_cm"]) - 1)])
        live = self.live_sensor.get(sensor_seg)
        if live and time.time() - live[0] < LIVE_SENSOR_FRESH_S:
            sensor_cm = live[1]
        merge_obs(sensor_seg, sensor_cm)
        for seg_id, (ts, cm) in self.live_sensor.items():
            if seg_id != sensor_seg and time.time() - ts < LIVE_SENSOR_FRESH_S:
                merge_obs(seg_id, cm)

        # 2 · EXPECT
        for sid, seg in self.segments.items():
            drain = self.drains[seg.drain_id]
            self.expected[sid] = step_depth_cm(
                self.expected[sid], rain, tide, seg,
                drain.capacity_mm, drain.blockage_belief,
            )

        # 3 · COMPARE
        for sid, obs in self.observed.items():
            if obs is None or t - obs[0] > OBSERVATION_FRESH_WINDOWS:
                continue
            seg = self.segments[sid]
            drain = self.drains[seg.drain_id]
            evidence = next((r for r in reversed(window_reports) if r["segment"] == sid), None)
            v = classify(sid, self.expected[sid], obs[1], rain, drain, evidence_ref=evidence)
            if v.dispatch:
                self.blocked_badge.add(sid)
                card = dispatch_card(self._next_id(), drain.id, drain.name, sid, seg.name,
                                     minute, v.confidence, rain, len(drain.evidence))
                self.alerts.append(card)
                self.dispatches.append({
                    "drain": drain.id, "drain_name": drain.name,
                    "segment": seg.name, "minute": minute, "clock": self.clock(),
                    "confidence": v.confidence, "health": drain.health,
                    "evidence": [e for e in drain.evidence if e],
                })

        # 4 · WARN
        nowcast_rain = self.storm["rain_mm"][t + 1: t + 1 + NOWCAST_WINDOWS]
        nowcast_tide = self.storm["tide_m"][t + 1: t + 1 + NOWCAST_WINDOWS]
        for sid, seg in self.segments.items():
            depth = max(self.expected[sid],
                        self.observed[sid][1] if self.observed[sid] else 0.0)
            if sid not in self.watched and depth >= seg.watch_cm:
                self.watched.add(sid)
                if sid not in self.alerted:
                    self.alerts.append(watch_alert(
                        self._next_id(), seg.name, sid, minute, depth, seg.subscribers))
            if sid in self.alerted:
                continue
            drain = self.drains[seg.drain_id]
            crossing = project_crossing(
                self.expected[sid], nowcast_rain, nowcast_tide, seg,
                drain.capacity_mm, drain.blockage_belief, seg.alert_cm,
            )
            already_over = depth >= seg.alert_cm
            if crossing is not None or already_over:
                lead = 0 if already_over else crossing * 15
                peak = max(depth, seg.alert_cm * 1.4)
                self.alerted.add(sid)
                self.alerts.append(street_alert(
                    self._next_id(), seg.name, sid, minute, lead, peak, seg.subscribers))

        return self.snapshot()

    # --------------------------------------------------------------- snapshot

    def snapshot(self) -> dict:
        t = self.step
        street_alerts = [a for a in self.alerts if a.kind == "street"]
        leads = [a.lead_min for a in street_alerts if a.lead_min > 0]
        node_live = any(time.time() - ts < LIVE_SENSOR_FRESH_S
                        for ts, _ in self.live_sensor.values())
        seg_rows = []
        for sid, seg in self.segments.items():
            obs = self.observed[sid]
            fresh = obs is not None and t - obs[0] <= OBSERVATION_FRESH_WINDOWS
            depth = max(self.expected[sid], obs[1] if fresh else 0.0)
            if sid in self.blocked_badge:
                state = "blocked"
            elif sid in self.alerted and depth >= seg.watch_cm:
                state = "alert"
            elif depth >= seg.watch_cm:
                state = "watch"
            else:
                state = "ok"
            seg_rows.append({
                "id": sid, "name": seg.name, "state": state,
                "expected_cm": round(self.expected[sid], 1),
                "observed_cm": round(obs[1], 1) if fresh else None,
                "subscribers": seg.subscribers,
                "drain": seg.drain_id,
            })
        return {
            "step": t,
            "minute": _minutes(t + 1) if t >= 0 else 0,
            "clock": self.clock(),
            "finished": self.finished,
            "storm_id": self.storm_id,
            "storm_label": STORMS[self.storm_id]["label"],
            "storm_name": self.storm["name"],
            "area_id": self.area_id,
            "area_label": AREAS[self.area_id]["label"],
            "node_live": node_live,
            "rain_now": self.storm["rain_mm"][t] if t >= 0 else 0,
            "tide_now": self.storm["tide_m"][t] if t >= 0 else self.storm["tide_m"][0],
            "tide_lock": round(tide_lock(self.storm["tide_m"][t] if t >= 0 else 0.0), 2),
            "rain_series": self.storm["rain_mm"][: t + 1],
            "rain_full": self.storm["rain_mm"],
            "tide_full": self.storm["tide_m"],
            "segments": seg_rows,
            "drains": [
                {"id": d.id, "name": d.name, "health": d.health,
                 "dispatched": d.dispatched} for d in self.drains.values()
            ],
            "alerts": [a.__dict__ for a in self.alerts],
            "reports": self.reports,
            "dispatches": self.dispatches,
            "kpis": {
                "alerts_sent": len(street_alerts),
                "people_warned": sum(a.subscribers for a in street_alerts),
                "avg_lead_min": round(sum(leads) / len(leads)) if leads else 0,
                "drains_flagged": len(self.dispatches),
            },
        }

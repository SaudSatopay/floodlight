"""Storm-replay orchestrator — re-runs a real-shaped Mumbai cloudburst
against the live pipeline so the whole loop can be watched end to end:

    gauges → expected model → crowd reports → twin-cause verdicts
           → street alerts (with lead time) → ward dispatches

The replay clock advances in the same 15-minute windows the MCGM AWS
network publishes. Everything downstream — classification, alerting,
drain-health updates — is the production code path; only the *inputs*
(rain, tide, scripted crowd reports) come from the replay file. Swap the
replay feed for the live MCGM endpoint and nothing else changes.
"""

from __future__ import annotations

import json
from pathlib import Path

from .alerts import Alert, dispatch_card, street_alert, watch_alert
from .hydrology import Segment, project_crossing, step_depth_cm, tide_lock
from .twin_cause import DrainState, classify

DATA = Path(__file__).resolve().parent.parent / "data"

# How many 15-min windows of rain nowcast the projector may use.
# (IMD nowcasts comfortably cover 30-45 minutes.)
NOWCAST_WINDOWS = 2
OBSERVATION_FRESH_WINDOWS = 3   # crowd reports stay relevant this long


def _minutes(step: int) -> int:
    return step * 15


class StormReplay:
    """Owns all live state for one replay run. One instance per server."""

    def __init__(self) -> None:
        geo = json.loads((DATA / "ward_segments.geojson").read_text(encoding="utf-8"))
        drains_raw = json.loads((DATA / "drains.json").read_text(encoding="utf-8"))
        self.storm = json.loads((DATA / "storm_replay.json").read_text(encoding="utf-8"))
        self.script = json.loads((DATA / "crowd_script.json").read_text(encoding="utf-8"))

        self.geojson = geo
        self.segments: dict[str, Segment] = {}
        for f in geo["features"]:
            p = f["properties"]
            self.segments[p["id"]] = Segment(
                id=p["id"], name=p["name"], bowl=p["bowl"],
                drain_id=p["drain_id"], subscribers=p["subscribers"],
            )

        self.drains: dict[str, DrainState] = {
            d["id"]: DrainState(id=d["id"], name=d["name"], capacity_mm=d["capacity_mm"])
            for d in drains_raw["drains"]
        }
        self.drain_points = drains_raw["drains"]
        self.reset()

    # ------------------------------------------------------------------ state

    def reset(self) -> None:
        self.step = -1                      # no window processed yet
        self.expected: dict[str, float] = {s: 0.0 for s in self.segments}
        self.observed: dict[str, tuple[int, float] | None] = {s: None for s in self.segments}
        self.alerted: set[str] = set()
        self.watched: set[str] = set()
        self.blocked_badge: set[str] = set()
        self.alerts: list[Alert] = []
        self.reports: list[dict] = []
        self.dispatches: list[dict] = []
        self.injected: list[dict] = []      # live reports filed from the UI
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

    def inject_report(self, segment_id: str, depth_cm: float, text: str = "") -> dict:
        """A citizen report filed live from the dashboard (judge-driven)."""
        minute = _minutes(self.step + 1)
        rep = {
            "minute": minute, "segment": segment_id, "depth_cm": float(depth_cm),
            "text": text or "(live report from dashboard)", "photo": None,
            "source": "dashboard", "live": True,
        }
        self.injected.append(rep)
        return rep

    # ------------------------------------------------------------------- tick

    def tick(self) -> dict:
        """Advance one 15-minute window and return the full state snapshot."""
        if self.finished:
            return self.snapshot()
        self.step += 1
        t = self.step
        minute = _minutes(t + 1)
        rain = self.storm["rain_mm"][t]
        tide = self.storm["tide_m"][t]

        # 1 · LISTEN — crowd reports & sensor readings for this window.
        window_reports = [
            r for r in self.script["reports"] if _minutes(t) < r["minute"] <= minute
        ] + [r for r in self.injected if _minutes(t) < r["minute"] <= minute]
        for r in window_reports:
            self.reports.append(r)
            self.observed[r["segment"]] = (t, float(r["depth_cm"]))

        sensor_cm = self.script["sensor"]["depth_cm"][t]
        sensor_seg = self.script["sensor"]["segment"]
        self.observed[sensor_seg] = (t, float(sensor_cm))

        # 2 · EXPECT — advance the hydrology model with current beliefs.
        for sid, seg in self.segments.items():
            drain = self.drains[seg.drain_id]
            self.expected[sid] = step_depth_cm(
                self.expected[sid], rain, tide, seg,
                drain.capacity_mm, drain.blockage_belief,
            )

        # 3 · COMPARE — twin-cause verdicts where we have fresh observations.
        verdicts = {}
        for sid, obs in self.observed.items():
            if obs is None or t - obs[0] > OBSERVATION_FRESH_WINDOWS:
                continue
            seg = self.segments[sid]
            drain = self.drains[seg.drain_id]
            evidence = next(
                (r for r in reversed(window_reports) if r["segment"] == sid), None
            )
            v = classify(sid, self.expected[sid], obs[1], rain, drain,
                         evidence_ref=evidence)
            verdicts[sid] = v
            if v.dispatch:
                self.blocked_badge.add(sid)
                card = dispatch_card(
                    self._next_id(), drain.id, drain.name, sid, seg.name,
                    minute, v.confidence, rain, len(drain.evidence),
                )
                self.alerts.append(card)
                self.dispatches.append({
                    "drain": drain.id, "drain_name": drain.name,
                    "segment": seg.name, "minute": minute, "clock": self.clock(),
                    "confidence": v.confidence, "health": drain.health,
                    "evidence": [e for e in drain.evidence if e],
                })

        # 4 · WARN — project ahead and fire street alerts with lead time.
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
        rain_series = self.storm["rain_mm"][: t + 1]
        street_alerts = [a for a in self.alerts if a.kind == "street"]
        leads = [a.lead_min for a in street_alerts if a.lead_min > 0]
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
            "rain_now": self.storm["rain_mm"][t] if t >= 0 else 0,
            "tide_now": self.storm["tide_m"][t] if t >= 0 else self.storm["tide_m"][0],
            "tide_lock": round(tide_lock(self.storm["tide_m"][t] if t >= 0 else 0.0), 2),
            "rain_series": rain_series,
            "rain_full": self.storm["rain_mm"],
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

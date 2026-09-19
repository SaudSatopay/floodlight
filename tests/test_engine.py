"""Engine tests — the three claims the pitch makes, verified in code:

1. the hydrology model responds to tide lock and drain capacity,
2. the twin-cause engine diagnoses a blocked drain from surprising water
   and dispatches exactly once,
3. a full storm replay produces early street alerts (real lead time),
   a D-07 dispatch, and trilingual alert text.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from floodlight.engine.hydrology import (
    Segment, project_crossing, step_depth_cm, tide_lock, window_excess_mm,
)
from floodlight.engine.replay import StormReplay
from floodlight.engine.twin_cause import DrainState, classify


SEG = Segment(id="t", name="Test St", bowl=1.2, drain_id="D-X", subscribers=10)


class TestHydrology:
    def test_tide_lock_bounds(self):
        assert tide_lock(1.0) == 0.0
        assert tide_lock(4.6) == 1.0
        assert 0.0 < tide_lock(3.7) < 1.0

    def test_no_excess_below_capacity(self):
        assert window_excess_mm(rain_mm=18, capacity_mm=24, blockage=0.0) == 0.0

    def test_blockage_erases_capacity(self):
        clean = window_excess_mm(30, 24, blockage=0.0)
        choked = window_excess_mm(30, 24, blockage=0.9)
        assert choked > clean

    def test_high_tide_amplifies_depth(self):
        low = step_depth_cm(0.0, 40, tide_m=2.0, seg=SEG, capacity_mm=22, blockage=0.0)
        high = step_depth_cm(0.0, 40, tide_m=4.5, seg=SEG, capacity_mm=22, blockage=0.0)
        assert high > low > 0

    def test_projection_finds_crossing(self):
        crossing = project_crossing(
            depth_now_cm=2.0, nowcast_rain_mm=[35, 45], nowcast_tide_m=[4.0, 4.4],
            seg=SEG, capacity_mm=22, blockage=0.05, threshold_cm=15.0,
        )
        assert crossing in (1, 2)


class TestTwinCause:
    def test_rain_explained_water_is_cause_a(self):
        d = DrainState(id="D-X", name="x", capacity_mm=24)
        v = classify("t", expected_cm=20.0, observed_cm=22.0, rain_now_mm=40, drain=d)
        assert v.cause == "A"
        assert d.blockage_belief < 0.2

    def test_surprising_water_becomes_dispatch(self):
        d = DrainState(id="D-X", name="x", capacity_mm=27)
        v1 = classify("t", 0.5, 8.0, rain_now_mm=5, drain=d, evidence_ref={"r": 1})
        v2 = classify("t", 0.5, 15.0, rain_now_mm=9, drain=d, evidence_ref={"r": 2})
        assert v1.cause == v2.cause == "B"
        assert v2.dispatch, "second strong surprise should cross the dispatch belief"
        # A third surprise must NOT re-dispatch the same drain.
        v3 = classify("t", 1.0, 20.0, rain_now_mm=12, drain=d, evidence_ref={"r": 3})
        assert not v3.dispatch


class TestQuietDay:
    """The negative case is half the product: an ordinary rainy day must
    produce ZERO street alerts — and still catch the blocked drain."""

    def setup_method(self):
        self.replay = StormReplay("quiet")
        while not self.replay.finished:
            self.snap = self.replay.tick()

    def test_no_false_alarms(self):
        assert self.snap["kpis"]["alerts_sent"] == 0

    def test_blocked_drain_still_caught(self):
        dispatches = [d for d in self.snap["dispatches"] if d["drain"] == "D-07"]
        assert len(dispatches) == 1


class TestLiveInputs:
    def test_hardware_sensor_overrides_script(self):
        r = StormReplay()
        r.set_sensor("amb-02", 33.0)
        snap = r.tick()
        row = next(s for s in snap["segments"] if s["id"] == "amb-02")
        assert row["observed_cm"] == 33.0
        assert snap["node_live"] is True

    def test_geotag_maps_to_nearest_segment(self):
        r = StormReplay()
        assert r.nearest_segment(19.0165, 72.8448) in ("amb-01", "amb-02", "hindmata-mkt")
        assert r.nearest_segment(19.0135, 72.8462) == "parel-tank-rd"


class TestWhatsApp:
    PAYLOAD = {
        "entry": [{"changes": [{"value": {
            "contacts": [{"wa_id": "9198xxxx1234", "profile": {"name": "Sunil"}}],
            "messages": [
                {"from": "9198xxxx1234", "type": "text",
                 "text": {"body": "Paani 15cm ho gaya dukaan ke saamne"}},
                {"from": "9198xxxx1234", "type": "location",
                 "location": {"latitude": 19.0135, "longitude": 72.8462, "name": "Parel Tank Rd"}},
            ],
        }}]}],
    }

    def test_payload_parses_to_reports(self):
        from floodlight.engine.whatsapp import guess_depth_cm, parse_messages
        msgs = parse_messages(self.PAYLOAD)
        assert len(msgs) == 2
        assert msgs[0]["name"] == "Sunil"
        assert guess_depth_cm(msgs[0]["text"]) == 15.0
        assert msgs[1]["lat"] == 19.0135

    def test_depth_words(self):
        from floodlight.engine.whatsapp import guess_depth_cm
        assert guess_depth_cm("घुटनों तक पानी") == 30.0
        assert guess_depth_cm("no depth here") is None


class TestCVDepth:
    def test_bands_on_bundled_photos(self):
        from pathlib import Path
        from floodlight.engine.cv_depth import estimate_depth
        static = Path(__file__).resolve().parent.parent / "floodlight" / "static"
        results = {}
        for name in ("r-bus.jpg", "r-shops.jpg", "r-crossing.jpg"):
            est = estimate_depth(static / "reports" / name)
            assert est is not None and est["depth_cm"] >= 0
            assert 0.0 <= est["confidence"] <= 1.0
            results[name] = est["band"]
        # the estimator must actually discriminate, not emit one band
        assert len(set(results.values())) >= 2


class TestStormReplay:
    def setup_method(self):
        self.replay = StormReplay()
        while not self.replay.finished:
            self.snap = self.replay.tick()

    def test_blocked_drain_is_diagnosed_and_dispatched_once(self):
        dispatches = [d for d in self.snap["dispatches"] if d["drain"] == "D-07"]
        assert len(dispatches) == 1
        assert dispatches[0]["minute"] <= 45, "diagnosis must land while rain is still moderate"

    def test_hindmata_alert_fires_with_real_lead_time(self):
        alerts = [a for a in self.snap["alerts"]
                  if a["kind"] == "street" and a["segment_id"] == "amb-02"]
        assert alerts, "the Hindmata bowl must be warned"
        assert alerts[0]["lead_min"] >= 15, "warning must precede the water"

    def test_alerts_speak_three_languages(self):
        street = [a for a in self.snap["alerts"] if a["kind"] == "street"]
        for a in street:
            assert set(a["text"]) >= {"mr", "hi", "en"}

    def test_kpis_are_populated(self):
        k = self.snap["kpis"]
        assert k["alerts_sent"] > 0
        assert k["people_warned"] > 0
        assert k["avg_lead_min"] >= 15
        assert k["drains_flagged"] >= 1

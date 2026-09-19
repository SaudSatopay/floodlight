"""Alert builder — the last metre of the pipeline.

An alert that arrives in the wrong language is noise. Every street-level
warning is generated in Marathi, Hindi and English simultaneously; the
subscriber's WhatsApp preference (or the IVR fallback for feature phones)
picks the rendering. Ward-side dispatch cards stay in English, matching
BMC operating practice.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Alert:
    id: str
    kind: str                     # "street" | "watch" | "dispatch" | "all_clear"
    segment_id: str
    minute: int                   # storm-clock minute the alert fired
    lead_min: int                 # forecast head start (street alerts)
    depth_cm: float
    subscribers: int
    text: dict = field(default_factory=dict)   # lang → message
    meta: dict = field(default_factory=dict)


def street_alert(aid: str, seg_name: str, segment_id: str, minute: int,
                 lead_min: int, depth_cm: float, subscribers: int) -> Alert:
    d = int(round(depth_cm))
    if lead_min > 0:
        text = {
            "mr": f"⚠ फ्लडलाइट इशारा: {seg_name} येथे ~{lead_min} मिनिटांत पाणी साचण्याची शक्यता (~{d} सेमी). दुकानातील माल उंच ठेवा.",
            "hi": f"⚠ फ्लडलाइट चेतावनी: {seg_name} में ~{lead_min} मिनट में जलभराव की आशंका (~{d} सेमी)। सामान ऊँचा रखें।",
            "en": f"⚠ FLOODLIGHT: {seg_name} likely underwater in ~{lead_min} min (est. {d} cm). Lift stock now.",
        }
    else:
        text = {
            "mr": f"⚠ फ्लडलाइट इशारा: {seg_name} येथे आत्ता पाणी भरतंय (~{d} सेमी). माल ताबडतोब उंच ठेवा.",
            "hi": f"⚠ फ्लडलाइट चेतावनी: {seg_name} में अभी पानी भर रहा है (~{d} सेमी)। सामान तुरंत ऊँचा करें।",
            "en": f"⚠ FLOODLIGHT: {seg_name} is flooding NOW (~{d} cm). Lift stock immediately.",
        }
    return Alert(
        id=aid, kind="street", segment_id=segment_id, minute=minute,
        lead_min=lead_min, depth_cm=depth_cm, subscribers=subscribers,
        text=text,
        meta={"channel": "WhatsApp + IVR"},
    )


def watch_alert(aid: str, seg_name: str, segment_id: str, minute: int,
                depth_cm: float, subscribers: int) -> Alert:
    d = int(round(depth_cm))
    return Alert(
        id=aid, kind="watch", segment_id=segment_id, minute=minute,
        lead_min=0, depth_cm=depth_cm, subscribers=subscribers,
        text={
            "mr": f"फ्लडलाइट: {seg_name} येथे पाणी वाढतंय (~{d} सेमी). लक्ष ठेवा.",
            "hi": f"फ्लडलाइट: {seg_name} में पानी बढ़ रहा है (~{d} सेमी)। नज़र रखें।",
            "en": f"FLOODLIGHT watch: water rising on {seg_name} (~{d} cm).",
        },
        meta={"channel": "WhatsApp"},
    )


def dispatch_card(aid: str, drain_id: str, drain_name: str, segment_id: str,
                  seg_name: str, minute: int, confidence: float,
                  rain_now_mm: float, evidence_count: int) -> Alert:
    pct = int(round(confidence * 100))
    return Alert(
        id=aid, kind="dispatch", segment_id=segment_id, minute=minute,
        lead_min=0, depth_cm=0.0, subscribers=0,
        text={
            "en": (
                f"🛠 DISPATCH: drain {drain_id} ({drain_name}) suspected blocked "
                f"— {seg_name} is flooding at only {rain_now_mm:.0f} mm/15min. "
                f"Confidence {pct}%. Evidence: {evidence_count} geotagged report(s) with photos."
            ),
        },
        meta={"drain_id": drain_id, "confidence": confidence, "channel": "Ward war room"},
    )

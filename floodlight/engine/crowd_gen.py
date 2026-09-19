"""Deterministic crowd-script generator — so EVERY area × storm pairing
replays with believable citizen traffic, not just the hand-authored
flagship combinations.

The generator writes the same shape as the curated files:

  * a sensor depth series for the area's instrumented segment, derived
    from the hydrology model itself (observed ≈ expected on a healthy
    street — which is exactly what makes the blocked drain stand out);
  * two early reports on the blocked-drain street (moderate depths in
    light rain — the cause-B signature);
  * peak-window reports on the most bowl-shaped streets, receding notes
    late — all with rotating Marathi/Hindi texts and reporter personas.

Everything is a pure function of (area, storm), so replays are stable
run to run and the tests can pin them.
"""

from __future__ import annotations

from .hydrology import Segment, step_depth_cm

NAMES = [
    ("Sunil · tyre shop", "mr"), ("Farida · kirana", "hi"), ("Ramesh · merchant", "mr"),
    ("Kiran · commuter", "hi"), ("Asha · tailor", "mr"), ("Imran · courier", "hi"),
    ("Priya · pharmacist", "en"), ("Ward sweeper crew", "hi"),
]
TEXTS = {
    "early_block": [("पुन्हा पाणी साचतंय — पाऊस तर साधाच आहे", "mr"), ("नाली जाम है, हल्की बारिश में भी पानी", "hi")],
    "rising": [("पाणी वाढतंय, गुडघ्यापर्यंत जाईल असं वाटतं", "mr"), ("पानी बढ़ रहा है, दुकान के अंदर आने वाला है", "hi"),
               ("Water rising fast, bikes stalling", "en")],
    "peak": [("नेहमीप्रमाणे तुंबलं, वाहतूक बंद", "mr"), ("घुटनों तक पानी, रास्ता बंद", "hi")],
    "receding": [("पानी उतर रहा है", "hi"), ("उतरतंय हळूहळू", "mr")],
}
PHOTOS = ["reports/r-crossing.jpg", "reports/r-shops.jpg", "reports/r-bus.jpg"]


def generate(segments: dict[str, Segment], drains: dict, storm: dict,
             sensor_seg: str, blocked_drain: str) -> dict:
    rain, tide = storm["rain_mm"], storm["tide_m"]
    n = len(rain)
    total = sum(rain)

    # Sensor series: hydrology on the instrumented segment. If the sensor
    # happens to sit on the blocked drain's own street (Milan Subway!), its
    # series reflects the TRUE choked drain — the hardware corroborates the
    # citizens instead of contradicting them.
    seg = segments[sensor_seg]
    cap = next(d["capacity_mm"] for d in drains if seg.drain_id == d["id"])
    true_block = 0.85 if seg.drain_id == blocked_drain else 0.05
    series, depth = [], 0.0
    for i in range(n):
        depth = step_depth_cm(depth, rain[i], tide[i], seg, cap, true_block)
        series.append(round(depth * 0.9))

    blocked_segs = [s for s in segments.values() if s.drain_id == blocked_drain]
    star = blocked_segs[0] if blocked_segs else seg
    peak_i = max(range(n), key=lambda i: rain[i])
    bowls = sorted((s for s in segments.values() if s.id not in (star.id,)),
                   key=lambda s: -s.bowl)[:3]

    reports: list[dict] = []
    ni, ti, pi = 0, 0, 0

    def add(minute, seg_id, depth_cm, pool, photo=None):
        nonlocal ni, ti
        name, _ = NAMES[ni % len(NAMES)]; ni += 1
        text, _ = TEXTS[pool][ti % len(TEXTS[pool])]; ti += 1
        reports.append({"minute": minute, "segment": seg_id, "depth_cm": depth_cm,
                        "name": name, "text": text, "photo": photo, "source": "whatsapp"})

    # cause-B signature on the blocked street, always early
    add(8, star.id, 8, "early_block", PHOTOS[0])
    add(18, star.id, 15, "early_block", PHOTOS[1])

    # storm-strength dependent traffic
    if total >= 120:
        for j, b in enumerate(bowls[: 2 + (total >= 250)]):
            minute = max(20, (peak_i - 1 + j) * 15 + 11)
            depth = round(min(45, 10 + b.bowl * total / 18))
            add(minute, b.id, depth, "rising" if j == 0 else "peak",
                PHOTOS[2] if j == 0 else None)
        add(min(n * 15 - 10, (peak_i + 3) * 15 + 5), star.id,
            round(min(40, 14 + total / 20)), "peak")
        add(n * 15 - 22, bowls[0].id, max(4, series[-1] or 6), "receding")
    else:
        add(int(n * 15 * 0.55), star.id, 11, "rising")
        add(n * 15 - 25, bowls[0].id, 2, "receding")

    return {
        "note": f"auto-generated crowd traffic · {storm['name']}",
        "sensor": {"segment": sensor_seg, "depth_cm": series,
                   "note": "hydrology-derived series (healthy-drain trajectory)"},
        "reports": sorted(reports, key=lambda r: r["minute"]),
    }

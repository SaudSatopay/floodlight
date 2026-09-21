"""Expected-flooding model — the "EXPECT" stage of the FLOODLIGHT pipeline.

For every street segment we compute how much waterlogging *today's rain
should* cause, given three things the city already knows:

  1. how much rain fell in each 15-minute window (MCGM AWS cadence),
  2. how much of it the segment's storm-water drain can carry away,
  3. whether the tide has sealed the outfalls (Mumbai's silent multiplier —
     at high tide gravity drains stop draining).

The model is deliberately simple and inspectable: a per-window "excess"
(rain beyond drain capacity) accumulates into standing-water depth, scaled
by how bowl-shaped the segment is. It is not a CFD simulation — it is the
cheapest model that is *wrong in a useful direction*: when reality floods
far beyond it, something other than rain is to blame. That gap is exactly
what the twin-cause classifier consumes.
"""

from __future__ import annotations

from dataclasses import dataclass

# Depth (cm) produced per effective millimetre of excess rain on a segment
# with bowl factor 1.0. Calibrated so the Hindmata bowl peaks in the
# 30-40 cm band during a 200 mm cloudburst — the band reported by BMC/press
# for that junction in real events.
K_DEPTH_CM_PER_MM = 0.30

# Standing water drains back once rain drops below capacity, but slowly —
# Mumbai's flat gradients give it nowhere to go. Per-window decay fraction.
RECESSION = 0.12

# Tide gate: below LOW_M the outfalls are free; above HIGH_M they are
# effectively sealed and every excess millimetre stays on the street.
TIDE_LOW_M = 3.0
TIDE_HIGH_M = 4.5
TIDE_MAX_MULTIPLIER = 2.2


@dataclass
class Segment:
    """Static description of one street segment in the ward model."""

    id: str
    name: str
    bowl: float            # how low-lying / bowl-shaped (1.0 = neutral)
    drain_id: str
    subscribers: int       # shops & homes subscribed to alerts (demo count)
    alert_cm: float = 15.0  # depth at which water enters shopfronts
    watch_cm: float = 8.0


def tide_lock(tide_m: float) -> float:
    """0.0 → outfalls free, 1.0 → outfalls fully sealed by the tide."""
    if tide_m <= TIDE_LOW_M:
        return 0.0
    if tide_m >= TIDE_HIGH_M:
        return 1.0
    return (tide_m - TIDE_LOW_M) / (TIDE_HIGH_M - TIDE_LOW_M)


def tide_multiplier(tide_m: float) -> float:
    """How much an excess millimetre is amplified when it cannot leave."""
    return 1.0 + tide_lock(tide_m) * (TIDE_MAX_MULTIPLIER - 1.0)


def waterlog_probability(peak_cm: float, blockage_belief: float = 0.0,
                         proximity: float = 1.0) -> float:
    """The ONE depth→probability calibration behind every tap card and
    strip. Logistic centred on the 15 cm alert line (≈50%); the 8 cm
    watch line reads ≈20%; a bone-dry street rests near 5%. (The old
    (peak−12)/6 curve idled at 11.9% for ZERO depth — every dry tap in
    the city answered the same '12%', which read as fake.)"""
    import math
    p = 1.0 / (1.0 + math.exp(-(peak_cm - 15.0) / 5.0))
    p *= 1.0 + 0.35 * blockage_belief
    p *= proximity
    return max(0.02, min(0.97, p))


def window_excess_mm(rain_mm: float, capacity_mm: float, blockage: float) -> float:
    """Rain this window that the drain could not carry.

    ``blockage`` is the *believed* fraction of the drain that is choked
    (0 = clean, 1 = fully blocked). The twin-cause engine updates this
    belief live; the hydrology stays the same equation either way.
    """
    effective_capacity = max(0.0, capacity_mm * (1.0 - blockage))
    return max(0.0, rain_mm - effective_capacity)


def step_depth_cm(
    prev_depth_cm: float,
    rain_mm: float,
    tide_m: float,
    seg: Segment,
    capacity_mm: float,
    blockage: float,
) -> float:
    """Advance one 15-minute window of the expected-depth model."""
    excess = window_excess_mm(rain_mm, capacity_mm, blockage)
    gained = K_DEPTH_CM_PER_MM * seg.bowl * excess * tide_multiplier(tide_m)
    # Recession only works when the drain has spare capacity this window.
    drains_free = 1.0 if excess == 0.0 else 0.35
    kept = prev_depth_cm * (1.0 - RECESSION * drains_free * (1.0 - tide_lock(tide_m)))
    return max(0.0, kept + gained)


def project_crossing(
    depth_now_cm: float,
    nowcast_rain_mm: list[float],
    nowcast_tide_m: list[float],
    seg: Segment,
    capacity_mm: float,
    blockage: float,
    threshold_cm: float,
) -> int | None:
    """Look ahead through the rain nowcast; return how many windows until
    ``threshold_cm`` is crossed, or ``None`` if it is not crossed.

    This projection is what buys shopkeepers their 15-30 minute head start:
    the alert fires on *predicted* crossing, not on observed water.
    """
    depth = depth_now_cm
    for i, (rain, tide) in enumerate(zip(nowcast_rain_mm, nowcast_tide_m), start=1):
        depth = step_depth_cm(depth, rain, tide, seg, capacity_mm, blockage)
        if depth >= threshold_cm:
            return i
    return None

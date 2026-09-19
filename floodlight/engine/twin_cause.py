"""The Twin-Cause Engine — CX0404's twist, answered in ~120 lines.

One symptom (a flooded street) has two very different causes:

  CAUSE A — rainfall overload: the sky simply beat the drain.
  CAUSE B — a blocked drain: even moderate rain floods the street.

A system that only watches rainfall misses cause B — the more common and
the more *fixable* one. FLOODLIGHT separates them by maintaining, per
street segment, the gap between what the hydrology model EXPECTS and what
people + sensors OBSERVE:

    Δ small  → the model explains the water → cloudburst → WARN people.
    Δ large  → something underground is choked → raise the drain's
               blockage belief → past a threshold, DISPATCH a crew with
               the evidence attached.

The blockage belief feeds straight back into the expected model, so one
confirmed diagnosis immediately sharpens every later forecast — the system
learns the ward's drains storm by storm.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Observed depth must beat expected by this many cm *and* this ratio
# before we treat the gap as evidence of a blockage (rain gauges and
# crowd guesses are both noisy).
DELTA_FLOOR_CM = 6.0
DELTA_RATIO = 2.0

# How fast one window of surprising water moves the blockage belief.
BELIEF_LEARNING_RATE = 0.55
DISPATCH_BELIEF = 0.60

# Drain health is the shopkeeper-facing version of (1 - blockage belief).
HEALTH_DISPATCH_FLOOR = 40.0


@dataclass
class DrainState:
    """Live belief about one storm-water drain."""

    id: str
    name: str
    capacity_mm: float
    blockage_belief: float = 0.05   # prior: drains are mostly fine
    evidence: list[dict] = field(default_factory=list)
    dispatched: bool = False

    @property
    def health(self) -> float:
        return round((1.0 - self.blockage_belief) * 100.0)


@dataclass
class Verdict:
    """Outcome of one expected-vs-observed comparison on one segment."""

    segment_id: str
    cause: str            # "A" (rain overload), "B" (blocked drain), or "-"
    expected_cm: float
    observed_cm: float
    delta_cm: float
    confidence: float     # 0..1, only meaningful for cause B
    dispatch: bool        # True the moment a crew should be sent


def classify(
    segment_id: str,
    expected_cm: float,
    observed_cm: float,
    rain_now_mm: float,
    drain: DrainState,
    evidence_ref: dict | None = None,
) -> Verdict:
    """Compare one segment's expected vs observed depth and update beliefs.

    Returns the verdict; mutates ``drain`` (belief + evidence log) when the
    observation is surprising.
    """
    delta = observed_cm - expected_cm
    surprising = delta >= DELTA_FLOOR_CM and observed_cm >= DELTA_RATIO * max(expected_cm, 1.0)

    if surprising:
        # Water the rain cannot explain → move belief toward "blocked",
        # proportionally to how badly the model was beaten.
        overshoot = min(1.0, delta / 15.0)
        drain.blockage_belief = min(
            0.97,
            drain.blockage_belief + BELIEF_LEARNING_RATE * overshoot * (1.0 - drain.blockage_belief),
        )
        if evidence_ref:
            drain.evidence.append(evidence_ref)

        confidence = drain.blockage_belief
        should_dispatch = confidence >= DISPATCH_BELIEF and not drain.dispatched
        if should_dispatch:
            drain.dispatched = True
        return Verdict(segment_id, "B", expected_cm, observed_cm, round(delta, 1),
                       round(confidence, 2), should_dispatch)

    if observed_cm >= 8.0 or expected_cm >= 8.0:
        # Water is present and the model explains it: honest rain flood.
        return Verdict(segment_id, "A", expected_cm, observed_cm, round(delta, 1), 0.0, False)

    return Verdict(segment_id, "-", expected_cm, observed_cm, round(delta, 1), 0.0, False)

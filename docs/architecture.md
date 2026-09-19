# FLOODLIGHT — architecture notes

## Design stance

One deliberately simple, inspectable hydrology model + one comparison loop.
The model does not try to be *right*; it tries to be **wrong in a useful
direction**. When observation beats expectation by more than noise, the
difference is information about the drain, not the rain. That single idea
(CX0404's "twist") drives everything: alerts, dispatches, and the drain
health ledger.

## Data flow

```
storm window (15 min)
  │
  ├─ rain (MCGM AWS replay)          ┐
  ├─ tide (outfall lock curve)       │ inputs — replay file today,
  ├─ crowd reports (WhatsApp script) │ live feeds at scale
  └─ sensor depth (virtual node)     ┘
  │
  ▼
StormReplay.tick()                    floodlight/engine/replay.py
  1. LISTEN   ingest window's reports + sensor into observed[]
  2. EXPECT   step_depth_cm() per segment with believed blockage
  3. COMPARE  classify() → Verdict(cause A/B) · drain beliefs update
  4. WARN     project_crossing() over the nowcast → street_alert()
              dispatch_card() when belief ≥ 0.60 (once per drain)
  │
  ▼
snapshot() → SSE hub → every open dashboard
```

## Key constants (calibration)

| Constant | Value | Meaning |
|---|---|---|
| `K_DEPTH_CM_PER_MM` | 0.30 | cm of standing water per effective mm (bowl 1.0) |
| `TIDE_LOW/HIGH_M` | 3.0 / 4.5 | outfall lock ramp |
| `DELTA_FLOOR_CM` / `DELTA_RATIO` | 6 / 2× | surprise gate before blockage evidence counts |
| `DISPATCH_BELIEF` | 0.60 | crew goes out at 60 % blockage belief |
| `NOWCAST_WINDOWS` | 2 | 30 min of IMD-style lookahead buys the lead time |

Calibrated so the Hindmata bowl peaks in the 30–60 cm band on a 205 mm
cloudburst — the band the junction is notorious for.

## Scale path

- SQLite/GeoJSON → PostGIS; segments become ward-wide OSM extracts
- Replay file → MCGM AWS poller (same interface, `storm_replay.json` shape)
- Scripted reports → WhatsApp Cloud API webhook; photos → OpenCV depth
- One ward → 24 wards: the engine is per-segment and embarrassingly parallel

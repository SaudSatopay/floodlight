<p align="center">
  <img src="docs/banner.png" alt="FLOODLIGHT — every street warned, every drain diagnosed" width="820" />
</p>

<p align="center">
  <b>Hyperlocal flood warnings for Mumbai — every street warned, every drain diagnosed.</b><br/>
  <sub>MUSA CodeX 2026 · Problem <b>CX0404 “Flood Street, No Warning”</b> · Smart Cities & Urban Development · Team <b>ALL STARS</b></sub>
</p>

<p align="center">
  <img alt="python" src="https://img.shields.io/badge/python-3.11+-3fd0ff?style=flat-square&labelColor=0c0f22" />
  <img alt="fastapi" src="https://img.shields.io/badge/FastAPI-SSE%20live%20stream-a96bf8?style=flat-square&labelColor=0c0f22" />
  <img alt="tests" src="https://img.shields.io/badge/tests-11%20passing-2bd576?style=flat-square&labelColor=0c0f22" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-e2afff?style=flat-square&labelColor=0c0f22" />
</p>

---

A specific stretch of road floods every monsoon **within twenty minutes of heavy rain**, and shopkeepers only
realise it once water is already inside their shops. City-scale alerts cannot warn a street. And the same ward
floods for **two entirely different reasons** — genuine rainfall overload, or a **blocked drain even in moderate
rain** — a system that only watches rainfall completely misses the second, more common cause.

FLOODLIGHT is a ward-level flood nervous system that answers both halves of that problem:

- **Every street, warned** — street-segment forecasts fire WhatsApp/IVR alerts in **Marathi, Hindi and English**
  15–30 minutes *before* the water arrives, per-street, not per-city.
- **Every drain, diagnosed** — a **Twin-Cause Engine** continuously compares *expected* flooding (rain × drain
  capacity × tide) against *observed* flooding (citizen photo reports + an optional ₹2k level sensor). When the
  water beats the model, the cause is underground: the drain's health score drops and the ward war room gets a
  dispatch card with the evidence attached.

<p align="center"><img src="docs/screenshots/war-room.png" alt="FLOODLIGHT ward war room at peak storm" width="900" /></p>

## The twist, in one diagram

```mermaid
flowchart LR
  R[MCGM AWS rain\n15-min gauges] --> F
  T[Tide clock\noutfall lock] --> F
  C[WhatsApp photo reports\n+ CV depth estimate] --> F
  M[Drainage map\nBMC SWD + OSM] --> F
  F[Street-segment\nrisk state] --> E{Twin-Cause Engine\nexpected vs observed}
  E -- "Δ small → CAUSE A\nrain overload" --> A[Street alerts\nMR · HI · EN\n15–30 min lead]
  E -- "Δ large → CAUSE B\nblocked drain" --> D[Ward dispatch\ndrain ID + photo evidence]
  E --> H[Drain Health Ledger\npre-monsoon cleaning list]
```

The blockage belief feeds **back into the forecast**: one diagnosed drain immediately sharpens every later
prediction on its streets. The system learns the ward, storm by storm.

## Quickstart

```bash
pip install -r requirements.txt
python run.py
# open http://localhost:8737 and press ▶ RUN STORM
```

That replays a 205 mm / 3 h cloudburst (the *08 July 2026* reconstruction) against the **Hindmata–Parel pilot
belt** — 12 street segments, 9 drains, a scripted stream of citizen WhatsApp reports, and a virtual ultrasonic
sensor at Hindmata Junction. Everything downstream of the inputs — hydrology, classification, alerting,
dispatch — is the production code path; swap the replay file for the live MCGM feed and nothing else changes.

**What to watch for during the replay**

| Storm clock | What happens | Why it matters |
|---|---|---|
| 14:30 | Parel Tank Rd reports water at only 9 mm/15min → **CAUSE B**, drain `D-07` flagged, crew dispatched with photo evidence | The rain-only blind spot, caught in 30 minutes |
| 15:00 | Hindmata bowl street alert fires — **T−30 min before water crosses the doorstep** | Lead time, not commentary |
| 15:30 | Tide peaks at 4.5 m — outfalls seal, the model expects the surge before it happens | Mumbai-specific physics, encoded |
| 17:00 | 12 street alerts · ~1,200 people warned · avg lead ~30 min · 1 drain diagnosed | The KPIs the ward actually cares about |

File your own citizen report from the composer (bottom-right) while the storm runs — the engine ingests it on
the next window exactly like the scripted WhatsApp traffic.

<p align="center">
  <img src="docs/screenshots/dispatch.png" alt="Cause B dispatch card with evidence" width="430" />
  <img src="docs/screenshots/alerts.png" alt="Trilingual street alerts with lead time" width="430" />
</p>

## How it works

| Stage | Module | The idea |
|---|---|---|
| LISTEN | [`engine/replay.py`](floodlight/engine/replay.py) | 15-min windows of rain + tide + geotagged crowd reports + sensor readings |
| EXPECT | [`engine/hydrology.py`](floodlight/engine/hydrology.py) | Per-segment excess-rain model: drain capacity, bowl factor, **tide-lock multiplier** |
| COMPARE | [`engine/twin_cause.py`](floodlight/engine/twin_cause.py) | Expected vs observed → cause verdict; blockage beliefs update Bayesian-style and feed back into EXPECT |
| WARN | [`engine/alerts.py`](floodlight/engine/alerts.py) | Nowcast projection buys the lead time; alerts render in mr/hi/en; dispatch cards carry drain ID + evidence |
| SHOW | [`static/`](floodlight/static/) | Leaflet war-room dashboard fed by one SSE stream — no framework, no build step |

Run the tests:

```bash
python -m pytest tests/ -q
```

Eleven tests pin the three claims the pitch makes: tide lock amplifies flooding, two surprising reports diagnose
and dispatch a blocked drain exactly once, and a full storm replay produces early trilingual alerts with real
lead time.

## Honest data notes

- **Replay series are synthetic reconstructions** shaped after real MCGM AWS cloudburst records and spring-tide
  curves — clearly labeled in-app. The live system reads the same shapes from `dm.mcgm.gov.in`.
- **Segment geometry is road-snapped to real OSM streets** (Overpass extract + shortest-path along the named
  ways; two small market/approach lanes hand-traced where OSM has no drivable way) — production ingests
  BMC SWD drainage geometry directly.
- Citizen report photos are licensed archive images standing in for WhatsApp attachments:
  “Bombay flooded street” 2005 (Wikimedia Commons, CC BY 2.0), Rakesh Krishna Kumar (CC BY-SA 2.0),
  PlaneMad (CC BY-SA 3.0). Map tiles © OpenStreetMap contributors.

## Roadmap (Grand Finale · 27 Sep)

- Live MCGM AWS poller behind the same replay interface
- WhatsApp Cloud API webhook for real report ingestion + subscriber alerts
- OpenCV water-depth estimation from report photos (reference-object heuristic)
- The ₹2,000 ESP32 + ultrasonic sensor node, reporting from the venue stage

## Team ALL STARS

**Saud Satopay** · systems, data & integration — **Harsh Mishra** · backend & inference —
**Parva Panchal** · product & field research

*Built for MUSA CodeX 2026 (Maharashtra University Students Association). MIT licensed.*

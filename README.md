<p align="center">
  <img src="docs/banner.png" alt="FLOODLIGHT — every street warned, every drain diagnosed" width="820" />
</p>

<p align="center">
  <b>Hyperlocal flood warnings for Mumbai — every street warned, every drain diagnosed.</b><br/>
  <sub>MUSA CodeX 2026 · Problem <b>CX0404 “Flood Street, No Warning”</b> · Smart Cities & Urban Development · Team <b>ALL STARS</b></sub>
</p>

<p align="center">
  <img alt="python" src="https://img.shields.io/badge/python-3.11+-4fc1d4?style=flat-square&labelColor=0b0d0f" />
  <img alt="fastapi" src="https://img.shields.io/badge/fastapi-SSE%20stream-e8eae6?style=flat-square&labelColor=0b0d0f" />
  <img alt="tests" src="https://img.shields.io/badge/tests-20%20green-2bd576?style=flat-square&labelColor=0b0d0f" />
  <img alt="alerts" src="https://img.shields.io/badge/alerts-मर%20·%20हि%20·%20EN-e0a83c?style=flat-square&labelColor=0b0d0f" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-9aa3a7?style=flat-square&labelColor=0b0d0f" />
</p>

<p align="center">
  <b>▶ Live demo: <a href="https://floodlight.onrender.com">floodlight.onrender.com</a></b><br/>
  <sub>free-tier host — a cold start can take up to a minute, then press ▶ Run storm</sub>
</p>

<p align="center">
  <sub>
    <a href="#quickstart">quickstart</a> ·
    <a href="#the-twist-in-one-diagram">the twist</a> ·
    <a href="#how-it-works">how it works</a> ·
    <a href="#beyond-the-replay--already-wired">beyond the replay</a> ·
    <a href="#deploy-give-judges-a-url">deploy</a> ·
    <a href="#design-language">design</a>
  </sub>
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

<p align="center"><img src="docs/screenshots/war-room.png" alt="FLOODLIGHT ward instrument at peak storm" width="920" /></p>
<p align="center"><sub>15:45, peak cloudburst — 11 streets red, the blocked drain dashed amber, a street's diagnosis card open. Calm by default; every detail is one tap away.</sub></p>

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
# open http://localhost:8737 and press ▶ Run storm
```

**Eight flood-famous corridors across the Mumbai Metropolitan Region × four real storm profiles** — every
pairing replays through the same engine. Island city to the northern suburbs and across the creek:
Hindmata, Milan Subway, King's Circle, **Kurla**, **Mulund**, **Borivali–Dahisar**, **Thane** and
**Mira Road** — all road-snapped from OSM, each with its own drains and its own notorious blockage:

| | Areas (road-snapped OSM corridors) | Storms (15-min AWS cadence) |
|---|---|---|
| MCGM wards | Hindmata · Milan Subway · King's Circle · Kurla · Mulund · Borivali–Dahisar | **08 July 2026 cloudburst · 205 mm** — the flagship run |
| Beyond the city | **Thane (TMC)** · **Mira Road (MBMC)** | **26 July 2005 · the 944 mm day** — Mumbai's benchmark catastrophe |
| Live region strip | every corridor's REAL rain + risk right now, tap to jump | **29 Aug 2017 · ~331 mm** — the day the city re-lived 2005 |
| | | **Quiet Tuesday · 75 mm** — the day whose only correct output is **silence** |

Flagship pairings carry hand-authored citizen traffic; every other pairing gets deterministic crowd
scripts derived from the hydrology itself — pick any ward, throw any storm at it, the story still plays.
On the quiet day, **zero healthy streets alert** and the blocked drain still gets caught — in *all eight
corridors* (pinned by tests — the matrix runs 32 replays).

### LIVE CITY — real rainfall, right now

The **Live city** tab leaves the replay entirely: it pulls **real 15-minutely rainfall** for the active
ward from [Open-Meteo](https://open-meteo.com) (keyless, genuinely live), shades the streets with the same
hydrology fed today's actual rain, and draws the weather — **rain particles over the map scale with the
real rain rate**, flooding streets run animated flow-lines, tide is an honest labelled estimate — and a
**rain heatmap** paints precipitation across Greater Mumbai from a 42-point Open-Meteo grid spanning the whole MMR (in replay
mode the heat layer shows waterlogging depth instead). Citizen reports and the hardware node stream in
through the same channels as the replay.

**Tap anywhere → waterlogging probability.** Click any point on the map and FLOODLIGHT returns a
calculated probability for that exact spot — a calibrated logistic over the projected peak depth of the
nearest street, scaled by drain-health belief, tide lock and proximity — with every driver shown as a
bar, not a black box. Streets, drains, the sensor and the KPI tiles are all clickable too.

The dashboard is deliberately calm: a plain-language status line, four numbers, and a map. Everything else
is tap-to-reveal — tap a street for its diagnosis card, open the Live feed tab for the raw log (citizen
photos carry their **CV depth-band tags**), Rainfall for the gauge chart, Map key when you need it.

**What to watch for during the replay**

| Storm clock | What happens | Why it matters |
|---|---|---|
| 14:30 | Parel Tank Rd reports water at only 9 mm/15min → **CAUSE B**, drain `D-07` flagged, crew dispatched with photo evidence | The rain-only blind spot, caught in 30 minutes |
| 15:00 | Hindmata bowl street alert fires — **T−30 min before water crosses the doorstep** | Lead time, not commentary |
| 15:30 | Tide peaks at 4.5 m — outfalls seal, the model expects the surge before it happens | Mumbai-specific physics, encoded |
| 17:00 | 12 street alerts · ~1,200 people warned · avg lead ~30 min · 1 drain diagnosed | The KPIs the ward actually cares about |

File your own citizen report from the composer (bottom-right) while the storm runs — the engine ingests it on
the next window exactly like the scripted WhatsApp traffic.

<table align="center">
  <tr>
    <td align="center"><img src="docs/screenshots/diagnosis.png" alt="Tap-to-reveal street diagnosis" width="440" /><br/><sub><b>Tap a street →</b> its diagnosis, in plain language</sub></td>
    <td align="center"><img src="docs/screenshots/quiet.png" alt="Quiet day: zero alerts sent" width="440" /><br/><sub><b>The negative case:</b> a normal day sends zero alerts — drain still caught</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/dispatch.png" alt="Cause B dispatch card with evidence" width="440" /><br/><sub><b>Cause B →</b> crew dispatched with photo evidence, minute 30</sub></td>
    <td align="center"><img src="docs/screenshots/alerts.png" alt="Trilingual street alerts with lead time" width="440" /><br/><sub><b>Cause A →</b> trilingual alerts with a T−30 min head start</sub></td>
  </tr>
</table>

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

Twenty tests pin what the pitch claims: tide lock amplifies flooding · two surprising reports diagnose and
dispatch a blocked drain exactly once · a full replay produces early trilingual alerts with real lead time ·
the quiet-day replay sends **zero** street alerts while still catching D-07 · WhatsApp payloads parse into
reports (depth from "15cm" or "घुटनों तक") · a hardware sensor reading overrides the script · CV depth
estimation discriminates between bands on real photos.

## Beyond the replay — already wired

| Capability | Where | Turn it on |
|---|---|---|
| **Live city feed** | [`engine/livefeed.py`](floodlight/engine/livefeed.py) | `FLOODLIGHT_MODE=live MCGM_RAIN_URL=… python run.py` — same interface as the replay file, degrades to zero-rain + a DEGRADED flag if the feed drops |
| **WhatsApp Cloud API** | [`engine/whatsapp.py`](floodlight/engine/whatsapp.py) + `/webhook/whatsapp` | Point Meta's webhook here with `WHATSAPP_VERIFY_TOKEN`; set `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_ID` and outbound alerts go real — without them, the sim outbox logs every byte that would send (`/api/outbox`) |
| **CV depth from photos** | [`engine/cv_depth.py`](floodlight/engine/cv_depth.py) | Always on — every photo report gets a waterline/band estimate with confidence; reporter's own estimate stays the fallback |
| **Hardware level node** | [`hardware/floodlight_node.ino`](hardware/floodlight_node.ino) + `POST /api/sensor` | Flash the ₹2k ESP32 + ultrasonic build, or fake it: `python tools/sensor_sim.py` — the dashboard flips to LIVE HARDWARE on the first reading |

## Deploy (give judges a URL)

Already done: **https://floodlight.onrender.com** (Render free tier — cold starts take up to a minute).

The app is a single uvicorn process with no database, so free tiers eat it happily.
[`render.yaml`](render.yaml) and a `Procfile` are included: connect this repo on
[Render](https://render.com) (or Railway/Fly), start command
`uvicorn floodlight.app:app --host 0.0.0.0 --port $PORT`, health check `/healthz`.

## Design language

The dashboard is styled as a **hydrological instrument**, not a SaaS page — Bloomberg-terminal and
mission-control DNA:

- graphite surfaces split by **hairline rules** — no decorated cards, no glows
- **IBM Plex Sans + Plex Mono** with tabular numerals; Anton only for the wordmark
- one working accent (**instrument teal**); **amber and vermillion appear only as status semantics**
  (watch · alert · blocked · dispatched)
- **cased cartographic strokes** on the map — dark casing under a solid colour fill, the way
  professional GIS tools draw roads; the blocked drain marches amber dashes because that *is* signal
- **progressive disclosure** — a plain-language status line and four numbers by default; the street
  diagnosis, the raw feed, the gauge chart and the report composer all open on demand

## Honest data notes

- **Replay series are synthetic reconstructions** shaped after real MCGM AWS cloudburst records and spring-tide
  curves — clearly labeled in-app. The live system reads the same shapes from `dm.mcgm.gov.in`.
- **Segment geometry is road-snapped to real OSM streets** (Overpass extract + shortest-path along the named
  ways; two small market/approach lanes hand-traced where OSM has no drivable way) — production ingests
  BMC SWD drainage geometry directly.
- Citizen report photos are licensed archive images standing in for WhatsApp attachments:
  “Bombay flooded street” 2005 (Wikimedia Commons, CC BY 2.0), Rakesh Krishna Kumar (CC BY-SA 2.0),
  PlaneMad (CC BY-SA 3.0). Map tiles © OpenStreetMap contributors.

## Grand Finale (27 Sep)

The roadmap items landed early (table above). What remains for the stage is connection and theatre:
venue Wi-Fi, the live sensor bucket-dunk, and alert thresholds tuned on a Hindmata field walk.

## Team ALL STARS

**Saud Satopay** · systems, data & integration — **Harsh Mishra** · backend & inference —
**Parva Panchal** · product & field research

*Built for MUSA CodeX 2026 (Maharashtra University Students Association). MIT licensed.*

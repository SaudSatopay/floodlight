# The 3-minute stage run — presenter runbook

## T−10 checklist

- [ ] Open `floodlight.onrender.com/app?watch=1` — wait for the brass scan bar to fill (32/32 cities)
- [ ] Second tab on `/` (landing), third on `/app?storm=quiet&autoplay=1` paused for the false-alarm question
- [ ] Venue has speakers? Press `S` once — the confirmation ping doubles as a volume check
- [ ] `run_demo.bat` already run once on this laptop (offline fallback is then instant)
- [ ] Phone: FLOODLIGHT installed from **Add to Home Screen**, hotspot ready if venue Wi-Fi wobbles
- [ ] Press `?` on stage if you blank — every key is on screen

Open **floodlight.onrender.com/app?watch=1 ten minutes before** you're called. A GitHub
Actions heartbeat pings the service every ten minutes, so it normally never sleeps and the
scanner meets you already at **32/32 cities**. If the host was redeployed cold, the free tier
boots in ~1 min and the scanner rebuilds full coverage within ~15 minutes even while
rate-limited (rotating met.no chunks; the brass bar under the panel title shows the sweep
filling — every good reading is kept). Keep one tab on `/` and one on `/app`.

**One instrument, shared.** The deployed replay is a single live hub — everyone on the URL
sees (and can drive) the same storm, which is a great line when the judges' phones and the
projector move in lockstep. But if the room starts driving it mid-pitch, present from
`run_demo.bat` instead (your own private hub on `localhost:8737`) and keep one cloud tab
open just for Storm Watch.

## Keys

| Key | Does |
|---|---|
| `Space` | Run / pause the storm |
| `T` | Guided tour (title-card narration, auto camera) |
| `R` | Reset the replay |
| `E` | Storm Watch · Earth — fly to the live rain |
| `D` | Simulate the sensor bucket-dunk while a storm runs (node flips to LIVE HARDWARE) |
| `S` | Stage sound (off by default) — alerts ping like sonar, the dispatch lands low, the tide seals with a swell. Worth switching on if the venue has speakers |
| `?` | Show the stage-keys card on screen |

The RAINFALL chart is a **scrubber**: click any 15-minute bar and the replay jumps
straight to that window — dispatch minute, tide-lock, the peak — no waiting.

## The run

**0:00 — the landing page (`/`).** Let the hero breathe for five seconds: *"This is Hindmata's
real street geometry replaying the real 08 July cloudburst — from the same engine you're about
to see live."* Point at the ticker if it lands well.

**0:20 — press "▶ Open the war room", then hit `T`.** The tour runs the flagship storm at 1×
(~40 s) and narrates itself: Cause B dispatch at min 30 (camera flies to drain D-07, evidence
line), the first street alert with its real lead time, tide-lock sealing the outfalls, closing
KPIs. Talk over it — the captions carry the facts if you blank.

**1:10 — the twist, in one tap.** Tap the amber-dashed street (Parel Tank Rd): expected vs
observed bars, *"far more water than this rain can explain — something is choked underground."*
That's the Twin-Cause Engine — the thing rain-only systems cannot see.

**1:40 — the kill shot: STORM WATCH · EARTH.** Open **LIVE CITY**, scroll to Storm Watch
(or just have a tab ready on `/app?watch=1`). Say the line: *"The monsoon left Mumbai last
week — but it's always raining somewhere."* Tap the top city. The map flies across the planet
under the real satellite clouds and answers with a probability computed from the rain falling
there **at that minute**, local clock and all. Read the popup's last line out loud:
*"corridor-grade answers need a mapped corridor — that's onboarding, not modelling."*

**2:30 — the negative case (if time).** `/app?storm=quiet&autoplay=1` at 4×: *"75 mm Tuesday —
zero alerts, zero cried wolf, and the blocked drain still gets caught."* Judges who ask about
false alarms get this pre-answered.

**Close.** *"Eight corridors, four storms, thirty-five pinned tests, a ₹2,000 sensor, alerts in
three languages — and an engine that already works on any city on Earth."*

## If the venue Wi-Fi dies

**Double-click `run_demo.bat`** in the repo root (Windows) — it reuses its virtual environment,
so after one run with internet it launches fully offline and opens `localhost:8737` itself.
Fonts are self-hosted, so the design is pixel-identical offline; the replay, tour, quiet day
and 2005 all run from the local process. Only map tiles, the satellite layer and live rain
need internet, and they degrade gracefully. (macOS/Linux: `python run.py`.)

## Pocket copy

FLOODLIGHT installs as an app: open `floodlight.onrender.com/app` on your phone →
browser menu → **Add to Home Screen**. It launches full-screen with its own icon — the
hallway demo while judges walk between tables, and a second screen if the laptop misbehaves.

## Timing note for 10:00 IST

At demo time it is mid-day across South-East Asia — peak convection over Jakarta, Manila,
Bangkok — and morning over Chennai/Kolkata. Storm Watch will almost certainly have a wet city
at the top. If the planet is unusually dry, the ranked list still shows real numbers and local
clocks; the honesty *is* the demo.

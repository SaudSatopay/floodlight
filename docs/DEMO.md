# The 3-minute stage run — presenter runbook

Open **floodlight.onrender.com ten minutes before** you're called (free tier cold-starts
in ~1 min; after that it's instant). Keep one tab on `/` and one on `/app`.

## Keys

| Key | Does |
|---|---|
| `Space` | Run / pause the storm |
| `T` | Guided tour (title-card narration, auto camera) |
| `R` | Reset the replay |

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

Everything except LIVE CITY / Storm Watch is offline-safe once the page is loaded — the replay,
tour, quiet day and 2005 all run from the server process. Run `python run.py` on the laptop and
use `localhost:8737` as the fallback URL (same everything, minus live tiles/satellite).

## Timing note for 10:00 IST

At demo time it is mid-day across South-East Asia — peak convection over Jakarta, Manila,
Bangkok — and morning over Chennai/Kolkata. Storm Watch will almost certainly have a wet city
at the top. If the planet is unusually dry, the ranked list still shows real numbers and local
clocks; the honesty *is* the demo.

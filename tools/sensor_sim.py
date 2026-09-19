"""Hardware stand-in: streams level-node readings to /api/sensor exactly
like the ESP32 firmware does, so the live-hardware path can be demoed
(and judged) without soldering anything.

    python tools/sensor_sim.py                     # rising-water sweep
    python tools/sensor_sim.py --depth 22          # hold a fixed depth
    python tools/sensor_sim.py --segment parel-tank-rd --period 2
"""

from __future__ import annotations

import argparse
import json
import math
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--server", default="http://127.0.0.1:8737")
parser.add_argument("--segment", default="amb-02")
parser.add_argument("--depth", type=float, default=None, help="fixed depth; omit for a sweep")
parser.add_argument("--period", type=float, default=3.0, help="seconds between readings")
args = parser.parse_args()

print(f"FLOODLIGHT sensor sim → {args.server}/api/sensor · segment {args.segment}")
t0 = time.time()
while True:
    if args.depth is not None:
        depth = args.depth
    else:
        depth = max(0.0, 26.0 * (0.5 + 0.5 * math.sin((time.time() - t0) / 18.0)))
    body = json.dumps({"segment": args.segment, "depth_cm": round(depth, 1)}).encode()
    req = urllib.request.Request(f"{args.server}/api/sensor", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            r.read()
        print(f"  {depth:5.1f} cm  ✓")
    except Exception as exc:
        print(f"  {depth:5.1f} cm  ✗ {exc}")
    time.sleep(args.period)

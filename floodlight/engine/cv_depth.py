"""First-pass computer vision on citizen photos: estimate a water-depth
BAND from a single street image.

Monocular centimetre-accurate depth from an arbitrary phone photo is a
research problem; a *band* (ankle / shin / knee / waist) is not — and a
band is exactly what the twin-cause engine needs, because its decisions
ride on "is there far more water than the model expects", not on ±2 cm.

Method (deliberately classical, explainable to a judge in one breath):

  1. Search the lower 70 % of the frame for the WATERLINE — the strongest
     sustained horizontal edge (Sobel row energy, smoothed).
  2. Check the region below that line actually looks like standing water:
     low saturation variance + horizontal streaking (reflections).
  3. Map the flooded fraction of the frame below the waterline to a depth
     band, calibrated on Mumbai street furniture (kerbs ≈ 15 cm,
     wheel hubs ≈ 30 cm, knee ≈ 45 cm).

The reporter's own estimate always remains the fallback; the CV estimate
ships with its confidence so downstream fusion can weigh it.
"""

from __future__ import annotations

from pathlib import Path

BANDS = [
    (0.10, 5.0, "puddles"),
    (0.18, 12.0, "ankle-deep"),
    (0.28, 22.0, "shin-deep"),
    (0.40, 32.0, "knee-deep"),
    (1.00, 45.0, "above knee"),
]


def estimate_depth(photo_path: str | Path) -> dict | None:
    """Return {depth_cm, band, confidence, waterline_frac} or None."""
    try:
        import cv2
        import numpy as np
    except ImportError:
        return None

    img = cv2.imread(str(photo_path))
    if img is None:
        return None
    img = cv2.resize(img, (480, int(480 * img.shape[0] / img.shape[1])))
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    # 1 · waterline: strongest sustained horizontal gradient row, searched
    #     ONLY in the lower half of the frame (0.45h–0.92h) — above that
    #     the strongest horizontals are rooflines and horizons, not water.
    sobel_y = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    row_energy = np.abs(sobel_y).mean(axis=1)
    lo, hi = int(h * 0.45), int(h * 0.92)
    smooth = np.convolve(row_energy[lo:hi], np.ones(9) / 9.0, mode="same")
    waterline_row = lo + int(np.argmax(smooth))
    flooded_frac = 1.0 - waterline_row / h          # fraction of frame under water

    # 2 · does the region below the line behave like water?
    below = hsv[waterline_row:, :, :]
    if below.shape[0] < 8:
        return None
    sat_std = float(below[:, :, 1].std())
    # reflections streak horizontally → row-to-row correlation is high
    g_below = gray[waterline_row:, :].astype("float32")
    if g_below.shape[0] > 3:
        rows = g_below[:-1].flatten()
        rows_next = g_below[1:].flatten()
        denom = rows.std() * rows_next.std()
        streak = float(np.corrcoef(rows, rows_next)[0, 1]) if denom > 1e-3 else 0.0
    else:
        streak = 0.0

    wateriness = max(0.0, min(1.0, 0.55 * streak + 0.45 * (1.0 - min(sat_std / 80.0, 1.0))))
    if wateriness < 0.25 or flooded_frac < 0.04:
        return {"depth_cm": 0.0, "band": "no standing water", "confidence": round(1 - wateriness, 2),
                "waterline_frac": round(flooded_frac, 2)}

    # 3 · flooded fraction → band.
    for frac_cap, cm, band in BANDS:
        if flooded_frac <= frac_cap:
            confidence = round(min(0.9, 0.35 + 0.5 * wateriness), 2)
            return {"depth_cm": cm, "band": band, "confidence": confidence,
                    "waterline_frac": round(flooded_frac, 2)}
    return None

"""WhatsApp Cloud API integration — real reports in, real alerts out.

Wired for Meta's standard webhook contract:

  GET  /webhook/whatsapp   — subscription handshake (hub.challenge echo)
  POST /webhook/whatsapp   — inbound messages: text, location pins, images

Outbound alerts go through :class:`Outbox`. With credentials present
(``WHATSAPP_TOKEN`` + ``WHATSAPP_PHONE_ID``) it POSTs to the Graph API;
without them it records every send in a simulated outbox — the demo shows
exactly what would leave the system, byte for byte, and going live is
pasting two env vars, not writing code.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import urllib.request
from collections import deque

GRAPH = "https://graph.facebook.com/v20.0"


def verify_token() -> str:
    return os.environ.get("WHATSAPP_VERIFY_TOKEN", "floodlight-verify")


def parse_messages(payload: dict) -> list[dict]:
    """Flatten a Cloud API webhook payload into report candidates."""
    out: list[dict] = []
    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})
            names = {c.get("wa_id"): c.get("profile", {}).get("name", "")
                     for c in value.get("contacts", [])}
            for msg in value.get("messages", []):
                item: dict = {
                    "wa_from": msg.get("from", ""),
                    "name": names.get(msg.get("from", ""), ""),
                    "text": "", "lat": None, "lng": None, "image_id": None,
                }
                kind = msg.get("type")
                if kind == "text":
                    item["text"] = msg.get("text", {}).get("body", "")
                elif kind == "location":
                    loc = msg.get("location", {})
                    item["lat"], item["lng"] = loc.get("latitude"), loc.get("longitude")
                    item["text"] = loc.get("name", "location pin")
                elif kind == "image":
                    item["image_id"] = msg.get("image", {}).get("id")
                    item["text"] = msg.get("image", {}).get("caption", "photo report")
                else:
                    continue
                out.append(item)
    return out


def guess_depth_cm(text: str) -> float | None:
    """Pull an explicit depth out of a message ("15cm", "घुटनों तक", …)."""
    import re
    m = re.search(r"(\d{1,3})\s*(?:cm|सेमी)", text, re.IGNORECASE)
    if m:
        return min(120.0, float(m.group(1)))
    lowered = text.lower()
    for needles, cm in [(("घुटन", "गुडघ", "knee"), 30.0),
                        (("कमर", "waist"), 60.0),
                        (("टखन", "घोट", "ankle"), 10.0)]:
        if any(n in lowered or n in text for n in needles):
            return cm
    return None


class Outbox:
    """Outbound alert channel — Graph API when credentialled, else a
    visible simulation log."""

    def __init__(self) -> None:
        self.token = os.environ.get("WHATSAPP_TOKEN", "")
        self.phone_id = os.environ.get("WHATSAPP_PHONE_ID", "")
        self.log: deque[dict] = deque(maxlen=200)

    @property
    def live(self) -> bool:
        return bool(self.token and self.phone_id)

    def _post(self, to: str, body: str) -> dict:
        req = urllib.request.Request(
            f"{GRAPH}/{self.phone_id}/messages",
            data=json.dumps({
                "messaging_product": "whatsapp", "to": to,
                "type": "text", "text": {"body": body},
            }).encode(),
            headers={"Authorization": f"Bearer {self.token}",
                     "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)

    async def send(self, to: str, body: str, tag: str = "alert") -> None:
        entry = {"ts": time.time(), "to": to, "body": body, "tag": tag,
                 "mode": "live" if self.live else "sim"}
        if self.live:
            loop = asyncio.get_running_loop()
            try:
                entry["result"] = await loop.run_in_executor(None, self._post, to, body)
            except Exception as exc:            # keep the pipeline alive
                entry["error"] = str(exc)
        self.log.append(entry)

    async def broadcast_alert(self, alert: dict, subscribers_stub: list[str]) -> None:
        """Fan an alert's Marathi text out to its street's subscriber list.
        (Pilot carries a stub list; production reads the subscription DB.)"""
        body = alert["text"].get("mr") or alert["text"].get("en", "")
        for to in subscribers_stub:
            await self.send(to, body)

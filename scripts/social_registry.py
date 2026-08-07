#!/usr/bin/env python3
"""Deterministic resolver for the canonical social destination registry."""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_REGISTRY = ROOT / "config" / "social-destinations.public.json"


def normalize_text(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    text = text.replace("ё", "е")
    text = re.sub(r"[^0-9a-zа-я]+", " ", text, flags=re.I)
    return " ".join(text.split())


@dataclass(frozen=True, slots=True)
class ResolvedDestination:
    key: str
    label: str
    aliases: tuple[str, ...]
    platform: str
    platform_config: dict[str, Any]


class DestinationRegistry:
    def __init__(self, payload: dict[str, Any]) -> None:
        if int(payload.get("version") or 0) != 1:
            raise ValueError("unsupported social destination registry version")
        raw_entries = payload.get("destinations")
        if not isinstance(raw_entries, list) or not raw_entries:
            raise ValueError("social destination registry has no destinations")

        entries: dict[str, dict[str, Any]] = {}
        for raw in raw_entries:
            if not isinstance(raw, dict):
                raise ValueError("destination entry must be an object")
            key = str(raw.get("key") or "").strip()
            label = str(raw.get("label") or "").strip()
            platforms = raw.get("platforms")
            if not key or not label or not isinstance(platforms, dict) or not platforms:
                raise ValueError(f"invalid destination entry: {key or '<missing-key>'}")
            if key in entries:
                raise ValueError(f"duplicate destination key: {key}")
            entries[key] = raw
        self._entries = entries

    @classmethod
    def load(cls, path: Path = DEFAULT_REGISTRY) -> "DestinationRegistry":
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("social destination registry root must be an object")
        return cls(payload)

    def keys(self) -> tuple[str, ...]:
        return tuple(self._entries)

    def entry(self, key: str) -> dict[str, Any]:
        try:
            return self._entries[key]
        except KeyError as exc:
            raise KeyError(f"unknown destination key: {key}") from exc

    def resolve_key(self, query: str) -> str:
        raw = str(query or "").strip()
        if raw in self._entries:
            return raw
        normalized = normalize_text(raw)
        if not normalized:
            raise ValueError("destination query is empty")

        matches: list[str] = []
        for key, entry in self._entries.items():
            candidates = [key, entry.get("label"), *(entry.get("aliases") or [])]
            normalized_candidates = {normalize_text(candidate) for candidate in candidates}
            if normalized in normalized_candidates:
                matches.append(key)
        if len(matches) != 1:
            raise ValueError(
                "destination query must resolve to exactly one registry key; "
                f"query={raw!r} matches={matches}"
            )
        return matches[0]

    def resolve(self, query: str, platform: str) -> ResolvedDestination:
        key = self.resolve_key(query)
        entry = self._entries[key]
        platform_key = str(platform or "").strip().casefold()
        config = (entry.get("platforms") or {}).get(platform_key)
        if not isinstance(config, dict):
            raise ValueError(f"destination {key!r} is not configured for platform {platform_key!r}")
        return ResolvedDestination(
            key=key,
            label=str(entry["label"]),
            aliases=tuple(str(item) for item in (entry.get("aliases") or [])),
            platform=platform_key,
            platform_config=dict(config),
        )


def public_summary(registry: DestinationRegistry) -> list[dict[str, Any]]:
    summary: list[dict[str, Any]] = []
    for key in registry.keys():
        entry = registry.entry(key)
        summary.append(
            {
                "key": key,
                "label": entry["label"],
                "platforms": sorted((entry.get("platforms") or {}).keys()),
            }
        )
    return summary


if __name__ == "__main__":
    registry = DestinationRegistry.load()
    print(json.dumps(public_summary(registry), ensure_ascii=False, indent=2))

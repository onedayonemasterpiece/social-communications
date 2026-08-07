#!/usr/bin/env python3
"""Canonical VK postponed-post identity helpers.

Ported from ``events-bot-new/main_part2.py`` at commit
``35dd1183ccf7d983651cdf026054da49b55a8db8``:

- ``_resolve_vk_postponed_wall_id``;
- ``_resolve_vk_postponed_wall_id_any_actor``;
- ``post_to_vk`` postponed-id handling.

VK may return a transient ``post_id`` from ``wall.post`` and expose a different
wall item ``id`` in ``wall.get(filter=postponed)``.  The postponed item may also
carry the original value as ``postponed_id``.  The semantic postponed
collection is authoritative; ``filter=all`` is only a compatibility fallback.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any


class VkPostponedIdentityError(RuntimeError):
    pass


def response_items(response: Any) -> list[dict[str, Any]]:
    if isinstance(response, dict) and isinstance(response.get("items"), list):
        return [item for item in response["items"] if isinstance(item, dict)]
    if isinstance(response, list):
        return [item for item in response if isinstance(item, dict)]
    return []


def item_identity(item: dict[str, Any]) -> tuple[int, int]:
    try:
        item_id = int(item.get("id") or 0)
        postponed_id = int(item.get("postponed_id") or 0)
    except (TypeError, ValueError):
        return 0, 0
    return item_id, postponed_id


def item_matches_wall_post_response(item: dict[str, Any], response_post_id: int) -> bool:
    item_id, postponed_id = item_identity(item)
    expected = int(response_post_id)
    return item_id > 0 and (item_id == expected or postponed_id == expected)


def marker_matches(item: dict[str, Any], marker: str) -> bool:
    return str(marker) in str(item.get("text") or "")


def resolve_postponed_item(
    *,
    response_post_id: int,
    marker: str,
    fetch_items: Callable[[str], list[dict[str, Any]]],
    attempts: int = 3,
    initial_delay_seconds: float = 0.8,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any] | None:
    """Resolve ``wall.post`` response id to the canonical postponed wall item.

    Each attempt queries ``postponed`` first and ``all`` second.  The item must
    match both the response id (as ``id`` or ``postponed_id``) and the visible
    idempotency marker.  Ambiguous matches fail closed.
    """

    if int(response_post_id) <= 0:
        raise VkPostponedIdentityError("wall.post response id must be positive")
    if not str(marker or ""):
        raise VkPostponedIdentityError("marker is required for postponed identity resolution")

    for attempt in range(max(1, int(attempts))):
        candidates: dict[int, dict[str, Any]] = {}
        for wall_filter in ("postponed", "all"):
            for item in fetch_items(wall_filter):
                if not item_matches_wall_post_response(item, response_post_id):
                    continue
                if not marker_matches(item, marker):
                    continue
                item_id, _ = item_identity(item)
                candidates[item_id] = item
            if candidates:
                break
        if len(candidates) > 1:
            raise VkPostponedIdentityError(
                "multiple postponed VK items match the wall.post response id and marker"
            )
        if candidates:
            return next(iter(candidates.values()))
        if attempt + 1 < max(1, int(attempts)):
            sleep(float(initial_delay_seconds) * (attempt + 1))
    return None

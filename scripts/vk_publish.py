#!/usr/bin/env python3
"""Deterministic VK wall publisher for social-communications.

The adapter is intentionally fail-closed:
- destination identity comes only from the canonical registry;
- the authenticated account must be an administrator of the exact community;
- retries first inspect the postponed queue by a stable visible marker;
- a photo is uploaded only after idempotency checks pass;
- receipts never contain access tokens or upload URLs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import struct
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

from social_registry import DestinationRegistry

VK_API_VERSION = "5.199"
VK_API_ROOT = "https://api.vk.com/method"
MAX_POSTPONED_PAGES = 10
POSTPONED_PAGE_SIZE = 100
MIN_SCHEDULE_LEAD_SECONDS = 600


class VkPublishError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class Command:
    request_id: str
    operation: str
    destination: str
    scheduled_at: datetime | None
    text: str
    marker: str
    image_path: Path


def _clean_text(value: object) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()


def _parse_iso_datetime(value: object) -> datetime:
    raw = _clean_text(value)
    if not raw:
        raise VkPublishError("scheduled_at is required")
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise VkPublishError("scheduled_at must be an ISO-8601 timestamp with timezone") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise VkPublishError("scheduled_at must include an explicit UTC offset")
    return parsed


def _load_command(path: Path) -> Command:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise VkPublishError(f"cannot parse command JSON: {exc}") from exc
    if not isinstance(payload, dict) or int(payload.get("version") or 0) != 1:
        raise VkPublishError("unsupported command version")

    platform = _clean_text(payload.get("platform")).casefold()
    if platform != "vk":
        raise VkPublishError(f"vk_publish requires platform='vk', got {platform!r}")

    request_id = _clean_text(payload.get("request_id"))
    if not request_id or len(request_id) > 120:
        raise VkPublishError("request_id is required and must be at most 120 characters")

    operation = _clean_text(payload.get("operation")).casefold()
    if operation not in {"schedule_post", "publish_now", "verify"}:
        raise VkPublishError(f"unsupported VK operation: {operation!r}")

    destination = _clean_text(payload.get("destination"))
    if not destination:
        raise VkPublishError("destination is required")

    content = payload.get("content")
    if not isinstance(content, dict):
        raise VkPublishError("content must be an object")
    text = _clean_text(content.get("text"))
    marker = _clean_text(content.get("marker"))
    if not text or not marker:
        raise VkPublishError("content.text and content.marker are required")
    if marker not in text:
        raise VkPublishError("content.text must contain content.marker for idempotency")
    if len(text) > 15_000:
        raise VkPublishError("VK message exceeds the conservative 15000-character limit")

    image = content.get("image")
    if not isinstance(image, dict):
        raise VkPublishError("content.image must be an object")
    image_path = Path(_clean_text(image.get("path")))
    if not str(image_path):
        raise VkPublishError("content.image.path is required")

    scheduled_at = None
    if operation in {"schedule_post", "verify"}:
        scheduled_at = _parse_iso_datetime(payload.get("scheduled_at"))

    return Command(
        request_id=request_id,
        operation=operation,
        destination=destination,
        scheduled_at=scheduled_at,
        text=text,
        marker=marker,
        image_path=image_path,
    )


def _png_dimensions(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise VkPublishError("test image must be a valid PNG")
    width, height = struct.unpack(">II", data[16:24])
    if not (1 <= width <= 10_000 and 1 <= height <= 10_000):
        raise VkPublishError("PNG dimensions are invalid")
    return width, height


def _validate_image(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise VkPublishError(f"image file does not exist: {path}")
    size = path.stat().st_size
    if size <= 0 or size > 20 * 1024 * 1024:
        raise VkPublishError("image size must be between 1 byte and 20 MiB")
    width, height = _png_dimensions(path)
    return {
        "bytes": size,
        "width": width,
        "height": height,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


class VkClient:
    def __init__(self, token: str) -> None:
        if not token:
            raise VkPublishError("repository secret VK_ACCESS_TOKEN5 is absent")
        self._token = token
        self._session = requests.Session()
        self._session.headers.update({"User-Agent": "social-communications-vk/1.0"})

    def api(self, method: str, **params: Any) -> Any:
        form = {**params, "access_token": self._token, "v": VK_API_VERSION}
        try:
            response = self._session.post(
                f"{VK_API_ROOT}/{method}",
                data=form,
                timeout=(10, 40),
            )
        except requests.RequestException as exc:
            raise VkPublishError(f"VK transport failed for {method}: {type(exc).__name__}") from exc
        try:
            data = response.json()
        except ValueError as exc:
            raise VkPublishError(f"VK returned non-JSON response for {method}") from exc
        if not isinstance(data, dict):
            raise VkPublishError(f"VK returned invalid response shape for {method}")
        if "error" in data:
            error = data.get("error") or {}
            code = error.get("error_code")
            message = str(error.get("error_msg") or "unknown VK API error")
            raise VkPublishError(f"VK API {method} failed: code={code} message={message}")
        if "response" not in data:
            raise VkPublishError(f"VK response field is absent for {method}")
        return data["response"]

    def upload_wall_photo(self, *, group_id: int, image_path: Path) -> str:
        upload = self.api("photos.getWallUploadServer", group_id=group_id)
        if not isinstance(upload, dict) or not upload.get("upload_url"):
            raise VkPublishError("VK did not return a wall-photo upload URL")
        mime = mimetypes.guess_type(image_path.name)[0] or "image/png"
        try:
            with image_path.open("rb") as handle:
                response = self._session.post(
                    str(upload["upload_url"]),
                    files={"photo": (image_path.name, handle, mime)},
                    timeout=(10, 90),
                )
        except requests.RequestException as exc:
            raise VkPublishError(f"VK photo upload transport failed: {type(exc).__name__}") from exc
        try:
            uploaded = response.json()
        except ValueError as exc:
            raise VkPublishError("VK photo upload returned non-JSON response") from exc
        if not isinstance(uploaded, dict):
            raise VkPublishError("VK photo upload returned an invalid response")
        required = ("server", "photo", "hash")
        if any(uploaded.get(key) in (None, "") for key in required):
            raise VkPublishError("VK photo upload response misses server/photo/hash")

        saved = self.api(
            "photos.saveWallPhoto",
            group_id=group_id,
            server=uploaded["server"],
            photo=uploaded["photo"],
            hash=uploaded["hash"],
        )
        if not isinstance(saved, list) or len(saved) != 1 or not isinstance(saved[0], dict):
            raise VkPublishError("VK did not save exactly one wall photo")
        photo = saved[0]
        owner_id = int(photo.get("owner_id") or 0)
        photo_id = int(photo.get("id") or 0)
        if not owner_id or not photo_id:
            raise VkPublishError("saved VK photo has no owner_id/id")
        attachment = f"photo{owner_id}_{photo_id}"
        access_key = _clean_text(photo.get("access_key"))
        if access_key:
            attachment += f"_{access_key}"
        return attachment


def _groups_from_response(response: Any) -> list[dict[str, Any]]:
    if isinstance(response, list):
        return [item for item in response if isinstance(item, dict)]
    if isinstance(response, dict) and isinstance(response.get("groups"), list):
        return [item for item in response["groups"] if isinstance(item, dict)]
    raise VkPublishError("groups.getById returned an unsupported response shape")


def _verify_destination(client: VkClient, config: dict[str, Any]) -> dict[str, Any]:
    group_id = int(config.get("group_id") or 0)
    screen_name = _clean_text(config.get("screen_name")).casefold()
    title = _clean_text(config.get("title"))
    if group_id <= 0 or not screen_name or not title:
        raise VkPublishError("VK destination registry entry is incomplete")

    groups = _groups_from_response(
        client.api(
            "groups.getById",
            group_ids=group_id,
            fields="screen_name,is_admin,admin_level,type",
        )
    )
    if len(groups) != 1:
        raise VkPublishError("VK destination must resolve to exactly one community")
    group = groups[0]
    actual_id = int(group.get("id") or 0)
    actual_screen = _clean_text(group.get("screen_name")).casefold()
    actual_title = _clean_text(group.get("name"))
    admin_level = int(group.get("admin_level") or 0)
    is_admin = int(group.get("is_admin") or 0)
    if (actual_id, actual_screen, actual_title) != (group_id, screen_name, title):
        raise VkPublishError(
            "VK destination identity mismatch: "
            f"expected={group_id}/{screen_name}/{title!r} "
            f"actual={actual_id}/{actual_screen}/{actual_title!r}"
        )
    if is_admin != 1 or admin_level < 2:
        raise VkPublishError("VK access token has insufficient community administration rights")
    return {
        "group_id": group_id,
        "screen_name": screen_name,
        "title": title,
        "admin_level": admin_level,
    }


def _post_items(response: Any) -> list[dict[str, Any]]:
    if isinstance(response, dict) and isinstance(response.get("items"), list):
        return [item for item in response["items"] if isinstance(item, dict)]
    if isinstance(response, list):
        return [item for item in response if isinstance(item, dict)]
    raise VkPublishError("wall.get returned an unsupported response shape")


def _find_postponed(
    client: VkClient,
    *,
    group_id: int,
    marker: str,
) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for page in range(MAX_POSTPONED_PAGES):
        response = client.api(
            "wall.get",
            owner_id=-group_id,
            filter="postponed",
            count=POSTPONED_PAGE_SIZE,
            offset=page * POSTPONED_PAGE_SIZE,
        )
        items = _post_items(response)
        found.extend(item for item in items if marker in _clean_text(item.get("text")))
        if len(items) < POSTPONED_PAGE_SIZE:
            break
    return found


def _attachment_types(post: dict[str, Any]) -> list[str]:
    return [
        _clean_text(item.get("type"))
        for item in (post.get("attachments") or [])
        if isinstance(item, dict) and _clean_text(item.get("type"))
    ]


def _scheduled_epoch(command: Command) -> int:
    if command.scheduled_at is None:
        raise VkPublishError("scheduled_at is absent")
    epoch = int(command.scheduled_at.astimezone(timezone.utc).timestamp())
    now = int(time.time())
    if epoch - now < MIN_SCHEDULE_LEAD_SECONDS:
        raise VkPublishError(
            f"scheduled publication must be at least {MIN_SCHEDULE_LEAD_SECONDS} seconds in the future"
        )
    return epoch


def _verify_matching_post(
    post: dict[str, Any],
    *,
    command: Command,
    expected_epoch: int | None,
) -> dict[str, Any]:
    post_id = int(post.get("id") or 0)
    if post_id <= 0:
        raise VkPublishError("matching postponed post has no valid id")
    text = _clean_text(post.get("text"))
    if text != command.text:
        raise VkPublishError("matching postponed marker exists, but text differs")
    if expected_epoch is not None:
        observed_epoch = int(post.get("date") or post.get("publish_date") or 0)
        if observed_epoch != expected_epoch:
            raise VkPublishError(
                f"matching postponed post has wrong time: expected={expected_epoch} actual={observed_epoch}"
            )
    types = _attachment_types(post)
    if "photo" not in types:
        raise VkPublishError("matching postponed post has no photo attachment")
    return {
        "post_id": post_id,
        "attachment_types": types,
        "scheduled_epoch": int(post.get("date") or post.get("publish_date") or 0),
    }


def execute(command: Command, *, token: str) -> dict[str, Any]:
    registry = DestinationRegistry.load()
    destination = registry.resolve(command.destination, "vk")
    client = VkClient(token)
    verified_destination = _verify_destination(client, destination.platform_config)
    group_id = int(verified_destination["group_id"])

    expected_epoch = _scheduled_epoch(command) if command.operation in {"schedule_post", "verify"} else None
    existing = _find_postponed(client, group_id=group_id, marker=command.marker)
    if len(existing) > 1:
        raise VkPublishError("multiple postponed VK posts contain the idempotency marker")
    if existing:
        verified = _verify_matching_post(existing[0], command=command, expected_epoch=expected_epoch)
        return {
            "schema": "social.vk.receipt.v1",
            "status": "already_scheduled",
            "request_id": command.request_id,
            "destination_key": destination.key,
            "community": verified_destination,
            "post_id": verified["post_id"],
            "scheduled_at": command.scheduled_at.isoformat() if command.scheduled_at else None,
            "attachment_types": verified["attachment_types"],
        }

    if command.operation == "verify":
        raise VkPublishError("expected postponed VK post was not found")

    image = _validate_image(command.image_path)
    attachment = client.upload_wall_photo(group_id=group_id, image_path=command.image_path)
    params: dict[str, Any] = {
        "owner_id": -group_id,
        "from_group": 1,
        "signed": 0,
        "message": command.text,
        "attachments": attachment,
    }
    if command.operation == "schedule_post":
        params["publish_date"] = expected_epoch
    response = client.api("wall.post", **params)
    post_id = int((response or {}).get("post_id") if isinstance(response, dict) else response or 0)
    if post_id <= 0:
        raise VkPublishError("wall.post did not return a valid post_id")

    if command.operation == "publish_now":
        return {
            "schema": "social.vk.receipt.v1",
            "status": "published",
            "request_id": command.request_id,
            "destination_key": destination.key,
            "community": verified_destination,
            "post_id": post_id,
            "post_url": f"https://vk.com/wall-{group_id}_{post_id}",
            "image": image,
        }

    matches = _find_postponed(client, group_id=group_id, marker=command.marker)
    if len(matches) != 1:
        raise VkPublishError(
            f"post-commit verification expected exactly one postponed post, found {len(matches)}"
        )
    verified = _verify_matching_post(matches[0], command=command, expected_epoch=expected_epoch)
    if verified["post_id"] != post_id:
        raise VkPublishError(
            f"post-commit verification id mismatch: wall.post={post_id} queue={verified['post_id']}"
        )
    return {
        "schema": "social.vk.receipt.v1",
        "status": "scheduled",
        "request_id": command.request_id,
        "destination_key": destination.key,
        "community": verified_destination,
        "post_id": post_id,
        "scheduled_at": command.scheduled_at.isoformat() if command.scheduled_at else None,
        "attachment_types": verified["attachment_types"],
        "image": image,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--command", required=True, type=Path)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    try:
        command = _load_command(args.command)
        receipt = execute(command, token=(os.getenv("VK_ACCESS_TOKEN5") or "").strip())
    except Exception as exc:
        print(f"::error title=VK publication failed::{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    encoded = json.dumps(receipt, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    print(f"SOCIAL_VK_RECEIPT={encoded}")
    if args.receipt:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

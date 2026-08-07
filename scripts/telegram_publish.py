#!/usr/bin/env python3
"""Deterministic Telegram channel publisher for social-communications.

The GitHub Actions session is isolated behind TELEGRAM_AUTH_BUNDLE_GH_ACTIONS.
The bundle must be self-contained: api_id, api_hash, StringSession, and optional
Telethon device parameters. The adapter never prints the decoded values.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import struct
import sys
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator

from telethon import TelegramClient
from telethon.errors import AuthKeyDuplicatedError
from telethon.sessions import StringSession
from telethon.tl.types import Channel

from social_registry import DestinationRegistry

MIN_SCHEDULE_LEAD_SECONDS = 60
MAX_SCHEDULED_SCAN = 500


class TelegramPublishError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class TelegramAuthBundle:
    api_id: int
    api_hash: str
    session: str
    device_model: str | None
    system_version: str | None
    app_version: str | None
    lang_code: str | None
    system_lang_code: str | None


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


def _normalize_title(value: object) -> str:
    text = unicodedata.normalize("NFKC", _clean_text(value)).casefold().replace("ё", "е")
    return " ".join(text.split())


def _parse_iso_datetime(value: object) -> datetime:
    raw = _clean_text(value)
    if not raw:
        raise TelegramPublishError("scheduled_at is required")
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise TelegramPublishError("scheduled_at must be an ISO-8601 timestamp with timezone") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise TelegramPublishError("scheduled_at must include an explicit UTC offset")
    return parsed


def _load_command(path: Path) -> Command:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise TelegramPublishError(f"cannot parse command JSON: {exc}") from exc
    if not isinstance(payload, dict) or int(payload.get("version") or 0) != 1:
        raise TelegramPublishError("unsupported command version")
    if _clean_text(payload.get("platform")).casefold() != "telegram":
        raise TelegramPublishError("telegram_publish requires platform='telegram'")

    request_id = _clean_text(payload.get("request_id"))
    if not request_id or len(request_id) > 120:
        raise TelegramPublishError("request_id is required and must be at most 120 characters")
    operation = _clean_text(payload.get("operation")).casefold()
    if operation not in {"schedule_post", "publish_now", "verify"}:
        raise TelegramPublishError(f"unsupported Telegram operation: {operation!r}")
    destination = _clean_text(payload.get("destination"))
    if not destination:
        raise TelegramPublishError("destination is required")

    content = payload.get("content")
    if not isinstance(content, dict):
        raise TelegramPublishError("content must be an object")
    text = _clean_text(content.get("text"))
    marker = _clean_text(content.get("marker"))
    if not text or not marker:
        raise TelegramPublishError("content.text and content.marker are required")
    if marker not in text:
        raise TelegramPublishError("content.text must contain content.marker for idempotency")
    if len(text) > 1024:
        raise TelegramPublishError(
            "photo caption exceeds Telegram's conservative 1024-character limit; "
            "split or shorten before execution"
        )

    image = content.get("image")
    if not isinstance(image, dict):
        raise TelegramPublishError("content.image must be an object")
    image_path = Path(_clean_text(image.get("path")))
    if not str(image_path):
        raise TelegramPublishError("content.image.path is required")

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


def _decode_json_bundle(raw: str) -> dict[str, Any]:
    value = raw.strip()
    if not value:
        raise TelegramPublishError("repository secret TELEGRAM_AUTH_BUNDLE_GH_ACTIONS is absent")
    attempts: list[str] = [value]
    for decoder in (base64.urlsafe_b64decode, base64.b64decode):
        try:
            padded = value + ("=" * (-len(value) % 4))
            attempts.append(decoder(padded.encode("ascii")).decode("utf-8"))
        except Exception:
            pass
    for candidate in attempts:
        try:
            parsed = json.loads(candidate)
        except Exception:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise TelegramPublishError(
        "TELEGRAM_AUTH_BUNDLE_GH_ACTIONS must be JSON or URL-safe base64 JSON"
    )


def _first_value(payload: dict[str, Any], names: tuple[str, ...]) -> Any:
    lowered = {str(key).casefold(): value for key, value in payload.items()}
    for name in names:
        if name.casefold() in lowered:
            return lowered[name.casefold()]
    for value in payload.values():
        if isinstance(value, dict):
            nested = _first_value(value, names)
            if nested not in (None, ""):
                return nested
    return None


def _load_auth_bundle(raw: str) -> TelegramAuthBundle:
    payload = _decode_json_bundle(raw)
    api_id = _first_value(payload, ("api_id", "apiId", "telegram_api_id", "tg_api_id"))
    api_hash = _first_value(payload, ("api_hash", "apiHash", "telegram_api_hash", "tg_api_hash"))
    session = _first_value(payload, ("session", "session_string", "string_session", "telegram_session"))
    if not api_id or not api_hash or not session:
        present = {
            "api_id": bool(api_id),
            "api_hash": bool(api_hash),
            "session": bool(session),
        }
        raise TelegramPublishError(
            "TELEGRAM_AUTH_BUNDLE_GH_ACTIONS is not self-contained; "
            f"required-field presence={json.dumps(present, sort_keys=True)}"
        )
    try:
        parsed_api_id = int(api_id)
    except (TypeError, ValueError) as exc:
        raise TelegramPublishError("Telegram api_id in bundle is not an integer") from exc
    if parsed_api_id <= 0:
        raise TelegramPublishError("Telegram api_id in bundle must be positive")

    def optional(name: str) -> str | None:
        value = _first_value(payload, (name,))
        cleaned = _clean_text(value)
        return cleaned or None

    return TelegramAuthBundle(
        api_id=parsed_api_id,
        api_hash=_clean_text(api_hash),
        session=_clean_text(session),
        device_model=optional("device_model"),
        system_version=optional("system_version"),
        app_version=optional("app_version"),
        lang_code=optional("lang_code"),
        system_lang_code=optional("system_lang_code"),
    )


def _validate_png(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise TelegramPublishError(f"image file does not exist: {path}")
    data = path.read_bytes()
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise TelegramPublishError("image must be a valid PNG")
    width, height = struct.unpack(">II", data[16:24])
    if len(data) > 20 * 1024 * 1024:
        raise TelegramPublishError("image exceeds 20 MiB")
    return {
        "bytes": len(data),
        "width": width,
        "height": height,
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def _client(bundle: TelegramAuthBundle) -> TelegramClient:
    kwargs: dict[str, Any] = {}
    for name in ("device_model", "system_version", "app_version", "lang_code", "system_lang_code"):
        value = getattr(bundle, name)
        if value:
            kwargs[name] = value
    return TelegramClient(
        StringSession(bundle.session),
        bundle.api_id,
        bundle.api_hash,
        **kwargs,
    )


def _accepted_titles(config: dict[str, Any]) -> set[str]:
    values = [config.get("title"), *(config.get("accepted_titles") or [])]
    return {_normalize_title(value) for value in values if _normalize_title(value)}


async def _resolve_destination(client: TelegramClient, config: dict[str, Any]) -> Channel:
    username = _clean_text(config.get("username")).lstrip("@")
    expected_titles = _accepted_titles(config)
    lookup_mode = _clean_text(config.get("lookup_mode")).casefold()

    candidates: list[Any] = []
    if username:
        try:
            candidates = [await client.get_entity(username)]
        except Exception as exc:
            raise TelegramPublishError(
                f"Telegram destination @{username} could not be resolved: {type(exc).__name__}"
            ) from exc
    elif lookup_mode == "exact_dialog_title":
        expected = _normalize_title(config.get("title"))
        if not expected:
            raise TelegramPublishError("exact-title Telegram destination has no title")
        async for dialog in client.iter_dialogs():
            entity = dialog.entity
            if isinstance(entity, Channel) and _normalize_title(getattr(entity, "title", "")) == expected:
                candidates.append(entity)
    else:
        raise TelegramPublishError("Telegram destination has neither username nor exact-title lookup")

    if len(candidates) != 1:
        raise TelegramPublishError(
            f"Telegram destination must resolve to exactly one channel, found {len(candidates)}"
        )
    entity = candidates[0]
    if not isinstance(entity, Channel) or not bool(getattr(entity, "broadcast", False)):
        raise TelegramPublishError("resolved Telegram destination is not a broadcast channel")
    actual_title = _normalize_title(getattr(entity, "title", ""))
    if expected_titles and actual_title not in expected_titles:
        raise TelegramPublishError(
            f"Telegram destination title mismatch: actual={getattr(entity, 'title', '')!r}"
        )
    actual_username = _clean_text(getattr(entity, "username", "")).casefold()
    if username and actual_username != username.casefold():
        raise TelegramPublishError(
            f"Telegram destination username mismatch: expected=@{username} actual=@{actual_username}"
        )
    rights = getattr(entity, "admin_rights", None)
    may_post = bool(getattr(entity, "creator", False)) or bool(
        rights and getattr(rights, "post_messages", False)
    )
    if not may_post:
        raise TelegramPublishError("Telegram session lacks channel post_messages rights")
    return entity


async def _scheduled_messages(client: TelegramClient, entity: Channel) -> AsyncIterator[Any]:
    count = 0
    async for message in client.iter_messages(entity, scheduled=True, limit=MAX_SCHEDULED_SCAN):
        yield message
        count += 1
        if count >= MAX_SCHEDULED_SCAN:
            break


async def _find_scheduled(client: TelegramClient, entity: Channel, marker: str) -> list[Any]:
    matches: list[Any] = []
    async for message in _scheduled_messages(client, entity):
        if marker in _clean_text(getattr(message, "message", "")):
            matches.append(message)
    return matches


def _expected_epoch(command: Command) -> int:
    if command.scheduled_at is None:
        raise TelegramPublishError("scheduled_at is absent")
    epoch = int(command.scheduled_at.astimezone(timezone.utc).timestamp())
    if command.operation == "schedule_post" and epoch - int(time.time()) < MIN_SCHEDULE_LEAD_SECONDS:
        raise TelegramPublishError(
            f"scheduled publication must be at least {MIN_SCHEDULE_LEAD_SECONDS} seconds in the future"
        )
    return epoch


def _message_epoch(message: Any) -> int:
    date = getattr(message, "date", None)
    if not isinstance(date, datetime):
        return 0
    if date.tzinfo is None:
        date = date.replace(tzinfo=timezone.utc)
    return int(date.astimezone(timezone.utc).timestamp())


def _verify_message(message: Any, command: Command, expected_epoch: int) -> dict[str, Any]:
    message_id = int(getattr(message, "id", 0) or 0)
    if message_id <= 0:
        raise TelegramPublishError("matching scheduled Telegram message has no id")
    if _clean_text(getattr(message, "message", "")) != command.text:
        raise TelegramPublishError("matching scheduled marker exists, but caption differs")
    observed_epoch = _message_epoch(message)
    if observed_epoch != expected_epoch:
        raise TelegramPublishError(
            f"matching scheduled Telegram message has wrong time: expected={expected_epoch} actual={observed_epoch}"
        )
    if getattr(message, "photo", None) is None:
        raise TelegramPublishError("matching scheduled Telegram message has no photo")
    return {"message_id": message_id, "scheduled_epoch": observed_epoch}


async def execute(command: Command, bundle: TelegramAuthBundle) -> dict[str, Any]:
    registry = DestinationRegistry.load()
    destination = registry.resolve(command.destination, "telegram")
    client = _client(bundle)
    try:
        await client.connect()
        if not await client.is_user_authorized():
            raise TelegramPublishError("Telegram StringSession is not authorized")
        entity = await _resolve_destination(client, destination.platform_config)
        username = _clean_text(getattr(entity, "username", "")).casefold() or None
        title = _clean_text(getattr(entity, "title", ""))

        expected_epoch = _expected_epoch(command) if command.operation in {"schedule_post", "verify"} else 0
        existing = await _find_scheduled(client, entity, command.marker)
        if len(existing) > 1:
            raise TelegramPublishError("multiple scheduled Telegram messages contain the idempotency marker")
        if existing:
            verified = _verify_message(existing[0], command, expected_epoch)
            return {
                "schema": "social.telegram.receipt.v1",
                "status": "already_scheduled",
                "request_id": command.request_id,
                "destination_key": destination.key,
                "channel": {"username": username, "title": title},
                "message_id": verified["message_id"],
                "scheduled_at": command.scheduled_at.isoformat() if command.scheduled_at else None,
                "media": "photo",
            }
        if command.operation == "verify":
            raise TelegramPublishError("expected scheduled Telegram message was not found")

        image = _validate_png(command.image_path)
        schedule = command.scheduled_at.astimezone(timezone.utc) if command.operation == "schedule_post" else None
        sent = await client.send_file(
            entity,
            file=str(command.image_path),
            caption=command.text,
            schedule=schedule,
            force_document=False,
        )
        message_id = int(getattr(sent, "id", 0) or 0)
        if message_id <= 0:
            raise TelegramPublishError("Telegram send_file did not return a valid message id")

        if command.operation == "publish_now":
            return {
                "schema": "social.telegram.receipt.v1",
                "status": "published",
                "request_id": command.request_id,
                "destination_key": destination.key,
                "channel": {"username": username, "title": title},
                "message_id": message_id,
                "message_url": f"https://t.me/{username}/{message_id}" if username else None,
                "media": "photo",
                "image": image,
            }

        matches = await _find_scheduled(client, entity, command.marker)
        if len(matches) != 1:
            raise TelegramPublishError(
                f"post-commit verification expected exactly one scheduled message, found {len(matches)}"
            )
        verified = _verify_message(matches[0], command, expected_epoch)
        if verified["message_id"] != message_id:
            raise TelegramPublishError(
                f"post-commit verification id mismatch: send_file={message_id} queue={verified['message_id']}"
            )
        return {
            "schema": "social.telegram.receipt.v1",
            "status": "scheduled",
            "request_id": command.request_id,
            "destination_key": destination.key,
            "channel": {"username": username, "title": title},
            "message_id": message_id,
            "scheduled_at": command.scheduled_at.isoformat() if command.scheduled_at else None,
            "media": "photo",
            "image": image,
        }
    except AuthKeyDuplicatedError as exc:
        raise TelegramPublishError(
            "Telegram rejected the session with AuthKeyDuplicatedError; stop all concurrent users of this session and rotate it"
        ) from exc
    finally:
        await client.disconnect()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--command", required=True, type=Path)
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--preflight-only", action="store_true")
    args = parser.parse_args()
    try:
        command = _load_command(args.command)
        bundle = _load_auth_bundle(os.getenv("TELEGRAM_AUTH_BUNDLE_GH_ACTIONS", ""))
        if args.preflight_only:
            receipt = {
                "schema": "social.telegram.preflight.v1",
                "status": "bundle_valid",
                "request_id": command.request_id,
            }
        else:
            receipt = asyncio.run(execute(command, bundle))
    except Exception as exc:
        print(
            f"::error title=Telegram publication failed::{type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        return 1

    encoded = json.dumps(receipt, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    print(f"SOCIAL_TELEGRAM_RECEIPT={encoded}")
    if args.receipt:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

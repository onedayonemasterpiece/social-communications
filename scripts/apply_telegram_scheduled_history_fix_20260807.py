#!/usr/bin/env python3
"""Replace Telethon iter_messages(scheduled=True) with the raw scheduled-history RPC."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, *, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one source block, found {count}")
    return text.replace(old, new, 1)


def patch_publisher() -> None:
    path = ROOT / "scripts/telegram_publish.py"
    text = path.read_text(encoding="utf-8")
    text = replace_once(
        text,
        "from typing import Any, AsyncIterator\n",
        "from typing import Any\n",
        label="typing import",
    )
    text = replace_once(
        text,
        "from telethon import TelegramClient\n",
        "from telethon import TelegramClient, functions\n",
        label="Telethon import",
    )
    text = replace_once(
        text,
        "from telethon.tl.types import Channel\n",
        "from telethon.tl.types import Channel, MessageMediaPhoto\n",
        label="Telethon type import",
    )
    text = replace_once(
        text,
        "MAX_SCHEDULED_SCAN = 500\n",
        "MAX_SCHEDULED_SCAN = 500\n"
        "POST_COMMIT_VERIFY_ATTEMPTS = 8\n"
        "POST_COMMIT_VERIFY_DELAY_SECONDS = 1.0\n",
        label="scheduled constants",
    )

    old_history = '''async def _scheduled_messages(client: TelegramClient, entity: Channel) -> AsyncIterator[Any]:
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
'''
    new_history = '''async def _scheduled_messages(client: TelegramClient, entity: Channel) -> list[Any]:
    """Read the server-side scheduled queue through the underlying MTProto RPC.

    Telethon's high-level ``iter_messages(..., scheduled=True)`` has had
    version-specific pagination regressions. The Telegram RPC returns the whole
    scheduled queue for a peer and is the authoritative source for idempotency.
    """
    input_peer = await client.get_input_entity(entity)
    result = await client(
        functions.messages.GetScheduledHistoryRequest(peer=input_peer, hash=0)
    )
    messages = list(getattr(result, "messages", []) or [])
    if len(messages) > MAX_SCHEDULED_SCAN:
        raise TelegramPublishError(
            f"scheduled Telegram queue exceeds safety limit: {len(messages)}"
        )
    return messages


async def _find_scheduled(client: TelegramClient, entity: Channel, marker: str) -> list[Any]:
    return [
        message
        for message in await _scheduled_messages(client, entity)
        if marker in _clean_text(getattr(message, "message", ""))
    ]
'''
    text = replace_once(text, old_history, new_history, label="scheduled history implementation")
    text = replace_once(
        text,
        '''    if getattr(message, "photo", None) is None:
        raise TelegramPublishError("matching scheduled Telegram message has no photo")
''',
        '''    media = getattr(message, "media", None)
    if getattr(message, "photo", None) is None and not isinstance(media, MessageMediaPhoto):
        raise TelegramPublishError("matching scheduled Telegram message has no photo")
''',
        label="raw scheduled photo verification",
    )
    text = replace_once(
        text,
        '''        matches = await _find_scheduled(client, entity, command.marker)
        if len(matches) != 1:
            raise TelegramPublishError(
                f"post-commit verification expected exactly one scheduled message, found {len(matches)}"
            )
''',
        '''        matches: list[Any] = []
        for attempt in range(POST_COMMIT_VERIFY_ATTEMPTS):
            matches = await _find_scheduled(client, entity, command.marker)
            if matches:
                break
            if attempt + 1 < POST_COMMIT_VERIFY_ATTEMPTS:
                await asyncio.sleep(POST_COMMIT_VERIFY_DELAY_SECONDS)
        if len(matches) != 1:
            raise TelegramPublishError(
                f"post-commit verification expected exactly one scheduled message, found {len(matches)}"
            )
''',
        label="post-commit retry",
    )
    path.write_text(text, encoding="utf-8")


def patch_tests() -> None:
    path = ROOT / "tests/test_social_publish_contracts.py"
    text = path.read_text(encoding="utf-8")
    text = replace_once(
        text,
        "import base64\n",
        "import asyncio\nimport base64\n",
        label="asyncio test import",
    )
    text = replace_once(
        text,
        "from pathlib import Path\n",
        "from pathlib import Path\nfrom types import SimpleNamespace\n",
        label="SimpleNamespace test import",
    )
    insertion = '''

class TelegramScheduledHistoryTests(unittest.TestCase):
    def test_reads_scheduled_queue_through_raw_rpc(self) -> None:
        expected_message = SimpleNamespace(id=77, message="marker")

        class FakeClient:
            def __init__(self) -> None:
                self.request = None

            async def get_input_entity(self, entity):
                self.entity = entity
                return "input-peer"

            async def __call__(self, request):
                self.request = request
                return SimpleNamespace(messages=[expected_message])

        client = FakeClient()
        messages = asyncio.run(
            telegram_publish._scheduled_messages(client, SimpleNamespace())
        )

        self.assertEqual(messages, [expected_message])
        self.assertIsInstance(
            client.request,
            telegram_publish.functions.messages.GetScheduledHistoryRequest,
        )
        self.assertEqual(client.request.hash, 0)


class CommandContractTests'''
    text = replace_once(
        text,
        "\n\nclass CommandContractTests",
        insertion,
        label="scheduled history test insertion",
    )
    path.write_text(text, encoding="utf-8")


def main() -> None:
    patch_publisher()
    patch_tests()
    print("TELEGRAM_SCHEDULED_HISTORY_FIX=applied")


if __name__ == "__main__":
    main()

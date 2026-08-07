from __future__ import annotations

import asyncio
import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import telegram_publish  # noqa: E402
import vk_publish  # noqa: E402
import vk_events_bot_contract  # noqa: E402


class TelegramBundleTests(unittest.TestCase):
    @staticmethod
    def _encoded(payload: dict) -> str:
        return base64.urlsafe_b64encode(
            json.dumps(payload, separators=(",", ":")).encode("utf-8")
        ).decode("ascii").rstrip("=")

    def test_self_contained_legacy_bundle_is_accepted(self) -> None:
        payload = {
            "api_id": 123456,
            "api_hash": "hash-value",
            "session": "session-value",
            "device_model": "GitHub Actions",
        }
        bundle = telegram_publish._load_auth_bundle(self._encoded(payload))
        self.assertEqual(bundle.api_id, 123456)
        self.assertEqual(bundle.api_hash, "hash-value")
        self.assertEqual(bundle.session, "session-value")
        self.assertEqual(bundle.device_model, "GitHub Actions")

    def test_monitoring_style_bundle_uses_external_app_credentials(self) -> None:
        payload = {
            "session": "session-value",
            "device_model": "GitHub Actions",
            "system_version": "Ubuntu",
            "app_version": "1.0",
            "lang_code": "ru",
            "system_lang_code": "ru",
        }
        bundle = telegram_publish._load_auth_bundle(
            self._encoded(payload),
            api_id_value="654321",
            api_hash_value="external-hash",
        )
        self.assertEqual(bundle.api_id, 654321)
        self.assertEqual(bundle.api_hash, "external-hash")
        self.assertEqual(bundle.session, "session-value")

    def test_monitoring_style_bundle_without_app_credentials_fails_closed(self) -> None:
        payload = {"session": "session-value", "device_model": "GitHub Actions"}
        with self.assertRaisesRegex(telegram_publish.TelegramPublishError, "TG_API_ID"):
            telegram_publish._load_auth_bundle(self._encoded(payload))


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


class VkEventsBotPostponedIdentityTests(unittest.TestCase):
    def test_resolves_shifted_wall_item_id_from_postponed_id(self) -> None:
        calls = []
        item = {
            "id": 125,
            "postponed_id": 124,
            "text": "Caption\n\nMarker: TEST-124",
        }

        def fetch_items(wall_filter: str):
            calls.append(wall_filter)
            return [item] if wall_filter == "postponed" else []

        resolved = vk_events_bot_contract.resolve_postponed_item(
            response_post_id=124,
            marker="TEST-124",
            fetch_items=fetch_items,
            sleep=lambda _delay: None,
        )

        self.assertIs(resolved, item)
        self.assertEqual(calls, ["postponed"])

    def test_retries_user_visible_postponed_collection(self) -> None:
        attempts = 0
        sleeps = []

        def fetch_items(wall_filter: str):
            nonlocal attempts
            if wall_filter == "postponed":
                attempts += 1
                if attempts == 2:
                    return [{"id": 125, "postponed_id": 124, "text": "TEST-124"}]
            return []

        resolved = vk_events_bot_contract.resolve_postponed_item(
            response_post_id=124,
            marker="TEST-124",
            fetch_items=fetch_items,
            sleep=sleeps.append,
        )

        self.assertEqual(resolved["id"], 125)
        self.assertEqual(sleeps, [0.8])

    def test_marker_is_required_in_addition_to_response_id(self) -> None:
        resolved = vk_events_bot_contract.resolve_postponed_item(
            response_post_id=124,
            marker="RIGHT-MARKER",
            fetch_items=lambda _wall_filter: [
                {"id": 125, "postponed_id": 124, "text": "WRONG-MARKER"}
            ],
            attempts=1,
            sleep=lambda _delay: None,
        )
        self.assertIsNone(resolved)


class CommandContractTests(unittest.TestCase):
    def _write(self, payload: dict) -> Path:
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False)
        with handle:
            json.dump(payload, handle, ensure_ascii=False)
        self.addCleanup(lambda: Path(handle.name).unlink(missing_ok=True))
        return Path(handle.name)

    @staticmethod
    def _base(platform: str) -> dict:
        return {
            "version": 1,
            "request_id": "unit-test-001",
            "platform": platform,
            "operation": "schedule_post",
            "destination": "polubit-kaliningrad-anonsy",
            "scheduled_at": "2030-01-01T21:00:00+02:00",
            "content": {
                "text": "Тест\n\nМетка: UNIT-001",
                "marker": "UNIT-001",
                "image": {"path": "generated/test.png"},
            },
        }

    def test_vk_command_parses(self) -> None:
        command = vk_publish._load_command(self._write(self._base("vk")))
        self.assertEqual(command.destination, "polubit-kaliningrad-anonsy")
        self.assertEqual(command.marker, "UNIT-001")

    def test_telegram_command_parses(self) -> None:
        command = telegram_publish._load_command(self._write(self._base("telegram")))
        self.assertEqual(command.destination, "polubit-kaliningrad-anonsy")
        self.assertEqual(command.marker, "UNIT-001")

    def test_marker_must_be_present_in_text(self) -> None:
        payload = self._base("vk")
        payload["content"]["marker"] = "MISSING-MARKER"
        with self.assertRaisesRegex(vk_publish.VkPublishError, "must contain"):
            vk_publish._load_command(self._write(payload))

    def test_platform_adapter_cannot_execute_other_platform_command(self) -> None:
        with self.assertRaisesRegex(vk_publish.VkPublishError, "platform='vk'"):
            vk_publish._load_command(self._write(self._base("telegram")))


if __name__ == "__main__":
    unittest.main()

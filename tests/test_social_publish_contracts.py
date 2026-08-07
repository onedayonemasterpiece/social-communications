from __future__ import annotations

import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import telegram_publish  # noqa: E402
import vk_publish  # noqa: E402


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

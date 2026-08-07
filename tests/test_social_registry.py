from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from social_registry import DestinationRegistry  # noqa: E402


class SocialDestinationRegistryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.registry = DestinationRegistry.load()

    def test_expected_logical_keys_exist(self) -> None:
        self.assertEqual(
            set(self.registry.keys()),
            {
                "polubit-kaliningrad-afisha",
                "polubit-kaliningrad-anonsy",
                "uh-ty-kaliningrad",
                "polubit-kaliningrad",
            },
        )

    def test_aliases_resolve_exactly(self) -> None:
        self.assertEqual(self.registry.resolve_key("афиша"), "polubit-kaliningrad-afisha")
        self.assertEqual(self.registry.resolve_key("канал анонсы"), "polubit-kaliningrad-anonsy")
        self.assertEqual(self.registry.resolve_key("Ухты Калининград"), "uh-ty-kaliningrad")
        self.assertEqual(self.registry.resolve_key("основной брендовый канал"), "polubit-kaliningrad")

    def test_announcements_cross_platform_identity(self) -> None:
        telegram = self.registry.resolve("polubit-kaliningrad-anonsy", "telegram")
        vk = self.registry.resolve("polubit-kaliningrad-anonsy", "vk")
        max_destination = self.registry.resolve("polubit-kaliningrad-anonsy", "max")
        self.assertEqual(telegram.platform_config["username"], "kenigevents")
        self.assertEqual(vk.platform_config["group_id"], 231828790)
        self.assertEqual(vk.platform_config["screen_name"], "kenigeventsofficial")
        self.assertEqual(max_destination.platform_config["title"], "Полюбить Калининград Анонсы")

    def test_uh_ty_telegram_does_not_guess_excursion_channel(self) -> None:
        telegram = self.registry.resolve("uh-ty-kaliningrad", "telegram")
        self.assertNotIn("username", telegram.platform_config)
        self.assertEqual(telegram.platform_config["lookup_mode"], "exact_dialog_title")
        self.assertEqual(telegram.platform_config["title"], "Ух ты, Калининград!")

    def test_unsupported_platform_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "not configured"):
            self.registry.resolve("polubit-kaliningrad", "vk")


if __name__ == "__main__":
    unittest.main()

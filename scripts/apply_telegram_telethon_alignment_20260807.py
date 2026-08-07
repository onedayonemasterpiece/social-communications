#!/usr/bin/env python3
"""One-off migration for the non-workflow Telegram code and tests."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, *, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one source block, found {count}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, replacement: str, *, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one regex match, found {count}")
    return updated


def patch_telegram_publisher() -> None:
    path = "scripts/telegram_publish.py"
    text = read(path)
    text = replace_once(
        text,
        """The GitHub Actions session is isolated behind TELEGRAM_AUTH_BUNDLE_GH_ACTIONS.\nThe bundle must be self-contained: api_id, api_hash, StringSession, and optional\nTelethon device parameters. The adapter never prints the decoded values.""",
        """The already-authorized StringSession and stable device identity come from\nTELEGRAM_AUTH_BUNDLE_GH_ACTIONS. Telegram app credentials come from\nTG_API_ID/TG_API_HASH, matching the existing Telegram Monitoring/Kaggle contract.\nLegacy self-contained bundles remain accepted. Decoded values are never printed.""",
        label="Telegram publisher docstring",
    )

    loader = '''def _load_auth_bundle(
    raw: str,
    *,
    api_id_value: object = None,
    api_hash_value: object = None,
) -> TelegramAuthBundle:
    payload = _decode_json_bundle(raw)
    embedded_api_id = _first_value(
        payload, ("api_id", "apiId", "telegram_api_id", "tg_api_id")
    )
    embedded_api_hash = _first_value(
        payload, ("api_hash", "apiHash", "telegram_api_hash", "tg_api_hash")
    )
    session = _first_value(
        payload, ("session", "session_string", "string_session", "telegram_session")
    )

    # Canonical events-bot contract: app credentials are separate, while the
    # auth bundle carries the already-authorized StringSession and device identity.
    api_id = _clean_text(api_id_value) or _clean_text(embedded_api_id)
    api_hash = _clean_text(api_hash_value) or _clean_text(embedded_api_hash)

    missing: list[str] = []
    if not session:
        missing.append("TELEGRAM_AUTH_BUNDLE_GH_ACTIONS.session")
    if not api_id:
        missing.append("TG_API_ID")
    if not api_hash:
        missing.append("TG_API_HASH")
    if missing:
        raise TelegramPublishError(
            "Telegram credentials are incomplete; no new session or interactive login "
            f"is required. Missing: {', '.join(missing)}"
        )

    try:
        parsed_api_id = int(api_id)
    except (TypeError, ValueError) as exc:
        raise TelegramPublishError("TG_API_ID is not an integer") from exc
    if parsed_api_id <= 0:
        raise TelegramPublishError("TG_API_ID must be positive")

    def optional(name: str) -> str | None:
        value = _first_value(payload, (name,))
        cleaned = _clean_text(value)
        return cleaned or None

    return TelegramAuthBundle(
        api_id=parsed_api_id,
        api_hash=api_hash,
        session=_clean_text(session),
        device_model=optional("device_model"),
        system_version=optional("system_version"),
        app_version=optional("app_version"),
        lang_code=optional("lang_code"),
        system_lang_code=optional("system_lang_code"),
    )


def _validate_png'''
    text = regex_once(
        text,
        r"def _load_auth_bundle\(raw: str\) -> TelegramAuthBundle:.*?\n\ndef _validate_png",
        loader,
        label="Telegram auth loader",
    )
    text = replace_once(
        text,
        'bundle = _load_auth_bundle(os.getenv("TELEGRAM_AUTH_BUNDLE_GH_ACTIONS", ""))',
        '''bundle = _load_auth_bundle(
            os.getenv("TELEGRAM_AUTH_BUNDLE_GH_ACTIONS", ""),
            api_id_value=os.getenv("TG_API_ID", ""),
            api_hash_value=os.getenv("TG_API_HASH", ""),
        )''',
        label="Telegram main auth call",
    )
    write(path, text)


def patch_tests() -> None:
    path = "tests/test_social_publish_contracts.py"
    text = read(path)
    replacement = '''class TelegramBundleTests(unittest.TestCase):
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


class CommandContractTests'''
    text = regex_once(
        text,
        r"class TelegramBundleTests\(unittest\.TestCase\):.*?\n\nclass CommandContractTests",
        replacement,
        label="Telegram bundle tests",
    )
    write(path, text)


def main() -> None:
    patch_telegram_publisher()
    patch_tests()
    print("TELEGRAM_TELETHON_CODE_ALIGNMENT=applied")


if __name__ == "__main__":
    main()

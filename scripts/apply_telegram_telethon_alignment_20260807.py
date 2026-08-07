#!/usr/bin/env python3
"""One-off repository migration: align Telegram publishing with events-bot Telethon auth."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, *, label: str) -> str:
    if text.count(old) != 1:
        raise RuntimeError(f"{label}: expected exactly one source block, found {text.count(old)}")
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
        label="telegram publisher docstring",
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
        label="telegram auth loader",
    )
    text = replace_once(
        text,
        'bundle = _load_auth_bundle(os.getenv("TELEGRAM_AUTH_BUNDLE_GH_ACTIONS", ""))',
        '''bundle = _load_auth_bundle(
            os.getenv("TELEGRAM_AUTH_BUNDLE_GH_ACTIONS", ""),
            api_id_value=os.getenv("TG_API_ID", ""),
            api_hash_value=os.getenv("TG_API_HASH", ""),
        )''',
        label="telegram main auth call",
    )
    write(path, text)


def patch_telegram_workflow() -> None:
    path = ".github/workflows/telegram-publish.yml"
    text = read(path)
    text = replace_once(
        text,
        """      TELEGRAM_AUTH_BUNDLE_GH_ACTIONS: ${{ secrets.TELEGRAM_AUTH_BUNDLE_GH_ACTIONS }}\n      SOCIAL_COMMAND_JSON:""",
        """      TELEGRAM_AUTH_BUNDLE_GH_ACTIONS: ${{ secrets.TELEGRAM_AUTH_BUNDLE_GH_ACTIONS }}\n      TG_API_ID: ${{ secrets.TG_API_ID }}\n      TG_API_HASH: ${{ secrets.TG_API_HASH }}\n      SOCIAL_COMMAND_JSON:""",
        label="telegram workflow env",
    )
    text = replace_once(
        text,
        '''          [[ -n "${TELEGRAM_AUTH_BUNDLE_GH_ACTIONS:-}" ]] || {
            echo "::error::Repository secret TELEGRAM_AUTH_BUNDLE_GH_ACTIONS is absent."
            exit 1
          }''',
        '''          for name in TELEGRAM_AUTH_BUNDLE_GH_ACTIONS TG_API_ID TG_API_HASH; do
            [[ -n "${!name:-}" ]] || {
              echo "::error::Repository secret ${name} is absent."
              exit 1
            }
          done''',
        label="telegram workflow credential gate",
    )
    write(path, text)


def patch_readiness_workflow() -> None:
    write(
        ".github/workflows/social-secret-presence.yml",
        '''name: Social credential readiness

on:
  push:
    branches: [main]
    paths:
      - .github/social-secret-presence-trigger.txt
  workflow_dispatch:

permissions:
  contents: read

jobs:
  readiness:
    runs-on: ubuntu-24.04
    timeout-minutes: 3
    env:
      MAX_SESSION: ${{ secrets.MAX_SESSION }}
      TELEGRAM_AUTH_BUNDLE_GH_ACTIONS: ${{ secrets.TELEGRAM_AUTH_BUNDLE_GH_ACTIONS }}
      TG_API_ID: ${{ secrets.TG_API_ID }}
      TG_API_HASH: ${{ secrets.TG_API_HASH }}
      VK_ACCESS_TOKEN5: ${{ secrets.VK_ACCESS_TOKEN5 }}
    steps:
      - name: Verify minimal credentials without printing values
        shell: bash
        run: |
          set -euo pipefail
          python3 - <<'PY'
          import base64
          import json
          import os
          import sys

          required = (
              "MAX_SESSION",
              "TELEGRAM_AUTH_BUNDLE_GH_ACTIONS",
              "TG_API_ID",
              "TG_API_HASH",
              "VK_ACCESS_TOKEN5",
          )
          failed = False
          for name in required:
              present = bool((os.environ.get(name) or "").strip())
              print(f"SOCIAL_SECRET_{'PRESENT' if present else 'ABSENT'}={name}")
              failed = failed or not present

          raw = (os.environ.get("TELEGRAM_AUTH_BUNDLE_GH_ACTIONS") or "").strip()
          bundle = None
          if raw:
              attempts = [raw]
              for decoder in (base64.urlsafe_b64decode, base64.b64decode):
                  try:
                      padded = raw + ("=" * (-len(raw) % 4))
                      attempts.append(decoder(padded.encode("ascii")).decode("utf-8"))
                  except Exception:
                      pass
              for candidate in attempts:
                  try:
                      parsed = json.loads(candidate)
                  except Exception:
                      continue
                  if isinstance(parsed, dict):
                      bundle = parsed
                      break

          def find(payload, names):
              if not isinstance(payload, dict):
                  return None
              lowered = {str(key).casefold(): value for key, value in payload.items()}
              for name in names:
                  if name.casefold() in lowered:
                      return lowered[name.casefold()]
              for value in payload.values():
                  if isinstance(value, dict):
                      nested = find(value, names)
                      if nested not in (None, ""):
                          return nested
              return None

          session = find(bundle, ("session", "session_string", "string_session", "telegram_session"))
          session_present = session not in (None, "")
          print(f"TELEGRAM_BUNDLE_FIELD_{'PRESENT' if session_present else 'ABSENT'}=session")
          failed = failed or not session_present

          if failed:
              print("::error title=Social credentials not ready::One or more minimal credentials are absent.")
              sys.exit(1)
          print("SOCIAL_CREDENTIAL_READINESS=ready")
          PY
''',
    )


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


def patch_docs() -> None:
    readme_path = "README.md"
    readme = read(readme_path)
    old = '''| MAX | `MAX_SESSION` |
| Telegram | `TELEGRAM_AUTH_BUNDLE_GH_ACTIONS` |
| VK | `VK_ACCESS_TOKEN5` |

Telegram bundle должен содержать `api_id`, `api_hash`, `session` и при наличии стабильные device-поля. Отдельные Telegram API secrets не требуются. Текущий bundle пока содержит session/device identity без `api_id` и `api_hash`, поэтому Telegram write-path блокируется до дополнения того же secret.'''
    new = '''| MAX | `MAX_SESSION` |
| Telegram session/device identity | `TELEGRAM_AUTH_BUNDLE_GH_ACTIONS` |
| Telegram app credentials | `TG_API_ID`, `TG_API_HASH` |
| VK | `VK_ACCESS_TOKEN5` |

Telegram следует уже работающему contract Telegram Monitoring/Kaggle: готовая StringSession и device-поля находятся в `TELEGRAM_AUTH_BUNDLE_GH_ACTIONS`, а app credentials — в `TG_API_ID` и `TG_API_HASH`. Это не дополнительные сессии и не новый вход: одна существующая Telegram-сессия используется через Telethon.'''
    readme = replace_once(readme, old, new, label="README credential contract")
    write(readme_path, readme)

    docs_path = "docs/telegram-vk-automation.md"
    docs = read(docs_path)
    old_credentials = '''Единственный credential:

```text
TELEGRAM_AUTH_BUNDLE_GH_ACTIONS
```

Bundle должен быть самодостаточным URL-safe base64 JSON или обычным JSON:

```json
{
  "api_id": 123456,
  "api_hash": "...",
  "session": "...",
  "device_model": "...",
  "system_version": "...",
  "app_version": "...",
  "lang_code": "ru",
  "system_lang_code": "ru"
}
```

Обязательны только `api_id`, `api_hash` и `session`; device-поля сохраняют стабильную identity сессии. Отдельные GitHub secrets для API id/hash не нужны.'''
    new_credentials = '''Credentials совпадают с Telegram Monitoring/Kaggle:

```text
TELEGRAM_AUTH_BUNDLE_GH_ACTIONS
TG_API_ID
TG_API_HASH
```

`TELEGRAM_AUTH_BUNDLE_GH_ACTIONS` — URL-safe base64 JSON или обычный JSON с уже авторизованной StringSession и стабильными device-полями:

```json
{
  "session": "...",
  "device_model": "...",
  "system_version": "...",
  "app_version": "...",
  "lang_code": "ru",
  "system_lang_code": "ru"
}
```

`TG_API_ID` и `TG_API_HASH` — app credentials Telethon. Они не являются дополнительной Telegram-сессией и не требуют нового входа. Для обратной совместимости self-contained bundle с `api_id`/`api_hash` тоже принимается.'''
    docs = replace_once(docs, old_credentials, new_credentials, label="Telegram docs credential contract")
    old_state = '''### Текущее состояние bundle

На 7 августа 2026 года repository secret существует, но фактический bundle содержит `session` и device-поля без `api_id`/`api_hash`. Поэтому Telegram write-path корректно заблокирован до дополнения **того же самого secret**. Публичные или чужие Telegram app credentials как обход не используются.'''
    new_state = '''### Текущее состояние credentials

На 7 августа 2026 года `TELEGRAM_AUTH_BUNDLE_GH_ACTIONS` уже содержит готовую StringSession и device identity. Для запуска остаётся предоставить в этом же репозитории существующие project app credentials `TG_API_ID` и `TG_API_HASH`. Новая сессия, Telegram Desktop и browser automation не нужны. Публичные или чужие Telegram app credentials как обход не используются.'''
    docs = replace_once(docs, old_state, new_state, label="Telegram docs current state")
    write(docs_path, docs)


def remove_temporary_files() -> None:
    for path in (
        ".github/workflows/telegram-bundle-shape.yml",
        ".github/telegram-bundle-shape-trigger.txt",
        ".github/workflows/ops-probe-telegram-access-20260807.yml",
        ".github/workflows/maintenance-align-telegram-telethon.yml",
        ".github/workflows/apply-telegram-telethon-alignment-20260807.yml",
        "scripts/apply_telegram_telethon_alignment_20260807.py",
    ):
        (ROOT / path).unlink(missing_ok=True)


def main() -> None:
    patch_telegram_publisher()
    patch_telegram_workflow()
    patch_readiness_workflow()
    patch_tests()
    patch_docs()
    remove_temporary_files()
    print("TELEGRAM_TELETHON_ALIGNMENT=applied")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Apply the events-bot-new postponed VK identity contract to this repository."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one source block, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


def patch_publisher() -> None:
    replace_once(
        "scripts/vk_publish.py",
        "from social_registry import DestinationRegistry\n",
        "from social_registry import DestinationRegistry\n"
        "from vk_events_bot_contract import item_identity, resolve_postponed_item\n",
    )

    old = '''def _find_postponed(
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
'''
    new = '''def _wall_items(
    client: VkClient,
    *,
    group_id: int,
    wall_filter: str,
) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for page in range(MAX_POSTPONED_PAGES):
        response = client.api(
            "wall.get",
            owner_id=-group_id,
            filter=wall_filter,
            count=POSTPONED_PAGE_SIZE,
            offset=page * POSTPONED_PAGE_SIZE,
        )
        items = _post_items(response)
        found.extend(items)
        if len(items) < POSTPONED_PAGE_SIZE:
            break
    return found


def _find_postponed(
    client: VkClient,
    *,
    group_id: int,
    marker: str,
) -> list[dict[str, Any]]:
    return [
        item
        for item in _wall_items(client, group_id=group_id, wall_filter="postponed")
        if marker in _clean_text(item.get("text"))
    ]
'''
    replace_once("scripts/vk_publish.py", old, new)

    replace_once(
        "scripts/vk_publish.py",
        '''    return {
        "post_id": post_id,
        "attachment_types": types,
        "scheduled_epoch": int(post.get("date") or post.get("publish_date") or 0),
    }
''',
        '''    _, postponed_id = item_identity(post)
    return {
        "post_id": post_id,
        "postponed_id": postponed_id or None,
        "attachment_types": types,
        "scheduled_epoch": int(post.get("date") or post.get("publish_date") or 0),
    }
''',
    )

    old_post_commit = '''    matches = _find_postponed(client, group_id=group_id, marker=command.marker)
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
'''
    new_post_commit = '''    def fetch_items(wall_filter: str) -> list[dict[str, Any]]:
        return _wall_items(client, group_id=group_id, wall_filter=wall_filter)

    resolved = resolve_postponed_item(
        response_post_id=post_id,
        marker=command.marker,
        fetch_items=fetch_items,
    )
    if resolved is None:
        raise VkPublishError(
            "post-commit verification could not resolve wall.post response id "
            "through VK's postponed collection"
        )
    verified = _verify_matching_post(resolved, command=command, expected_epoch=expected_epoch)
    return {
        "schema": "social.vk.receipt.v1",
        "status": "scheduled",
        "request_id": command.request_id,
        "destination_key": destination.key,
        "community": verified_destination,
        "post_id": verified["post_id"],
        "wall_post_response_id": post_id,
        "postponed_id": verified["postponed_id"],
        "scheduled_at": command.scheduled_at.isoformat() if command.scheduled_at else None,
        "attachment_types": verified["attachment_types"],
        "image": image,
    }
'''
    replace_once("scripts/vk_publish.py", old_post_commit, new_post_commit)

    replace_once(
        "scripts/vk_publish.py",
        '''            "post_id": verified["post_id"],
            "scheduled_at": command.scheduled_at.isoformat() if command.scheduled_at else None,
            "attachment_types": verified["attachment_types"],
''',
        '''            "post_id": verified["post_id"],
            "postponed_id": verified["postponed_id"],
            "scheduled_at": command.scheduled_at.isoformat() if command.scheduled_at else None,
            "attachment_types": verified["attachment_types"],
''',
    )


def patch_tests() -> None:
    replace_once(
        "tests/test_social_publish_contracts.py",
        "import vk_publish  # noqa: E402\n",
        "import vk_publish  # noqa: E402\n"
        "import vk_events_bot_contract  # noqa: E402\n",
    )

    insertion = '''

class VkEventsBotPostponedIdentityTests(unittest.TestCase):
    def test_resolves_shifted_wall_item_id_from_postponed_id(self) -> None:
        calls = []
        item = {
            "id": 125,
            "postponed_id": 124,
            "text": "Caption\\n\\nMarker: TEST-124",
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


class CommandContractTests'''
    replace_once(
        "tests/test_social_publish_contracts.py",
        "\n\nclass CommandContractTests",
        insertion,
    )


def patch_docs() -> None:
    path = ROOT / "docs/telegram-vk-automation.md"
    text = path.read_text(encoding="utf-8")
    anchor = "Токен передаётся только POST body и не входит в сообщения ошибок или receipts.\n"
    block = '''Токен передаётся только POST body и не входит в сообщения ошибок или receipts.

### Канонический контракт `events-bot-new`

VK adapter не поддерживает отдельную изобретённую реализацию. Postponed identity
перенесена из `events-bot-new/main_part2.py` (`post_to_vk`,
`_resolve_vk_postponed_wall_id`, `_resolve_vk_postponed_wall_id_any_actor`) и
закреплена в `scripts/vk_events_bot_contract.py`.

Критический нюанс VK: `wall.post` может вернуть transient `post_id`, а
`wall.get(filter=postponed)` — другой wall item `id` с исходным значением в
`postponed_id`. Канонический receipt использует wall item `id`; проверка всегда
начинается с semantic collection `postponed`, а `all` остаётся только fallback.

API receipt сам по себе не считается полной первой приёмкой новой пары
`credential + community`: перед признанием destination готовым оператор должен
увидеть запись в VK UI. После такой первой UI-приёмки регулярные операции могут
использовать deterministic API verify по точному community identity, marker,
времени и attachments.
'''
    if text.count(anchor) != 1:
        raise RuntimeError("docs anchor not found exactly once")
    path.write_text(text.replace(anchor, block, 1), encoding="utf-8")

    readme = ROOT / "README.md"
    text = readme.read_text(encoding="utf-8")
    old = "Поддержаны `schedule_post`, `publish_now` и `verify` для PNG + текста. Перед commit проверяются точные `group_id`, `screen_name`, title, `is_admin=1`, `admin_level>=2` и postponed queue по marker. Загрузка изображения идёт через `photos.getWallUploadServer` → `photos.saveWallPhoto`, публикация — через `wall.post`, затем выполняется независимый `wall.get(filter=postponed)`.\n"
    new = old.rstrip("\n") + " Postponed-id resolution переиспользует канонический контракт `events-bot-new`: transient `wall.post.post_id` связывается с фактическим wall item `id` через `postponed_id`, с `filter=postponed` как source of truth. Первая готовность новой пары token/community требует также operator-visible UI acceptance.\n"
    if text.count(old) != 1:
        raise RuntimeError("README VK paragraph not found exactly once")
    readme.write_text(text.replace(old, new, 1), encoding="utf-8")


def main() -> None:
    patch_publisher()
    patch_tests()
    patch_docs()
    print("VK_EVENTS_BOT_CONTRACT_MIGRATION=applied")


if __name__ == "__main__":
    main()

# Telegram и VK: детерминированные публикации

## Общая модель

Telegram и VK используют единый command envelope из `contracts/social-command.schema.json` и единый реестр `config/social-destinations.public.json`.

Поддерживаемые операции первой версии:

- `schedule_post` — создать нативную отложенную публикацию;
- `publish_now` — опубликовать готовый материал сразу;
- `verify` — только проверить ранее созданную отложенную публикацию, ничего не создавать.

Для каждого запроса обязательны:

- стабильный `request_id`;
- logical key адресата;
- готовый текст;
- видимый уникальный `content.marker` внутри текста;
- PNG-изображение;
- явный timestamp с UTC offset для отложенной публикации.

Исполнители сериализованы отдельными GitHub Actions concurrency-группами. Они не создают screenshots, DOM dumps, traces или Actions artifacts.

## VK

Workflow:

```text
.github/workflows/vk-publish.yml
```

Исполнитель:

```text
scripts/vk_publish.py
```

Credential:

```text
VK_ACCESS_TOKEN5
```

Перед записью исполнитель:

1. разрешает logical key через общий реестр;
2. вызывает `groups.getById`;
3. требует точное совпадение `group_id`, `screen_name` и названия;
4. требует `is_admin=1` и `admin_level>=2`;
5. просматривает postponed queue и ищет marker;
6. при точном существующем совпадении возвращает `already_scheduled` без загрузки нового файла.

Commit-path:

1. `photos.getWallUploadServer`;
2. приватная multipart-загрузка PNG;
3. `photos.saveWallPhoto`;
4. `wall.post` с `owner_id=-group_id`, `from_group=1`, `signed=0` и `publish_date`;
5. новый `wall.get(filter=postponed)`;
6. проверка точного текста, времени, post id и photo attachment.

Токен передаётся только POST body и не входит в сообщения ошибок или receipts.

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

### Live-результат 7 августа 2026 года

В `Полюбить Калининград Анонсы` (`kenigeventsofficial`, group `231828790`) поставлена нативная отложенная тестовая публикация с PNG на:

```text
2026-08-07T21:00:00+02:00
```

Первичный run создал postponed post `1631`; независимый `verify` run повторно нашёл тот же post, точный текст, время и photo attachment, ничего не загрузив и не создав повторно.

## Telegram

Workflow:

```text
.github/workflows/telegram-publish.yml
```

Исполнитель:

```text
scripts/telegram_publish.py
```

Telegram не использует Desktop-клиент, Telegram Web или Playwright. Исполнение идёт напрямую через Telethon, по тому же контракту, который уже работает в Telegram Monitoring/Kaggle проекта `events-bot-new`.

Credentials:

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

`TG_API_ID` и `TG_API_HASH` — app credentials Telethon. Они не являются дополнительной Telegram-сессией, не требуют нового входа и не меняют существующий auth key. Для обратной совместимости self-contained bundle с `api_id` и `api_hash` также принимается, но канонический путь совпадает с Telegram Monitoring: bundle + отдельная пара app credentials.

Перед записью исполнитель:

1. декодирует bundle без печати значений;
2. создаёт `TelegramClient(StringSession(session), TG_API_ID, TG_API_HASH, **device_fields)`;
3. проверяет авторизацию готовой StringSession;
4. разрешает channel username либо точный dialog title;
5. требует broadcast channel и `creator` либо `admin_rights.post_messages`;
6. читает нативную scheduled queue через `messages.getScheduledHistory` и ищет marker;
7. возвращает `already_scheduled` при точном совпадении.

Commit-path использует `Telethon.send_file(..., schedule=<UTC datetime>)`, после чего повторно читает scheduled queue и требует один объект с точным caption, временем, message id и photo media. Для защиты от краткой eventual consistency post-commit проверка выполняет ограниченные повторы.

### Live-результат 7 августа 2026 года

Credential readiness подтверждён в `onedayonemasterpiece/social-communications`: готовая StringSession, `TG_API_ID` и `TG_API_HASH` доступны без повторной авторизации.

В Telegram-канале `@kenigevents` (`Полюбить Калининград |️ Анонсы`) поставлена нативная отложенная тестовая публикация с PNG на:

```text
2026-08-07T21:00:00+02:00
```

Telegram message id:

```text
2629
```

Первичная запись создала scheduled message. Независимый `verify` run через `messages.getScheduledHistory` подтвердил точный caption, marker, время и photo media и вернул `already_scheduled`, не создавая дубль.

## Command example

```json
{
  "version": 1,
  "request_id": "sc-example-20260807-2100",
  "platform": "vk",
  "operation": "schedule_post",
  "destination": "polubit-kaliningrad-anonsy",
  "scheduled_at": "2026-08-07T21:00:00+02:00",
  "content": {
    "text": "Готовый текст\n\nМетка: SC-EXAMPLE-001",
    "marker": "SC-EXAMPLE-001",
    "image": {
      "path": "generated/social-test-post.png",
      "alt": "Описание изображения"
    },
    "links": [
      {
        "text": "Сайт",
        "url": "https://kenigevents.ru/"
      }
    ]
  }
}
```

## Privacy и evidence

По умолчанию workflow сохраняет только GitHub log и Step Summary с минимальным receipt:

- status;
- request id;
- logical destination;
- публичный channel/community identifier;
- post/message id;
- scheduled timestamp;
- тип media.

Локальные command, receipt и generated image удаляются в финальном шаге runner. Actions artifacts не создаются. При будущей диагностике artifacts допустимы только по явному opt-in и должны удаляться сразу после анализа.

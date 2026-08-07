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

Единственный credential:

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

Обязательны только `api_id`, `api_hash` и `session`; device-поля сохраняют стабильную identity сессии. Отдельные GitHub secrets для API id/hash не нужны.

Перед записью исполнитель:

1. декодирует bundle без печати значений;
2. проверяет авторизацию StringSession;
3. разрешает channel username либо точный dialog title;
4. требует broadcast channel и `creator` либо `admin_rights.post_messages`;
5. просматривает scheduled messages по marker;
6. возвращает `already_scheduled` при точном совпадении.

Commit-path использует `Telethon.send_file(..., schedule=<UTC datetime>)`, после чего заново читает scheduled messages и требует один объект с точным caption, временем, message id и photo media.

### Текущее состояние bundle

На 7 августа 2026 года repository secret существует, но фактический bundle содержит `session` и device-поля без `api_id`/`api_hash`. Поэтому Telegram write-path корректно заблокирован до дополнения **того же самого secret**. Публичные или чужие Telegram app credentials как обход не используются.

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

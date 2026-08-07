# Social Communications

Единый репозиторий для детерминированной работы с MAX, Telegram и VK: найти проверенный адресат, подготовить готовый материал, поставить публикацию в отложку или отправить сейчас, а затем независимо проверить результат.

## Каноническая инструкция для публикации сразу в три места

Для любой будущей задачи на одну публикацию в MAX, Telegram и VK сначала читать и выполнять:

**[`docs/three-platform-publication-runbook.md`](docs/three-platform-publication-runbook.md)**

Это единая оперативная точка входа. При расхождении со старыми отчётами или разовыми диагностическими файлами приоритет имеет runbook и актуальный код `main`.

## Единый реестр адресатов

Канонический публичный реестр:

```text
config/social-destinations.public.json
```

В нём зарегистрированы:

- `polubit-kaliningrad-afisha` — Telegram `@kldevents`, VK `klgdevents`;
- `polubit-kaliningrad-anonsy` — Telegram `@kenigevents`, VK `kenigeventsofficial`, MAX;
- `uh-ty-kaliningrad` — VK `uhtykaliningrad`, MAX и точный Telegram dialog title до подтверждения username;
- `polubit-kaliningrad` — Telegram `@lovekenig`.

Пользователь может назвать адресат разговорно или с небольшой опечаткой. Ассистент переводит формулировку в stable key, но commit-path остаётся детерминированным: исполнитель проверяет фактический username, community id или точный заголовок и требует ровно одного адресата.

Подробнее: [`docs/social-destination-registry.md`](docs/social-destination-registry.md).

## Credentials

Минимальный комплект repository secrets:

| Назначение | Secret |
|---|---|
| MAX | `MAX_SESSION` |
| Telegram StringSession и device identity | `TELEGRAM_AUTH_BUNDLE_GH_ACTIONS` |
| Telegram app credentials | `TG_API_ID`, `TG_API_HASH` |
| VK | `VK_ACCESS_TOKEN5` |

Telegram использует тот же контракт, что Telegram Monitoring/Kaggle в `events-bot-new`: готовая авторизованная StringSession и стабильные device-поля находятся в `TELEGRAM_AUTH_BUNDLE_GH_ACTIONS`, а app credentials Telethon — в `TG_API_ID` и `TG_API_HASH`. Это одна существующая Telegram-сессия; новый вход, Telegram Desktop, Telegram Web и browser automation не нужны.

## MAX Web

Воспроизводимый Playwright-контур для официальной веб-версии MAX поддерживает:

- адресацию по stable key, точному названию либо неточному запросу;
- fail-closed разрешение чатов, групп и каналов без выбора первого похожего результата;
- безопасную немедленную отправку через `Отложенные сообщения → Отправить сейчас`;
- нативную отправку в заданное время;
- режим `stage_only` для подготовки и проверки без доставки;
- текст, изображение, подпись и форматированные HTTPS-ссылки;
- атомарную вставку готового текста через Clipboard API;
- независимую проверку после commit-point;
- защиту от повторной отправки.

Основной workflow: [`.github/workflows/max-send.yml`](.github/workflows/max-send.yml).

Архитектура: [`docs/max-messenger-automation.md`](docs/max-messenger-automation.md).

MAX-проекция общего реестра: [`docs/max-destination-registry.md`](docs/max-destination-registry.md).

Командный контракт MAX version 2: [`contracts/max-command.schema.json`](contracts/max-command.schema.json).

### Невидимая подготовка

Для `delivery.mode=send_now` обычная прямая отправка не используется. Содержимое предварительно валидируется, атомарно помещается в композер, создаётся как нативное отложенное сообщение, проверяется в списке отложенных и только затем переводится в опубликованное через `Отправить сейчас`.

Live-тест доказал отсутствие промежуточного сообщения в основной ленте до commit-point. Отсутствие recipient-side typing/push signals всё ещё требует отдельной двухсторонней проверки со вторым аккаунтом.

### Сохранённая MAX-сессия

Предпочтительное значение `MAX_SESSION`:

```text
MAX_SESSION_V2_GZIP_BASE64=...
```

Префикс является частью значения, а не именем отдельного secret. Сессия должна восстанавливать авторизованный `https://web.max.ru/` в новом browser context.

Экспорт из уже авторизованной вкладки:

1. открыть `https://web.max.ru/`;
2. открыть DevTools → Sources → Snippets;
3. выполнить `scripts/max-session-export-console.js`;
4. сохранить полное содержимое `max_session-*.txt` в `MAX_SESSION`.

## Telegram

Workflow:

```text
.github/workflows/telegram-publish.yml
```

Исполнитель:

```text
scripts/telegram_publish.py
```

Исполнитель работает напрямую через Telethon `TelegramClient(StringSession(...), TG_API_ID, TG_API_HASH)` и повторяет проверенный подход Telegram Monitoring/Kaggle. Поддержаны `schedule_post`, `publish_now` и `verify` для PNG + caption. Перед отправкой проверяются авторизация, точный channel identity, broadcast type, право `post_messages`, idempotency marker и существующие scheduled messages. GitHub Actions сериализует все обращения к `TELEGRAM_AUTH_BUNDLE_GH_ACTIONS`, чтобы одна StringSession не использовалась параллельно внутри репозитория.

## VK

Workflow:

```text
.github/workflows/vk-publish.yml
```

Исполнитель:

```text
scripts/vk_publish.py
```

Поддержаны `schedule_post`, `publish_now` и `verify` для PNG + текста. Перед commit проверяются точные `group_id`, `screen_name`, title, `is_admin=1`, `admin_level>=2` и postponed queue по marker. Загрузка изображения идёт через `photos.getWallUploadServer` → `photos.saveWallPhoto`, публикация — через `wall.post`, затем выполняется независимый `wall.get(filter=postponed)`. Postponed-id resolution переиспользует канонический контракт `events-bot-new`: transient `wall.post.post_id` связывается с фактическим wall item `id` через `postponed_id`, с `filter=postponed` как source of truth. Первая готовность новой пары token/community требует также operator-visible UI acceptance.

7 августа 2026 года live-run поставил тестовый PNG-пост в `Полюбить Калининград Анонсы` (`kenigeventsofficial`, group `231828790`) на 21:00 Europe/Kaliningrad. Отдельный verify-run подтвердил тот же post id, время и photo attachment без повторной загрузки.

Общая документация Telegram/VK: [`docs/telegram-vk-automation.md`](docs/telegram-vk-automation.md).

Общий command schema: [`contracts/social-command.schema.json`](contracts/social-command.schema.json).

## LLM-граница

LLM может помочь только на смысловом уровне: понять пользовательскую формулировку, выбрать logical key, подготовить финальный текст и предложить поисковые варианты при диагностике. LLM не получает credentials и не выбирает DOM/API commit operation.

Опасные действия выполняются только детерминированными адаптерами с точной проверкой адресата и прав. При неоднозначности операция блокируется либо запрашивает одно уточнение.

## Privacy и evidence

Обычные Telegram/VK workflows не создают Actions artifacts вообще. Command, receipt и generated test image удаляются с runner после выполнения. В логах остаётся только минимальный публичный receipt: status, request id, destination key, публичный channel/community identifier, post/message id, scheduled time и media type.

MAX diagnostics допускают краткоживущие screenshots/DOM только по явному opt-in. После анализа artifacts должны быть удалены; постоянное публичное хранение личного интерфейса запрещено.

# Канонический runbook: одна публикация в MAX, Telegram и VK

> **Это единственная оперативная инструкция для будущих задач на одновременную публикацию в трёх каналах.**
>
> При конфликте с README, старым отчётом, разовой диагностикой или памятью агента приоритет имеет этот документ и актуальный код `main` репозитория `onedayonemasterpiece/social-communications`.

## 1. Подтверждённое состояние

На 7 августа 2026 года проверены все три исполнительных контура:

| Платформа | Фактически проверено | Канонический исполнитель |
|---|---|---|
| MAX | отправка текста; нативная отложенная отправка; rich post с PNG, текстом и форматированной HTTPS-ссылкой; безопасная подготовка через отложенные; точное разрешение часто используемых каналов | `.github/workflows/max-send.yml` → `scripts/max-safe-send.mjs` |
| Telegram | нативная отложенная публикация PNG + caption через готовую StringSession; запись в `@kenigevents` была видна оператору в отложенных | `.github/workflows/telegram-publish.yml` → `scripts/telegram_publish.py` |
| VK | нативная отложенная публикация PNG + текст в `kenigeventsofficial`, group `231828790`; запись была видна оператору в отложенных | `.github/workflows/vk-publish.yml` → `scripts/vk_publish.py` + `scripts/vk_events_bot_contract.py` |

Граница доказанного для MAX: полный send-path проверен в «Тестовой группе», а каналы `Полюбить Калининград Анонсы` и `Ух ты, Калининград!` отдельно разрешены и открыты read-only smoke-test. Для Telegram и VK exact destination `Полюбить Калининград Анонсы` проверен end-to-end с операторским просмотром отложенной публикации.

## 2. Непереговорные правила

1. Работать только в `onedayonemasterpiece/social-communications` и сначала читать актуальный `main` этого документа.
2. Адресат задаётся logical key из `config/social-destinations.public.json`; неточное пользовательское название можно понять семантически, но commit-path обязан проверить точную платформенную identity.
3. **Telegram:** только Telethon + готовая `TELEGRAM_AUTH_BUNDLE_GH_ACTIONS`. Не использовать Telegram Desktop, Telegram Web, QR-код, Playwright или новую авторизацию.
4. **VK:** не создавать новый API-клиент и не переизобретать postponed-поведение. Использовать перенесённый контракт `events-bot-new`: `vk_publish.py` + `vk_events_bot_contract.py`.
5. **MAX:** только сохранённая `MAX_SESSION` и recipient-invisible staged flow. Для `send_now` прямой ввод с немедленным нажатием отправки запрещён.
6. Для синхронной публикации во всех трёх местах использовать один общий `publish_at` с явным UTC offset. Он должен быть не менее чем на 10 минут в будущем: это покрывает наиболее строгий текущий VK lead-time.
7. Не выбирать первый похожий чат, канал или сообщество. При неоднозначности операция прекращается до загрузки изображения и до отправки.
8. Не делать слепой retry после ошибки. Сначала выполнить `verify` по тому же destination, времени и marker, чтобы не создать дубль.
9. Не объявлять общий `PASS`, пока не подтверждены все три платформы отдельно.
10. По умолчанию не создавать screenshots, DOM dumps, traces и Actions artifacts. Временные evidence удалять сразу после анализа.

## 3. Канонические адресаты

Источник истины: [`config/social-destinations.public.json`](../config/social-destinations.public.json).

| Logical key | Telegram | VK | MAX | Готовность к одной задаче на все три |
|---|---|---|---|---|
| `polubit-kaliningrad-anonsy` | `@kenigevents` | `kenigeventsofficial`, group `231828790` | `Полюбить Калининград Анонсы` | **готово** |
| `polubit-kaliningrad-afisha` | `@kldevents` | `klgdevents`, group `231920894` | — | только Telegram + VK |
| `uh-ty-kaliningrad` | exact dialog title; публичный username ещё не закреплён | `uhtykaliningrad`, group `238875824` | `Ух ты, Калининград!` | Telegram требует authenticated exact-title preflight |
| `polubit-kaliningrad` | `@lovekenig` | — | — | только Telegram |

Если пользователь просит «во все три» без уточнения, а из контекста следует «Полюбить Калининград Анонсы», использовать:

```text
polubit-kaliningrad-anonsy
```

Для другого logical key нельзя молча выдумывать отсутствующую платформу.

## 4. Минимальные credentials

| Платформа | Repository secrets |
|---|---|
| MAX | `MAX_SESSION` |
| Telegram | `TELEGRAM_AUTH_BUNDLE_GH_ACTIONS`, `TG_API_ID`, `TG_API_HASH` |
| VK | `VK_ACCESS_TOKEN5` |

`TG_API_ID` и `TG_API_HASH` — application credentials Telethon, а не дополнительные сессии. Единственная готовая Telegram-сессия находится в `TELEGRAM_AUTH_BUNDLE_GH_ACTIONS`.

Значения secrets не читать, не печатать, не включать в receipts и не переносить в command JSON.

## 5. Что нужно нормализовать из пользовательской задачи

Перед запуском получить или однозначно вывести:

```yaml
destination_key: polubit-kaliningrad-anonsy
publish_mode: schedule_at | send_now
publish_at: 2026-08-08T11:00:00+02:00   # обязателен для schedule_at
text: окончательный текст без черновых фрагментов
image: один окончательный PNG
links:
  - text: видимый текст ссылки
    url: https://example.org/
request_stem: sc-<смысловой-slug>-<YYYYMMDD-HHMM>
```

### Контентные ограничения

- Использовать один окончательный PNG; проверенный безопасный предел — до 20 MiB.
- Telegram photo caption сейчас ограничен консервативными 1024 символами. Если master text длиннее, сократить Telegram-проекцию до запуска; не обрезать молча.
- VK допускает более длинный текст, но текущий контракт ограничивает его 15 000 символами.
- MAX поддерживает форматированные HTTPS-ссылки через `links[]`.
- Telegram и VK в текущем исполнительном контракте должны получать видимый HTTPS URL внутри итогового текста. Поле `links[]` не заменяет URL в caption/message.
- `marker` для Telegram и VK — уникальный стабильный фрагмент, уже присутствующий в окончательном тексте. В production предпочтительна естественная уникальная строка или URL; техническую строку вида `SC-TEST-*` добавлять только в тестовые публикации.

Использовать связанные идентификаторы:

```text
<request_stem>:max
<request_stem>:telegram
<request_stem>:vk
```

## 6. Стандартный порядок одной публикации во все три места

### Шаг 1. Preflight без записи

1. Прочитать этот runbook и актуальный реестр адресатов.
2. Проверить наличие secrets без вывода значений.
3. Подготовить окончательные platform projections текста.
4. Проверить PNG, ссылки, лимиты длины и единый timestamp.
5. Разрешить destination на каждой платформе и проверить точную identity и права.
6. Выполнить поиск существующего объекта по marker/request identity.

До успешного завершения preflight нельзя загружать изображение в VK, открывать MAX composer или вызывать Telegram send API.

### Шаг 2. Создание отложенных объектов

Для общей публикации предпочтителен `schedule_at` на один timestamp:

1. MAX — создать нативное отложенное сообщение и проверить его в разделе отложенных.
2. Telegram — `Telethon.send_file(..., schedule=<UTC datetime>)`.
3. VK — загрузить фото и вызвать `wall.post(..., publish_date=<epoch>)`.

Три workflow имеют отдельные concurrency-группы и могут выполняться параллельно после общего preflight. Общий статус всё равно собирается только после завершения всех трёх.

### Шаг 3. Независимая проверка

Повторно, без создания новых объектов:

- MAX: открыть exact destination и проверить staged/scheduled item либо финальное сообщение;
- Telegram: прочитать `messages.getScheduledHistory` и найти ровно один объект с точными caption, marker, временем и photo media;
- VK: прочитать `wall.get(filter=postponed)` и найти ровно один объект с точными text, marker, временем и photo attachment.

### Шаг 4. Итог

Результат должен иметь матрицу:

```yaml
max: verified | failed | already_present
telegram: verified | failed | already_present
vk: verified | failed | already_present
overall: pass | partial | fail
```

`overall: pass` допустим только при подтверждении всех трёх.

## 7. Канонические команды

### 7.1 MAX version 2

```json
{
  "version": 2,
  "requestId": "<request_stem>:max",
  "destination": {
    "key": "polubit-kaliningrad-anonsy",
    "kind": "channel"
  },
  "content": {
    "type": "rich_post",
    "text": "<final MAX text>",
    "image": {
      "path": "<runner-local PNG path>"
    },
    "links": [
      {
        "text": "<visible link text>",
        "url": "https://example.org/"
      }
    ]
  },
  "delivery": {
    "mode": "schedule_at",
    "scheduleAt": "2026-08-08T11:00:00+02:00",
    "timeZone": "Europe/Kaliningrad",
    "recipientInvisiblePreparation": true,
    "reuseExistingStage": true
  },
  "verifyOnly": false
}
```

Workflow: [`.github/workflows/max-send.yml`](../.github/workflows/max-send.yml).

Для проверки повторить ту же команду с:

```json
"verifyOnly": true
```

Для буквального `send_now` MAX всё равно обязан пройти внутреннюю цепочку:

```text
создать в отложенных → проверить staged item → Отправить сейчас → проверить в новом browser context
```

### 7.2 Telegram

```json
{
  "version": 1,
  "request_id": "<request_stem>:telegram",
  "platform": "telegram",
  "operation": "schedule_post",
  "destination": "polubit-kaliningrad-anonsy",
  "scheduled_at": "2026-08-08T11:00:00+02:00",
  "content": {
    "text": "<final Telegram caption with visible https URL and natural unique marker>",
    "marker": "<unique fragment already present in text>",
    "image": {
      "path": "<runner-local PNG path>",
      "alt": "<image description>"
    },
    "links": [
      {
        "text": "<visible link text>",
        "url": "https://example.org/"
      }
    ]
  }
}
```

Workflow: [`.github/workflows/telegram-publish.yml`](../.github/workflows/telegram-publish.yml).

Проверка — та же команда с:

```json
"operation": "verify"
```

Не заменять этот путь Telegram Desktop/Web automation.

### 7.3 VK

```json
{
  "version": 1,
  "request_id": "<request_stem>:vk",
  "platform": "vk",
  "operation": "schedule_post",
  "destination": "polubit-kaliningrad-anonsy",
  "scheduled_at": "2026-08-08T11:00:00+02:00",
  "content": {
    "text": "<final VK text with visible https URL and natural unique marker>",
    "marker": "<unique fragment already present in text>",
    "image": {
      "path": "<runner-local PNG path>",
      "alt": "<image description>"
    },
    "links": [
      {
        "text": "<visible link text>",
        "url": "https://example.org/"
      }
    ]
  }
}
```

Workflow: [`.github/workflows/vk-publish.yml`](../.github/workflows/vk-publish.yml).

Проверка — та же команда с:

```json
"operation": "verify"
```

VK postponed identity обязана разрешаться через [`scripts/vk_events_bot_contract.py`](../scripts/vk_events_bot_contract.py):

```text
wall.post response post_id
→ wall.get(filter=postponed)
→ match item.id == response id OR item.postponed_id == response id
→ дополнительно exact marker
→ receipt использует фактический postponed wall item id
```

`filter=all` — только compatibility fallback. `wall.getById` не считается источником истины для отложенных записей.

Ошибка VK `214: a post is already scheduled for this time` означает занятый timestamp. Нельзя повторять `wall.post` в тот же слот: сначала найти существующий postponed item и либо признать его ожидаемым, либо выбрать новый timestamp.

## 8. Как запускать workflows

Предпочтительный путь — `workflow_dispatch` с `command_json`: содержимое публикации не попадает в Git history.

Постоянные command files существуют как технический fallback:

```text
.github/max-live-command.json
.github/telegram-live-command.json
.github/vk-live-command.json
```

Использовать push-trigger допустимо только для материала, который всё равно предназначен для публичной публикации. Удаление или замена файла не удаляет прежнее содержимое из Git history.

Изображение должно существовать только как runner-local file к моменту запуска adapter. Не коммитить непубличные или embargoed изображения в открытый репозиторий. Временные файлы удаляются в финальном cleanup step.

## 9. Failure и retry

### До commit-point

Остановиться без публикации при любом из условий:

- destination отсутствует на одной из запрошенных платформ;
- найдено ноль или больше одного exact destination;
- не подтверждены права;
- изображение, текст, ссылка или timestamp не проходят preflight;
- marker уже встречается более одного раза в очереди;
- один из credentials отсутствует.

### После неопределённого результата

Если transport оборвался после возможного commit:

1. не запускать `schedule_post`/`publish_now` повторно;
2. выполнить `verify`;
3. при одном exact match вернуть `already_present`/`already_scheduled`;
4. при нуле exact matches разрешить ограниченный retry;
5. при нескольких matches остановиться для ручного разбора.

### Частичный результат

Если объект создан только на части платформ:

- честно вернуть `overall: partial`;
- перечислить exact IDs и статусы;
- не маскировать partial зелёным workflow;
- не создавать дубли на успешных платформах;
- перед исправлением упавшей платформы сначала повторно проверить уже успешные.

## 10. Privacy и очистка

- `MAX_CAPTURE_EVIDENCE=false` по умолчанию.
- Telegram и VK workflows не должны создавать Actions artifacts.
- MAX screenshots/DOM допустимы только для диагностики и должны быть обрезаны, иметь минимальный retention и удаляться сразу после анализа.
- После каждого запуска удалить command, receipt, PNG и временные каталоги с runner.
- Проверить repository artifacts API: ожидается `total_count: 0` после завершённой диагностики.
- Не выводить cookies, StringSession, токены, upload URLs, полный список личных чатов или закрытый DOM.

## 11. Definition of Done

Публикация во все три места считается выполненной только когда одновременно доказано:

- logical destination один и тот же;
- exact Telegram username/title, VK group id/screen name и MAX title совпали с реестром;
- текст соответствует каждой утверждённой platform projection;
- PNG присутствует;
- ссылки корректны;
- timestamp совпадает;
- на каждой платформе найден ровно один объект;
- повторный verify не создаёт дубль;
- общий итог — `pass`;
- временных Actions artifacts не осталось.

## 12. Файлы — источники исполнения

- реестр: [`config/social-destinations.public.json`](../config/social-destinations.public.json);
- общий Telegram/VK contract: [`contracts/social-command.schema.json`](../contracts/social-command.schema.json);
- MAX contract: [`contracts/max-command.schema.json`](../contracts/max-command.schema.json);
- MAX workflow: [`.github/workflows/max-send.yml`](../.github/workflows/max-send.yml);
- Telegram workflow: [`.github/workflows/telegram-publish.yml`](../.github/workflows/telegram-publish.yml);
- VK workflow: [`.github/workflows/vk-publish.yml`](../.github/workflows/vk-publish.yml);
- Telegram adapter: [`scripts/telegram_publish.py`](../scripts/telegram_publish.py);
- VK adapter: [`scripts/vk_publish.py`](../scripts/vk_publish.py);
- перенесённый canonical VK postponed contract: [`scripts/vk_events_bot_contract.py`](../scripts/vk_events_bot_contract.py);
- MAX architecture: [`docs/max-messenger-automation.md`](max-messenger-automation.md);
- Telegram/VK details: [`docs/telegram-vk-automation.md`](telegram-vk-automation.md).

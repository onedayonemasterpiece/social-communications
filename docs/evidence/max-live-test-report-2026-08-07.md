# MAX live test report — 2026-08-07

## Контур

- repository: `onedayonemasterpiece/social-communications`;
- session source: repository secret `MAX_SESSION`;
- browser: Playwright Chromium;
- target chat: `Тестовая группа`;
- target membership during tests: только владелец аккаунта;
- executor: deterministic, fail-closed;
- LLM внутри браузерного commit-path: не использовалась.

## 1. Нативная отложенная отправка

### Создание

- GitHub Actions run: `31154520813`;
- result: `status=pass`, `outcome=scheduled`;
- requestId: `max-test-scheduled-20260808-1100-retry2`;
- target timestamp: `2026-08-08T11:00:00+02:00`;
- timezone: `Europe/Kaliningrad`;
- выбранный месяц: `Август 2026`;
- подтверждающая кнопка перед commit-point: `Отправить завтра в 11:00`;
- после подтверждения composer очистился, schedule dialog закрылся;
- в `Отложенных сообщениях` присутствовали точный текст, метка `Завтра` и время `11:00`.

### Независимая проверка без отправки

- GitHub Actions run: `31155269244`;
- result: `status=pass`, `outcome=verified_existing`;
- `verifyOnly=true`;
- ожидаемый staged-объект найден повторно;
- дубль не создавался.

## 2. Первый rich post и структурный verifier

### Первая публикация

- GitHub Actions run: `31154653291`;
- requestId: `max-test-rich-post-20260807-1`;
- image: детерминированный PNG 640×360;
- text: `Тест публикации с изображением и форматированной ссылкой.`;
- visible link text: `Открыть «Полюбить Калининград»`;
- href: `https://kenigevents.ru/`.

Перед commit-point были проверены изображение, настоящий `<a>`, видимый текст и canonical href. Старый verifier дал ложный отрицательный результат из-за объединения подписи и ссылки в один message-container. Сохранённые DOM и screenshot подтвердили фактическую публикацию.

### Защита от дубля

- GitHub Actions run: `31155001727`;
- result: `status=pass`, `outcome=already_present`;
- один message-container одновременно содержал текст, изображение и точный href;
- повторная загрузка и отправка не выполнялись.

## 3. Исследование нативного staged-object

Контекстное меню отложенного сообщения в live MAX подтвердило команды:

- `Отправить сейчас`;
- `Изменить время`;
- `Редактировать`;
- `Скопировать текст`;
- `Выбрать`;
- `Удалить`.

Это позволило перейти от прямой публикации к двухфазной схеме `stage → verify → commit`.

## 4. Неоднозначное и неточное название адресата

### Реальная неоднозначность

Запрос `тестовая` показал несколько правдоподобных адресатов, включая `Тестовая`, `Тестовая группа` и `Тестовая среда для розыгрыша`. Run `31157409199` завершился fail-closed до композера и до создания staged-объекта.

### Опечатка

Запрос `тестовая група` не дал правильного результата при буквальном поиске MAX. Resolver безопасно расширил поисковый запрос до prefix `тестовая груп`, отдельно оценил отображаемые заголовки и выбрал `Тестовая группа` с проверкой заголовка уже открытого чата.

## 5. Staged text → send now

### Первая отправка

- GitHub Actions run: `31158262330`;
- requestId: `max-safe-stage-send-now-text-20260807-3`;
- destination query: `тестовая група`;
- search query used: `тестовая груп`;
- resolved title: `Тестовая группа`;
- strategy: `deterministic-fuzzy-expanded`;
- text inserted through one atomic clipboard paste;
- staged timestamp: `2026-09-06T07:36:00Z`;
- staged object found exactly once in `Отложенных сообщениях`;
- commit performed through `Отправить сейчас`;
- fresh browser context found the final text in the main chat;
- result: `status=pass`, `outcome=sent_via_staging`.

До commit-point текст существовал только в `Отложенных сообщениях`, после commit-point — в основном чате.

### Идемпотентность

- GitHub Actions run: `31158443189`;
- result: `status=pass`, `outcome=already_present`;
- существующий финальный текст найден до staging;
- новый staged-объект и дубль не создавались.

## 6. Staged rich post → send now

### Первая отправка

- GitHub Actions run: `31158690300`;
- requestId: `max-safe-stage-rich-post-20260807-1`;
- destination resolution: `тестовая група` → `тестовая груп` → `Тестовая группа`;
- content: PNG 640×360, подпись и форматированная ссылка;
- visible link text: `Открыть календарь событий`;
- href: `https://kenigevents.ru/`;
- caption inserted atomically through HTML Clipboard API;
- Lexical composer contained a real `<a>` with the expected href;
- staged object contained text, media and matching formatted link;
- staged timestamp: `2026-09-06T07:43:00Z`;
- commit performed through `Отправить сейчас`;
- fresh context found one final message-container with text, media and exact href;
- result: `status=pass`, `outcome=sent_via_staging`.

### Идемпотентность

- GitHub Actions run: `31158921023`;
- result: `status=pass`, `outcome=already_present`;
- existing final rich post found before file upload and before staging;
- дубль не создан.

## 7. Граница подтверждённой невидимости

Доказано на стороне отправителя:

- до commit-point staged-объект отсутствовал в основной ленте чата;
- staged-объект был доступен только через `Отложенные сообщения`;
- после `Отправить сейчас` материал появился в основной ленте;
- весь готовый текст вставлялся одной paste-операцией;
- повторные проверки не создавали дублей.

Не доказано наблюдением со стороны реального получателя, поскольку в `Тестовой группе` был только владелец аккаунта:

- отсутствие recipient-side push/message-notification до commit-point;
- отсутствие индикатора `печатает…` во время atomic paste;
- отсутствие иных recipient-side presence-сигналов.

Поэтому этот отчёт не использует формулировку «получатель гарантированно ничего не заметит» до проведения отдельного теста со вторым аккаунтом. Нативный staged-flow предотвращает появление промежуточного сообщения в основной ленте, но recipient-side notification evidence ещё требуется.

## 8. Артефакты

Для live-отладки использовались screenshots, ограниченные DOM-сводки и JSON receipts. После анализа все GitHub Actions artifacts были удалены.

Финальная проверка repository artifacts API:

```text
total_count: 0
artifacts: []
```

Локальные ZIP, screenshots, DOM-сводки и временные каталоги также удалены.

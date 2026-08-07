# MAX live test report — 2026-08-07

## Контур

- repository: `onedayonemasterpiece/social-communications`;
- session source: repository secret `MAX_SESSION`;
- browser: Playwright Chromium;
- target chat: `Тестовая группа`;
- target resolution: одно точное видимое совпадение плюс проверка заголовка открытого чата;
- LLM: не использовалась.

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
- визуальное evidence показывало раздел `Отложенные сообщения`, точный текст, метку `Завтра` и время `11:00`.

### Независимая повторная проверка без отправки

- GitHub Actions run: `31155269244`;
- result: `status=pass`, `outcome=verified_existing`;
- requestId: `max-test-scheduled-20260808-1100-verify-only`;
- `verifyOnly=true`, commit-point отправки не выполнялся;
- verifier повторно открыл `Тестовая группа`, затем `Отложенные сообщения`;
- найдено сообщение с точным текстом и временем `11:00`;
- повторное отложенное сообщение не создавалось.

## 2. Rich post: изображение, текст и форматированная ссылка

### Первая отправка

- GitHub Actions run: `31154653291`;
- requestId: `max-test-rich-post-20260807-1`;
- image: детерминированно сгенерированный PNG 640×360;
- text: `Тест публикации с изображением и форматированной ссылкой.`;
- visible link text: `Открыть «Полюбить Калининград»`;
- href: `https://kenigevents.ru/`.

Перед commit-point Playwright доказал:

- изображение отображалось в composer;
- Lexical composer содержал настоящий `<a>`;
- текст ссылки совпадал;
- canonical href совпадал.

После commit-point старый verifier вернул ложный отрицательный результат `Rich post text is not visible after send`, потому что искал отдельный exact text node, тогда как MAX объединил подпись и ссылку в один контейнер. Сохранённый скриншот и DOM показывали, что пост фактически опубликован: один контейнер содержал изображение, подпись и кликабельную ссылку.

### Строгая проверка и защита от дубля

- GitHub Actions run: `31155001727`;
- result: `status=pass`, `outcome=already_present`;
- requestId: `max-test-rich-post-20260807-idempotency-check`;
- verifier нашёл ровно один message listitem;
- `textMatched=true`;
- `media=true`;
- `links=[true]`, то есть видимый текст и точный href совпали;
- sender завершился до загрузки файла и до кнопки отправки;
- дубликат поста не создан.

После этого основной command runner получил независимый rich-post preflight и post-commit verifier. Он проверяет не отдельный текстовый узел, а структуру одного контейнера сообщения.

## 3. Артефакты

Для live-отладки использовались обрезанные скриншоты правой панели, DOM-сводки и JSON receipts. После анализа все GitHub Actions artifacts были удалены. Финальная проверка repository artifacts API: `total_count=0`.

Локальные ZIP-файлы, скриншоты, DOM-сводки и временные каталоги также удалены.

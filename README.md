# Social Communications

Автоматизированные проверки и сценарии работы с публичными веб-интерфейсами социальных платформ.

## MAX Web canary

Workflow `.github/workflows/max-web-canary-v2.yml` использует Playwright, открывает официальную веб-версию MAX, находит чат «Избранное», идемпотентно отправляет тестовое сообщение и сохраняет диагностические артефакты GitHub Actions на один день.

Секрет, необработанные значения browser storage и токены в репозиторий и логи не записываются.

## Контракт сохранённой сессии

Repository secret `max_session` должен содержать воспроизводимое состояние авторизованного браузера:

- cookies, включая HttpOnly при захвате Playwright;
- localStorage;
- IndexedDB;
- sessionStorage;
- origin `https://web.max.ru`.

Предпочтительный формат — `max-session-v2`, сжатый в строку с префиксом `MAX_SESSION_V2_GZIP_BASE64=`. Также поддерживается полный Playwright `storageState` JSON.

Старый снимок вида `{"cookies": [], "local_storage": ..., "session_storage": ...}` без cookies и IndexedDB не считается авторизованной сессией: он сохраняет настройки интерфейса, но не даёт воспроизводимого входа. Canary отклоняет такой снимок до запуска Chromium.

## Экспорт из уже авторизованной вкладки MAX

1. Открыть авторизованную вкладку `https://web.max.ru/` в Chrome или Edge.
2. Открыть DevTools → Sources → Snippets.
3. Создать snippet, вставить содержимое `scripts/max-session-export-console.js` и запустить.
4. Скрипт скачает `max_session-*.txt` и резервный JSON. Полное содержимое `.txt` сохранить в repository secret `max_session`.

Экспорт включает IndexedDB, сжимает результат и сообщает, помещается ли он в лимит GitHub repository secret. Значения storage в консоль не печатаются.

## Строго проверенный локальный захват Playwright

Это эталонный путь для новой сессии или когда браузерный экспорт не восстанавливает вход:

```bash
npm install
npx playwright install chromium
npm run max:session:capture
```

Команда открывает отдельный постоянный профиль Chromium в `.private/max-playwright-profile`, ждёт авторизации, захватывает cookies, localStorage и IndexedDB через Playwright, затем загружает снимок в новый изолированный browser context. Файл секрета создаётся только после успешной проверки, что новый контекст открывает MAX без экрана входа.

Результат:

```text
.private/max-session/max_session.txt
.private/max-session/max_session.json
.private/max-session/receipt.json
```

Каталог `.private/` исключён из Git.

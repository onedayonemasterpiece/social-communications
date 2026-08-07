# Social Communications

Автоматизированные сценарии работы с публичными веб-интерфейсами социальных платформ.

## MAX Web

Репозиторий содержит детерминированный Playwright-контур для официальной веб-версии MAX:

- выбор разных чатов по единственному точному названию;
- немедленная отправка текста;
- нативная отложенная отправка;
- изображение с подписью и форматированными HTTPS-ссылками;
- независимая проверка результата и защита от дублей;
- короткоживущие диагностические артефакты с последующим удалением.

Основная документация: [`docs/max-messenger-automation.md`](docs/max-messenger-automation.md).

Командный контракт: [`contracts/max-command.schema.json`](contracts/max-command.schema.json).

Основной workflow: [`.github/workflows/max-send.yml`](.github/workflows/max-send.yml).

## Сохранённая сессия

Workflow читает только repository secret `MAX_SESSION`.

Предпочтительное значение:

```text
MAX_SESSION_V2_GZIP_BASE64=...
```

Префикс является частью значения `MAX_SESSION`, а не отдельным именем GitHub Secret. Сессия должна восстанавливать авторизованный `https://web.max.ru/` в новом изолированном browser context.

Экспорт из уже авторизованной вкладки:

1. открыть `https://web.max.ru/`;
2. открыть DevTools → Sources → Snippets;
3. выполнить `scripts/max-session-export-console.js`;
4. сохранить полное содержимое скачанного `max_session-*.txt` в repository secret `MAX_SESSION`.

Эталонный локальный захват Playwright:

```bash
npm install
npx playwright install chromium
npm run max:session:capture
```

Файлы сессии создаются только в `.private/`, который исключён из Git.

import fs from 'node:fs/promises';
import path from 'node:path';

export function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export async function firstVisible(locator, limit = 100) {
  const count = Math.min(await locator.count(), limit);
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return null;
}

async function buttonTitleLines(button) {
  return button.evaluate((element) => {
    const raw = element.innerText || element.textContent || '';
    return raw.split(/\n+/).map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }).catch(() => []);
}

export async function openChatByExactTitle(page, title) {
  const normalizedTitle = normalizeText(title);
  if (!normalizedTitle) throw new Error('Chat title is empty.');

  const search = await firstVisible(page.locator([
    'input[placeholder="Найти"]',
    'input[placeholder*="Поиск" i]',
    'input[aria-label*="Поиск" i]',
    '[role="searchbox"]',
    'input[type="search"]',
  ].join(',')));
  if (!search) throw new Error('MAX chat search input was not found.');

  await search.fill(normalizedTitle);
  await page.waitForTimeout(1_800);

  const candidateButtons = page.locator('aside button, [role="presentation"] > button');
  const count = Math.min(await candidateButtons.count(), 500);
  const matches = [];
  for (let index = 0; index < count; index += 1) {
    const button = candidateButtons.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    const lines = await buttonTitleLines(button);
    if (lines[0] !== normalizedTitle) continue;
    const box = await button.boundingBox().catch(() => null);
    if (!box) continue;
    matches.push({ button, index, lines, box });
  }

  if (matches.length !== 1) {
    throw new Error(`Expected exactly one visible chat named «${normalizedTitle}», found ${matches.length}.`);
  }

  await matches[0].button.click({ timeout: 10_000 });
  await page.waitForTimeout(1_800);

  const expectedAria = `Открыть профиль ${normalizedTitle}`;
  const headerByAria = page.locator(`button[aria-label="${expectedAria.replace(/"/g, '\\"')}"]`);
  const headerByText = page.getByText(normalizedTitle, { exact: true });
  const verified = await firstVisible(headerByAria, 10) || await firstVisible(headerByText, 50);
  if (!verified) throw new Error(`Chat «${normalizedTitle}» was clicked, but the open-chat header could not be verified.`);

  return {
    title: normalizedTitle,
    candidateIndex: matches[0].index,
    candidateBox: matches[0].box,
    url: page.url(),
  };
}

export async function findComposer(page) {
  const composer = await firstVisible(page.locator([
    '[data-testid="composer"] [role="textbox"]',
    '[data-testid="composer"] textarea',
    '[data-testid="composer"] [contenteditable="true"]',
    '[role="textbox"][placeholder="Сообщение"]',
    '[contenteditable="true"][data-placeholder="Сообщение"]',
  ].join(',')));
  if (!composer) throw new Error('Visible MAX message composer was not found.');
  return composer;
}

export async function findSendButton(page) {
  const send = await firstVisible(page.locator([
    'button[aria-label="Отправить сообщение"]',
    'button[aria-label*="Отправить" i]',
    'button[title*="Отправить" i]',
  ].join(',')));
  if (!send) throw new Error('Visible MAX send button was not found.');
  return send;
}

export async function findAttachmentButton(page) {
  const button = await firstVisible(page.locator([
    'button[aria-label="Загрузить файл"]',
    'button[aria-label*="файл" i]',
    'button[title*="файл" i]',
  ].join(',')));
  if (!button) throw new Error('Visible MAX attachment button was not found.');
  return button;
}

export async function clearComposer(composer) {
  await composer.click();
  await composer.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
  await composer.press('Backspace').catch(() => {});
  await composer.evaluate((element) => {
    if ('value' in element) {
      element.value = '';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      element.textContent = '';
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    }
  }).catch(() => {});
}

export async function typePlainText(composer, text) {
  await composer.click();
  const tag = await composer.evaluate((element) => element.tagName.toLowerCase());
  if (tag === 'input' || tag === 'textarea') await composer.fill(text);
  else await composer.pressSequentially(text, { delay: 10 });
}

function redact(value) {
  return normalizeText(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(?:\+?\d[\d\s()\-]{7,}\d)/g, '[phone-or-id]')
    .slice(0, 240);
}

export async function captureEvidence(page, artifactDir, stem) {
  await fs.mkdir(artifactDir, { recursive: true });
  const viewport = page.viewportSize() || { width: 1440, height: 1000 };
  const splitX = Math.min(470, viewport.width - 1);
  await page.screenshot({
    path: path.join(artifactDir, `${stem}.png`),
    clip: { x: splitX, y: 0, width: viewport.width - splitX, height: viewport.height },
    animations: 'disabled',
  });

  const summary = await page.evaluate(() => {
    const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && box.width > 0 && box.height > 0;
    };
    const roots = [document.querySelector('main'), ...document.querySelectorAll('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]')].filter(Boolean);
    const rows = [];
    const seen = new Set();
    for (const root of roots) {
      for (const element of root.querySelectorAll('button, input, textarea, [role], [contenteditable="true"], [aria-label], [title], a')) {
        if (seen.has(element) || !visible(element)) continue;
        seen.add(element);
        const box = element.getBoundingClientRect();
        rows.push({
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || '',
          aria: element.getAttribute('aria-label') || '',
          title: element.getAttribute('title') || '',
          placeholder: element.getAttribute('placeholder') || '',
          text: clean(element.innerText || element.textContent || ''),
          href: element.getAttribute('href') || '',
          box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
        });
        if (rows.length >= 1200) break;
      }
    }
    return { url: location.href, title: document.title, rows };
  });

  const lines = [`URL: ${summary.url}`, `TITLE: ${summary.title}`, `ROWS: ${summary.rows.length}`, ''];
  for (const row of summary.rows) {
    const metadata = [
      row.role && `role=${row.role}`,
      row.aria && `aria=${redact(row.aria)}`,
      row.title && `title=${redact(row.title)}`,
      row.placeholder && `placeholder=${redact(row.placeholder)}`,
      row.text && `text=${redact(row.text)}`,
      row.href && `href=${row.href}`,
    ].filter(Boolean).join(' | ');
    lines.push(`${JSON.stringify(row.box)} <${row.tag}> ${metadata}`);
  }
  await fs.writeFile(path.join(artifactDir, `${stem}.txt`), `${lines.join('\n')}\n`);
  return summary;
}

export async function visibleOverlayText(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && box.width > 0 && box.height > 0;
    };
    const selectors = '[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper], [class*="popover" i], [class*="menu" i]';
    return Array.from(document.querySelectorAll(selectors))
      .filter(visible)
      .map((element) => clean(element.innerText || element.textContent || ''))
      .filter(Boolean)
      .slice(0, 50);
  });
}

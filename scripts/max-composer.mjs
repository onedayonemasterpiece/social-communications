import fs from 'node:fs/promises';
import path from 'node:path';
import {
  clearComposer,
  findAttachmentButton,
  findComposer,
  findSendButton,
  normalizeText,
} from './max-ui.mjs';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function canonicalUrl(value) {
  return new URL(value).href;
}

export async function composerText(composer) {
  return composer.evaluate((element) => (
    'value' in element ? String(element.value || '') : String(element.innerText || element.textContent || '')
  )).catch(() => '');
}

async function setClipboard(page, plainText, html = null) {
  await page.evaluate(async ({ plainValue, htmlValue }) => {
    if (htmlValue && typeof ClipboardItem === 'function') {
      const item = new ClipboardItem({
        'text/html': new Blob([htmlValue], { type: 'text/html' }),
        'text/plain': new Blob([plainValue], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      return;
    }
    await navigator.clipboard.writeText(plainValue);
  }, { plainValue: plainText, htmlValue: html });
}

export async function pastePlainText(page, composer, text) {
  const expected = String(text);
  await setClipboard(page, expected);
  await composer.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  await page.waitForTimeout(600);
  const actual = normalizeText(await composerText(composer));
  if (actual !== normalizeText(expected)) {
    throw new Error(`MAX composer plain-text paste mismatch: expected ${normalizeText(expected).length} characters, received ${actual.length}.`);
  }
  return { plainText: expected, atomicPaste: true };
}

async function composerAnchorMatches(composer, link) {
  return composer.evaluate((element, expected) => {
    const expectedUrl = new URL(expected.url, location.href).href;
    return Array.from(element.querySelectorAll('a')).some((anchor) => {
      const text = String(anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim();
      let href = '';
      try { href = new URL(anchor.getAttribute('href') || anchor.href, location.href).href; } catch {}
      return text === expected.text && href === expectedUrl;
    });
  }, { text: normalizeText(link.text), url: link.url });
}

export async function pasteRichCaption(page, composer, content) {
  const htmlParts = [escapeHtml(content.text).replace(/\n/g, '<br>')];
  const plainParts = [content.text];
  for (const link of content.links) {
    htmlParts.push(`<a href="${escapeHtml(canonicalUrl(link.url))}">${escapeHtml(link.text)}</a>`);
    plainParts.push(link.text);
  }
  const html = `<p>${htmlParts.join('<br>')}</p>`;
  const plainText = plainParts.join('\n');
  await setClipboard(page, plainText, html);
  await composer.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  await page.waitForTimeout(900);

  for (const link of content.links) {
    if (!(await composerAnchorMatches(composer, link))) {
      const composerHtml = await composer.evaluate((element) => element.innerHTML);
      throw new Error(`MAX composer did not preserve formatted link «${link.text}». Composer HTML: ${composerHtml.slice(0, 1_200)}`);
    }
  }
  return {
    composerHtml: await composer.evaluate((element) => element.innerHTML),
    plainText,
    atomicPaste: true,
  };
}

async function visibleLowerPaneMediaCount(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) > 0
        && box.width > 30
        && box.height > 30
        && box.x > 470
        && box.y > innerHeight * 0.55;
    };
    return Array.from(document.querySelectorAll('img, video, canvas, [aria-label*="Прикреп" i]')).filter(visible).length;
  });
}

export async function prevalidateContent(content) {
  if (content.type === 'text') return { type: 'text', textLength: content.text.length };
  const absolutePath = path.resolve(content.image.path);
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) throw new Error(`Image path is not a file: ${absolutePath}`);
  if (stat.size > 20 * 1024 * 1024) throw new Error(`Image exceeds 20 MiB: ${stat.size}`);
  return {
    type: 'rich_post',
    textLength: content.text.length,
    image: { absolutePath, bytes: stat.size },
    links: content.links.map((link) => ({ text: link.text, url: canonicalUrl(link.url) })),
  };
}

export async function uploadPhoto(page, imagePath) {
  const absolutePath = path.resolve(imagePath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) throw new Error(`Image path is not a file: ${absolutePath}`);
  if (stat.size > 20 * 1024 * 1024) throw new Error(`Image exceeds 20 MiB: ${stat.size}`);

  const baseline = await visibleLowerPaneMediaCount(page);
  const attachment = await findAttachmentButton(page);
  await attachment.click();
  const photoOption = page.getByText('Фото или видео', { exact: true });
  await photoOption.waitFor({ state: 'visible' });
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 5_000 });
  await photoOption.click();
  const chooser = await chooserPromise;
  await chooser.setFiles(absolutePath);

  let after = baseline;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(250);
    after = await visibleLowerPaneMediaCount(page);
    if (after > baseline) break;
  }
  if (after <= baseline) {
    const fileNameVisible = await page.getByText(path.basename(absolutePath), { exact: false }).count();
    if (!fileNameVisible) throw new Error('MAX did not expose an image preview after file selection.');
  }

  const send = await findSendButton(page);
  if (!(await send.isEnabled().catch(() => true))) throw new Error('MAX send button remained disabled after image upload.');
  return { absolutePath, bytes: stat.size, previewBaseline: baseline, previewAfter: after };
}

export async function prepareContentInComposer(page, content) {
  const composer = await findComposer(page);
  if (content.type === 'text') {
    const pasted = await pastePlainText(page, composer, content.text);
    return { composer, text: pasted };
  }
  const image = await uploadPhoto(page, content.image.path);
  const caption = await pasteRichCaption(page, composer, content);
  return {
    composer,
    image: { bytes: image.bytes, previewBaseline: image.previewBaseline, previewAfter: image.previewAfter },
    caption: { composerHtml: caption.composerHtml.slice(0, 2_000), atomicPaste: true },
  };
}

export async function discardComposerDraft(page, composer = null) {
  const activeComposer = composer || await findComposer(page).catch(() => null);
  if (activeComposer) await clearComposer(activeComposer).catch(() => {});
  const removeCandidates = page.locator([
    'button[aria-label*="Удалить" i]',
    'button[title*="Удалить" i]',
    'button[aria-label*="Убрать" i]',
    'button[title*="Убрать" i]',
  ].join(','));
  const count = Math.min(await removeCandidates.count(), 30);
  for (let index = 0; index < count; index += 1) {
    const button = removeCandidates.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    const box = await button.boundingBox().catch(() => null);
    if (!box || box.x < 470 || box.y < 550) continue;
    await button.click().catch(() => {});
  }
}

export async function contentMatchesContainer(container, content) {
  return container.evaluate((element, expected) => {
    const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const bodyText = clean(element.innerText || element.textContent || '');
    const textMatched = bodyText.includes(expected.text);
    const media = Boolean(element.querySelector('img, video, canvas, [aria-label*="Прикреп" i]'));
    const links = expected.links.map((link) => {
      const expectedHref = new URL(link.url, location.href).href;
      return Array.from(element.querySelectorAll('a')).some((anchor) => {
        const anchorText = clean(anchor.innerText || anchor.textContent || '');
        let href = '';
        try { href = new URL(anchor.getAttribute('href') || anchor.href, location.href).href; } catch {}
        return anchorText === link.text && href === expectedHref;
      });
    });
    return {
      bodyText: bodyText.slice(0, 1_000),
      textMatched,
      media,
      links,
      matched: textMatched && (expected.type === 'text' || (media && links.every(Boolean))),
    };
  }, {
    type: content.type,
    text: normalizeText(content.text),
    links: (content.links || []).map((link) => ({ text: normalizeText(link.text), url: link.url })),
  });
}

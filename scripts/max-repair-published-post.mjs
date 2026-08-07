import fs from 'node:fs/promises';
import path from 'node:path';

import { loadMaxCommand } from './max-command-contract.mjs';
import { pasteRichCaption } from './max-composer.mjs';
import { resolveDestination } from './max-destination.mjs';
import { launchAuthenticatedMax } from './max-runtime.mjs';
import {
  captureEvidence,
  clearComposer,
  firstVisible,
  normalizeText,
} from './max-ui.mjs';

const ARTIFACT_DIR = path.resolve(process.env.MAX_ARTIFACT_DIR || 'artifacts/max-repair');
const ATTEMPTS = 6;
const RETRY_DELAY_MS = 1_500;

function canonicalUrl(value) {
  try { return new URL(value).href; } catch { return ''; }
}

function stableFragments(text) {
  const sentences = normalizeText(text).match(/[^.!?]+[.!?]+|[^.!?]+$/gu)
    ?.map((value) => normalizeText(value))
    .filter((value) => value.length >= 20) || [];
  if (!sentences.length) return [];
  const last = sentences.length - 1;
  return [...new Set([0, Math.floor(last / 3), Math.floor((last * 2) / 3), last])]
    .sort((left, right) => left - right)
    .map((index) => sentences[index])
    .filter(Boolean);
}

function expectedParagraphCount(content) {
  const textBlocks = String(content.text).replace(/\r\n?/g, '\n').split(/\n{2,}/).filter(Boolean).length;
  return textBlocks + (content.links || []).length;
}

async function writeJson(name, value) {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  await fs.writeFile(path.join(ARTIFACT_DIR, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeElementEvidence(name, locator) {
  const payload = await locator.evaluate((root) => {
    const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const boxOf = (element) => {
      const box = element.getBoundingClientRect();
      return [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)];
    };
    const rows = [];
    const queue = [{ node: root, depth: 0 }];
    while (queue.length && rows.length < 700) {
      const { node, depth } = queue.shift();
      if (!(node instanceof Element)) continue;
      rows.push({
        depth,
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute('role') || '',
        aria: node.getAttribute('aria-label') || '',
        title: node.getAttribute('title') || '',
        contenteditable: node.getAttribute('contenteditable') || '',
        text: clean(node.innerText || node.textContent || '').slice(0, 500),
        box: boxOf(node),
        className: String(node.className || '').slice(0, 240),
      });
      if (depth >= 14) continue;
      for (const child of node.children) queue.push({ node: child, depth: depth + 1 });
    }
    return {
      innerText: String(root.innerText || root.textContent || '').slice(0, 8_000),
      outerHTML: String(root.outerHTML || '').slice(0, 250_000),
      box: boxOf(root),
      rows,
    };
  });
  await writeJson(name, payload);
  return payload;
}

async function writeOverlayEvidence(page, name) {
  const payload = await page.evaluate(() => {
    const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) > 0
        && box.width > 0
        && box.height > 0;
    };
    return Array.from(document.querySelectorAll(
      '[role="dialog"], [role="menu"], [role="menuitem"], [data-radix-popper-content-wrapper], [class*="popover" i], [class*="menu" i]',
    )).filter(visible).map((element) => {
      const box = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || '',
        aria: element.getAttribute('aria-label') || '',
        text: clean(element.innerText || element.textContent || '').slice(0, 2_000),
        outerHTML: String(element.outerHTML || '').slice(0, 80_000),
        box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
        className: String(element.className || '').slice(0, 240),
      };
    }).slice(0, 120);
  });
  await writeJson(name, payload);
  return payload;
}

async function matchingMessageCandidates(page, content) {
  const fragments = stableFragments(content.text);
  const links = (content.links || []).map((link) => ({
    text: normalizeText(link.text),
    href: canonicalUrl(link.url),
  }));
  const locator = page.locator('[role="listitem"], [role="presentation"]');
  const count = Math.min(await locator.count(), 1_000);
  const candidates = [];

  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    const details = await item.evaluate((element, expected) => {
      const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
      const canonical = (value) => {
        try { return new URL(value, location.href).href; } catch { return ''; }
      };
      const bodyText = clean(element.innerText || element.textContent || '');
      const anchors = Array.from(element.querySelectorAll('a')).map((anchor) => ({
        text: clean(anchor.innerText || anchor.textContent || ''),
        href: canonical(anchor.getAttribute('href') || anchor.href || ''),
      }));
      const fragmentMatches = expected.fragments.filter((fragment) => bodyText.includes(fragment)).length;
      const linksMatched = expected.links.every((link) => anchors.some((anchor) => (
        anchor.text === link.text && anchor.href === link.href
      )));
      const media = Boolean(element.querySelector(
        'img, video, canvas, [aria-label="Прикрепленные фото"], [aria-label*="Прикреплен" i]',
      ));
      const box = element.getBoundingClientRect();
      let depth = 0;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) depth += 1;
      return {
        bodyText,
        fragmentMatches,
        fragmentTotal: expected.fragments.length,
        linksMatched,
        media,
        depth,
        box: [box.x, box.y, box.width, box.height],
      };
    }, { fragments, links }).catch(() => null);

    if (!details) continue;
    if (details.fragmentMatches !== details.fragmentTotal || !details.linksMatched || !details.media) continue;
    candidates.push({ index, item, ...details });
  }
  return candidates;
}

async function findExactMessage(page, content) {
  let candidates = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    await page.waitForTimeout(attempt === 1 ? 1_500 : RETRY_DELAY_MS);
    candidates = await matchingMessageCandidates(page, content);
    if (candidates.length) break;
    await page.keyboard.press('End').catch(() => {});
  }
  if (!candidates.length) throw new Error('The exact published MAX rich post was not found.');
  const selected = [...candidates].sort((left, right) => (
    right.depth - left.depth
    || (left.box[2] * left.box[3]) - (right.box[2] * right.box[3])
  ))[0];
  return { selected, candidates };
}

async function visibleEditControl(page) {
  return await firstVisible(page.getByRole('menuitem', { name: 'Редактировать', exact: true }), 50)
    || await firstVisible(page.getByText('Редактировать', { exact: true }), 100)
    || await firstVisible(page.getByRole('menuitem', { name: 'Изменить', exact: true }), 50)
    || await firstVisible(page.getByText('Изменить', { exact: true }), 100);
}

async function findEditField(page, content) {
  const firstFragment = normalizeText(content.text).slice(0, 120);
  const locator = page.locator('textarea, [contenteditable="true"], [role="textbox"]');
  const count = Math.min(await locator.count(), 300);
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const field = locator.nth(index);
    if (!(await field.isVisible().catch(() => false))) continue;
    const details = await field.evaluate((element, expected) => {
      const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
      const box = element.getBoundingClientRect();
      const value = 'value' in element ? String(element.value || '') : String(element.innerText || element.textContent || '');
      const surrounding = clean(element.parentElement?.innerText || element.parentElement?.textContent || '');
      return {
        value,
        normalized: clean(value),
        surrounding,
        containsExpected: clean(value).includes(expected),
        surroundingContainsExpected: surrounding.includes(expected),
        box: [box.x, box.y, box.width, box.height],
        tag: element.tagName.toLowerCase(),
        contenteditable: element.getAttribute('contenteditable') || '',
        className: String(element.className || '').slice(0, 240),
      };
    }, firstFragment).catch(() => null);
    if (!details || details.box[0] < 470 || details.box[2] < 100 || details.box[3] < 30) continue;
    if (!details.containsExpected && !details.surroundingContainsExpected) continue;
    candidates.push({ index, field, ...details });
  }
  if (!candidates.length) return null;
  return candidates.sort((left, right) => (
    Number(right.containsExpected) - Number(left.containsExpected)
    || right.normalized.length - left.normalized.length
    || (right.box[2] * right.box[3]) - (left.box[2] * left.box[3])
  ))[0];
}

async function findSaveControl(page) {
  return await firstVisible(page.getByRole('button', { name: 'Сохранить', exact: true }), 100)
    || await firstVisible(page.getByText('Сохранить', { exact: true }), 100)
    || await firstVisible(page.locator('button[aria-label*="Сохран" i], button[title*="Сохран" i]'), 100);
}

async function editorStructure(editor, content) {
  return editor.evaluate((element, expected) => {
    const rawText = 'value' in element
      ? String(element.value || '')
      : String(element.innerText || element.textContent || '');
    const lineBreakRuns = Array.from(rawText.matchAll(/\n+/g)).map((match) => match[0].length);
    const anchors = Array.from(element.querySelectorAll('a')).map((anchor) => ({
      text: String(anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim(),
      href: anchor.href || anchor.getAttribute('href') || '',
    }));
    return {
      rawText,
      lineBreakRuns,
      doubleBreakCount: lineBreakRuns.filter((length) => length >= 2).length,
      topLevelBlocks: Array.from(element.children).filter((child) => /^(P|DIV)$/.test(child.tagName)).length,
      paragraphs: element.querySelectorAll('p').length,
      breaks: element.querySelectorAll('br').length,
      anchors,
      innerHTML: String(element.innerHTML || '').slice(0, 80_000),
      expectedParagraphs: expected,
    };
  }, expectedParagraphCount(content));
}

async function renderedStructure(item, content) {
  return item.evaluate((element, expected) => {
    const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const canonical = (value) => {
      try { return new URL(value, location.href).href; } catch { return ''; }
    };
    const textCandidates = Array.from(element.querySelectorAll('span.text, [class*="text" i]'))
      .map((node) => ({ node, raw: String(node.innerText || node.textContent || '') }))
      .filter((entry) => clean(entry.raw).includes(expected.firstFragment));
    const chosen = textCandidates.sort((left, right) => left.raw.length - right.raw.length)[0];
    const rawText = chosen?.raw || String(element.innerText || element.textContent || '');
    const lineBreakRuns = Array.from(rawText.matchAll(/\n+/g)).map((match) => match[0].length);
    const anchors = Array.from(element.querySelectorAll('a')).map((anchor) => ({
      text: clean(anchor.innerText || anchor.textContent || ''),
      href: canonical(anchor.getAttribute('href') || anchor.href || ''),
    }));
    return {
      rawText,
      normalized: clean(rawText),
      lineBreakRuns,
      doubleBreakCount: lineBreakRuns.filter((length) => length >= 2).length,
      paragraphs: chosen?.node.querySelectorAll('p').length || 0,
      breaks: chosen?.node.querySelectorAll('br').length || 0,
      blockChildren: chosen ? Array.from(chosen.node.children).filter((child) => /^(P|DIV)$/.test(child.tagName)).length : 0,
      anchors,
      linksMatched: expected.links.every((link) => anchors.some((anchor) => (
        anchor.text === link.text && anchor.href === link.href
      ))),
      media: Boolean(element.querySelector('img, video, canvas, [aria-label*="Прикреп" i]')),
      html: String((chosen?.node || element).outerHTML || '').slice(0, 120_000),
    };
  }, {
    firstFragment: normalizeText(content.text).slice(0, 120),
    links: (content.links || []).map((link) => ({ text: normalizeText(link.text), href: canonicalUrl(link.url) })),
  });
}

const command = await loadMaxCommand();
if (command.content.type !== 'rich_post') throw new Error('MAX repair requires rich_post content.');
if (stableFragments(command.content.text).length < 3) throw new Error('MAX repair requires at least three stable text fragments.');

await fs.mkdir(ARTIFACT_DIR, { recursive: true });
let runtime;
let commitPointPassed = false;

try {
  runtime = await launchAuthenticatedMax({
    timezoneId: command.delivery.timeZone,
    viewport: { width: 1440, height: 1800 },
  });
  const destination = await resolveDestination(runtime.page, {
    key: command.destination.key,
    exactTitle: command.destination.exactTitle,
    query: command.destination.query,
    kind: command.destination.kind,
  });
  await captureEvidence(runtime.page, ARTIFACT_DIR, '01-channel-open');

  const beforeMatch = await findExactMessage(runtime.page, command.content);
  const item = beforeMatch.selected.item;
  await item.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await runtime.page.waitForTimeout(900);
  const message = item.locator('div.message[aria-haspopup="dialog"]').first();
  if (!(await message.isVisible().catch(() => false))) {
    throw new Error('The exact MAX message bubble was not visible after scrolling.');
  }
  await writeElementEvidence('01-message-before', item);
  await captureEvidence(runtime.page, ARTIFACT_DIR, '02-message-before');

  const messageBox = await message.boundingBox();
  if (!messageBox) throw new Error('The exact MAX message bubble had no bounding box.');
  await message.click({
    button: 'right',
    position: {
      x: Math.min(messageBox.width - 12, Math.max(12, messageBox.width * 0.65)),
      y: Math.min(messageBox.height - 12, Math.max(12, messageBox.height * 0.35)),
    },
  });
  await runtime.page.waitForTimeout(900);
  await captureEvidence(runtime.page, ARTIFACT_DIR, '03-context-menu');
  await writeOverlayEvidence(runtime.page, '03-context-menu-dom');

  const edit = await visibleEditControl(runtime.page);
  if (!edit) throw new Error('MAX context menu did not expose «Редактировать».');
  await edit.click();
  await runtime.page.waitForTimeout(1_000);
  await captureEvidence(runtime.page, ARTIFACT_DIR, '04-edit-mode');
  await writeOverlayEvidence(runtime.page, '04-edit-mode-dom');

  const editCandidate = await findEditField(runtime.page, command.content);
  if (!editCandidate) throw new Error('MAX edit field containing the published post was not found.');
  const editor = editCandidate.field;
  await writeElementEvidence('04-editor-before', editor);

  await clearComposer(editor);
  const pasted = await pasteRichCaption(runtime.page, editor, command.content);
  await runtime.page.waitForTimeout(700);
  const preparedStructure = await editorStructure(editor, command.content);
  await writeJson('05-editor-prepared-structure', preparedStructure);
  await writeElementEvidence('05-editor-prepared-dom', editor);
  await captureEvidence(runtime.page, ARTIFACT_DIR, '05-editor-prepared');

  const expectedBlocks = expectedParagraphCount(command.content);
  const editorHasParagraphs = preparedStructure.doubleBreakCount >= expectedBlocks - 1
    || preparedStructure.topLevelBlocks >= expectedBlocks
    || preparedStructure.paragraphs >= expectedBlocks;
  if (!editorHasParagraphs) {
    throw new Error(`MAX edit field collapsed paragraph structure before save: ${JSON.stringify({
      expectedBlocks,
      doubleBreakCount: preparedStructure.doubleBreakCount,
      topLevelBlocks: preparedStructure.topLevelBlocks,
      paragraphs: preparedStructure.paragraphs,
      breaks: preparedStructure.breaks,
    })}`);
  }
  for (const link of command.content.links) {
    const expectedHref = canonicalUrl(link.url);
    if (!preparedStructure.anchors.some((anchor) => (
      normalizeText(anchor.text) === normalizeText(link.text) && canonicalUrl(anchor.href) === expectedHref
    ))) {
      throw new Error(`MAX edit field lost formatted link «${link.text}» before save.`);
    }
  }

  const save = await findSaveControl(runtime.page);
  if (!save) throw new Error('MAX edit mode did not expose «Сохранить».');
  await save.click();
  commitPointPassed = true;
  await runtime.page.waitForTimeout(2_000);

  const afterMatch = await findExactMessage(runtime.page, command.content);
  const finalItem = afterMatch.selected.item;
  await finalItem.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await runtime.page.waitForTimeout(900);
  const finalStructure = await renderedStructure(finalItem, command.content);
  await writeJson('06-final-structure', finalStructure);
  await writeElementEvidence('06-message-after-dom', finalItem);
  await captureEvidence(runtime.page, ARTIFACT_DIR, '06-message-after');

  const finalHasParagraphs = finalStructure.doubleBreakCount >= expectedBlocks - 1
    || finalStructure.blockChildren >= expectedBlocks
    || finalStructure.paragraphs >= expectedBlocks;
  if (!finalHasParagraphs) {
    throw new Error(`MAX saved post still lacks paragraph separation: ${JSON.stringify({
      expectedBlocks,
      doubleBreakCount: finalStructure.doubleBreakCount,
      blockChildren: finalStructure.blockChildren,
      paragraphs: finalStructure.paragraphs,
      breaks: finalStructure.breaks,
    })}`);
  }
  if (!finalStructure.linksMatched || !finalStructure.media) {
    throw new Error(`MAX saved post lost required rich-post structure: ${JSON.stringify({
      linksMatched: finalStructure.linksMatched,
      media: finalStructure.media,
    })}`);
  }

  await writeJson('result', {
    status: 'success',
    requestId: command.requestId,
    destination: destination.title,
    commitPointPassed,
    expectedParagraphs: expectedBlocks,
    editor: {
      doubleBreakCount: preparedStructure.doubleBreakCount,
      topLevelBlocks: preparedStructure.topLevelBlocks,
      paragraphs: preparedStructure.paragraphs,
      breaks: preparedStructure.breaks,
    },
    final: {
      doubleBreakCount: finalStructure.doubleBreakCount,
      blockChildren: finalStructure.blockChildren,
      paragraphs: finalStructure.paragraphs,
      breaks: finalStructure.breaks,
      linksMatched: finalStructure.linksMatched,
      media: finalStructure.media,
    },
    pastedHtmlLength: pasted.html.length,
  });
  console.log(
    `MAX_FORMAT_REPAIR=success destination=${destination.title} expected_paragraphs=${expectedBlocks} `
    + `editor_double_breaks=${preparedStructure.doubleBreakCount} final_double_breaks=${finalStructure.doubleBreakCount} `
    + `links=${finalStructure.linksMatched} media=${finalStructure.media}`,
  );
} catch (error) {
  if (runtime?.page) {
    await captureEvidence(runtime.page, ARTIFACT_DIR, '99-failure').catch(() => {});
    await writeOverlayEvidence(runtime.page, '99-failure-overlays').catch(() => {});
  }
  await writeJson('result', {
    status: 'failure',
    requestId: command.requestId,
    commitPointPassed,
    error: String(error?.stack || error?.message || error),
  }).catch(() => {});
  if (!commitPointPassed && runtime?.page) {
    await runtime.page.keyboard.press('Escape').catch(() => {});
  }
  throw error;
} finally {
  if (runtime?.context) await runtime.context.close().catch(() => {});
  if (runtime?.browser) await runtime.browser.close().catch(() => {});
}

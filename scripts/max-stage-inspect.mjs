import fs from 'node:fs/promises';
import path from 'node:path';
import { launchAuthenticatedMax } from './max-runtime.mjs';
import { firstVisible, normalizeText } from './max-ui.mjs';

const artifactDir = path.resolve(process.env.MAX_ARTIFACT_DIR || 'artifacts/max-stage-inspect');
const query = normalizeText(process.env.MAX_DESTINATION_QUERY || 'тестовая');
const result = {
  status: 'started',
  startedAt: new Date().toISOString(),
  query,
  candidates: [],
};

let runtime;
try {
  runtime = await launchAuthenticatedMax();
  const search = await firstVisible(runtime.page.locator([
    'input[placeholder="Найти"]',
    'input[placeholder*="Поиск" i]',
    'input[aria-label*="Поиск" i]',
    '[role="searchbox"]',
    'input[type="search"]',
  ].join(',')));
  if (!search) throw new Error('MAX chat search input was not found.');
  await search.fill(query);
  await runtime.page.waitForTimeout(1_800);

  const locator = runtime.page.locator('aside button, [role="presentation"] > button');
  const count = Math.min(await locator.count(), 600);
  for (let index = 0; index < count; index += 1) {
    const button = locator.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    const box = await button.boundingBox().catch(() => null);
    if (!box || box.x > 470) continue;
    const candidate = await button.evaluate((element, candidateIndex) => {
      const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
      const lines = String(element.innerText || element.textContent || '')
        .split(/\n+/)
        .map(clean)
        .filter(Boolean);
      const attributes = {};
      for (const name of element.getAttributeNames()) {
        const value = element.getAttribute(name);
        if (/token|session|auth|cookie/i.test(name)) continue;
        attributes[name] = String(value || '').slice(0, 500);
      }
      const parent = element.parentElement;
      const parentAttributes = {};
      if (parent) {
        for (const name of parent.getAttributeNames()) {
          if (/token|session|auth|cookie/i.test(name)) continue;
          parentAttributes[name] = String(parent.getAttribute(name) || '').slice(0, 500);
        }
      }
      return {
        index: candidateIndex,
        tag: element.tagName.toLowerCase(),
        lines,
        attributes,
        parentTag: parent?.tagName.toLowerCase() || '',
        parentAttributes,
        outerHtml: element.outerHTML.slice(0, 6_000),
      };
    }, index);
    result.candidates.push({ ...candidate, box });
  }

  await runtime.page.screenshot({
    path: path.join(artifactDir, '01-destination-search-full.png'),
    fullPage: false,
    animations: 'disabled',
  });
  result.status = 'pass';
  result.completedAt = new Date().toISOString();
} catch (error) {
  result.status = 'fail';
  result.error = { name: error?.name || 'Error', message: String(error?.message || error) };
  result.completedAt = new Date().toISOString();
  process.exitCode = 1;
} finally {
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  if (runtime?.context) await runtime.context.close().catch(() => {});
  if (runtime?.browser) await runtime.browser.close().catch(() => {});
}

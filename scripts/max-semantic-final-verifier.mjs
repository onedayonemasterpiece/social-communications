import fs from 'node:fs/promises';

import { loadMaxCommand } from './max-command-contract.mjs';
import { resolveDestination } from './max-destination.mjs';
import { launchAuthenticatedMax } from './max-runtime.mjs';
import { normalizeText } from './max-ui.mjs';

const REGISTRY_PATH = 'config/social-destinations.public.json';
const ATTEMPTS = 5;
const RETRY_DELAY_MS = 1_500;

function canonicalUrl(value) {
  try {
    return new URL(value).href;
  } catch {
    return '';
  }
}

async function destinationConfig(command) {
  const payload = JSON.parse(await fs.readFile(REGISTRY_PATH, 'utf8'));
  const key = normalizeText(command.destination?.key);
  const entries = Array.isArray(payload?.destinations) ? payload.destinations : [];
  const matches = entries.filter((entry) => normalizeText(entry?.key) === key);
  if (matches.length !== 1) {
    throw new Error(`MAX semantic verifier expected one registry entry for ${key}, found ${matches.length}.`);
  }
  const config = matches[0]?.platforms?.max;
  if (!config?.title || config.type !== 'channel') {
    throw new Error(`MAX semantic verifier found no exact channel configuration for ${key}.`);
  }
  return {
    key,
    title: normalizeText(config.title),
    kind: 'channel',
  };
}

async function inspectCurrentChat(page, command) {
  const expectedText = normalizeText(command.content.text);
  const expectedLinks = (command.content.links || []).map((link) => ({
    text: normalizeText(link.text),
    href: canonicalUrl(link.url),
  }));

  return page.evaluate(({ expectedText: text, expectedLinks: links }) => {
    const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const canonical = (value) => {
      try {
        return new URL(value, location.href).href;
      } catch {
        return '';
      }
    };
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) > 0
        && box.width > 0
        && box.height > 0
        && box.bottom > 0
        && box.top < innerHeight;
    };

    const candidates = [];
    const elements = Array.from(document.querySelectorAll('[role="listitem"], [role="presentation"]'))
      .filter(visible);

    for (const element of elements) {
      const bodyText = clean(element.innerText || element.textContent || '');
      if (!bodyText.includes(text)) continue;

      const anchors = Array.from(element.querySelectorAll('a')).map((anchor) => ({
        text: clean(anchor.innerText || anchor.textContent || ''),
        href: canonical(anchor.getAttribute('href') || anchor.href || ''),
      }));
      const linksMatched = links.every((expected) => anchors.some((anchor) => (
        anchor.text === expected.text && anchor.href === expected.href
      )));
      if (!linksMatched) continue;

      const media = Boolean(element.querySelector(
        'img, video, canvas, [aria-label="Прикрепленные фото"], [aria-label*="Прикреплен" i]',
      ));
      if (!media) continue;

      const matchedLinks = links.map((expected) => `${expected.text}|${expected.href}`).sort();
      const signature = JSON.stringify({ bodyText, matchedLinks, media: true });
      const box = element.getBoundingClientRect();
      candidates.push({
        signature,
        bodyLength: bodyText.length,
        linkCount: matchedLinks.length,
        media,
        box: [
          Math.round(box.x),
          Math.round(box.y),
          Math.round(box.width),
          Math.round(box.height),
        ],
      });
    }

    const clusters = new Map();
    for (const candidate of candidates) {
      const current = clusters.get(candidate.signature) || {
        bodyLength: candidate.bodyLength,
        linkCount: candidate.linkCount,
        media: candidate.media,
        nestedDomCount: 0,
        boxes: [],
      };
      current.nestedDomCount += 1;
      current.boxes.push(candidate.box);
      clusters.set(candidate.signature, current);
    }

    return {
      inspectedContainers: elements.length,
      rawCandidateCount: candidates.length,
      semanticClusters: [...clusters.values()],
    };
  }, { expectedText, expectedLinks });
}

const command = await loadMaxCommand();
if (!command.verifyOnly) {
  throw new Error('MAX semantic final verifier is read-only and requires verifyOnly=true.');
}
if (command.content.type !== 'rich_post') {
  throw new Error(`MAX semantic final verifier requires rich_post, received ${command.content.type}.`);
}
if (!(command.content.links || []).length) {
  throw new Error('MAX semantic final verifier requires at least one exact HTTPS link.');
}

const destination = await destinationConfig(command);
let runtime;
let lastInspection = null;

try {
  runtime = await launchAuthenticatedMax({ timezoneId: command.delivery.timeZone });
  const resolved = await resolveDestination(runtime.page, {
    exactTitle: destination.title,
    kind: destination.kind,
  });

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    await runtime.page.waitForTimeout(attempt === 1 ? 1_500 : RETRY_DELAY_MS);
    lastInspection = await inspectCurrentChat(runtime.page, command);
    if (lastInspection.semanticClusters.length === 1) {
      const cluster = lastInspection.semanticClusters[0];
      console.log(
        `MAX_SEMANTIC_FINAL_VERIFY=verified destination=${resolved.title} `
        + `clusters=1 nested_dom=${cluster.nestedDomCount} `
        + `body_length=${cluster.bodyLength} links=${cluster.linkCount} media=${cluster.media}`,
      );
      process.exitCode = 0;
      break;
    }
    if (attempt < ATTEMPTS) {
      await runtime.page.keyboard.press('End').catch(() => {});
    }
  }

  if (lastInspection?.semanticClusters.length !== 1) {
    console.log(
      `MAX_SEMANTIC_FINAL_VERIFY=failed destination=${resolved.title} `
      + `inspected=${lastInspection?.inspectedContainers ?? 0} `
      + `raw_candidates=${lastInspection?.rawCandidateCount ?? 0} `
      + `clusters=${lastInspection?.semanticClusters.length ?? 0}`,
    );
    throw new Error('MAX semantic final verifier did not find exactly one rich-post identity.');
  }
} finally {
  if (runtime?.context) await runtime.context.close().catch(() => {});
  if (runtime?.browser) await runtime.browser.close().catch(() => {});
}

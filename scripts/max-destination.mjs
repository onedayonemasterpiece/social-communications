import { firstVisible, normalizeText } from './max-ui.mjs';

function canonical(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  return new Set(canonical(value).split(' ').filter(Boolean));
}

function jaccard(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function bigrams(value) {
  const normalized = ` ${canonical(value)} `;
  const result = [];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.push(normalized.slice(index, index + 2));
  }
  return result;
}

function dice(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.length || !b.length) return 0;
  const counts = new Map();
  for (const item of a) counts.set(item, (counts.get(item) || 0) + 1);
  let matches = 0;
  for (const item of b) {
    const available = counts.get(item) || 0;
    if (available <= 0) continue;
    matches += 1;
    counts.set(item, available - 1);
  }
  return (2 * matches) / (a.length + b.length);
}

function levenshtein(left, right) {
  const a = canonical(left);
  const b = canonical(right);
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array(b.length + 1);
  for (let row = 1; row <= a.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= b.length; column += 1) {
      const substitution = previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1);
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, substitution);
    }
    for (let column = 0; column <= b.length; column += 1) previous[column] = current[column];
  }
  return previous[b.length];
}

function similarity(query, title) {
  const q = canonical(query);
  const t = canonical(title);
  if (!q || !t) return 0;
  if (q === t) return 1;
  const lengthRatio = Math.min(q.length, t.length) / Math.max(q.length, t.length);
  if (t.startsWith(q) || q.startsWith(t)) return 0.94 + 0.04 * lengthRatio;
  if (t.includes(q) || q.includes(t)) return 0.89 + 0.06 * lengthRatio;
  const editRatio = 1 - levenshtein(q, t) / Math.max(q.length, t.length);
  return Math.max(0, Math.min(0.88, 0.46 * jaccard(q, t) + 0.39 * dice(q, t) + 0.15 * editRatio));
}

function maskTitle(value) {
  const text = normalizeText(value);
  if (text.length <= 2) return '*'.repeat(text.length);
  if (text.length <= 6) return `${text[0]}${'*'.repeat(text.length - 2)}${text.at(-1)}`;
  return `${text.slice(0, 2)}${'*'.repeat(Math.min(12, text.length - 4))}${text.slice(-2)}`;
}

function parseRegistry(rawValue = process.env.MAX_DESTINATIONS_JSON) {
  if (!String(rawValue ?? '').trim()) return [];
  const parsed = JSON.parse(rawValue);
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.destinations)
      ? parsed.destinations
      : Object.entries(parsed || {}).map(([key, value]) => ({ key, ...(typeof value === 'string' ? { title: value } : value) }));
  return entries
    .filter((entry) => entry && normalizeText(entry.title))
    .map((entry) => ({
      key: normalizeText(entry.key),
      title: normalizeText(entry.title),
      kind: normalizeText(entry.kind),
      aliases: Array.isArray(entry.aliases) ? entry.aliases.map(normalizeText).filter(Boolean) : [],
    }));
}

function registryMatch(destination) {
  const registry = parseRegistry();
  const key = normalizeText(destination?.key);
  if (key) {
    const matches = registry.filter((entry) => entry.key === key);
    if (matches.length !== 1) {
      throw Object.assign(new Error(`MAX destination registry key «${key}» resolved to ${matches.length} entries.`), {
        name: 'DestinationRegistryError',
        code: 'registry-key-not-unique',
      });
    }
    return { ...matches[0], strategy: 'registry-key' };
  }

  const query = canonical(destination?.query);
  if (!query) return null;
  const matches = registry.filter((entry) => [entry.title, ...entry.aliases].some((value) => canonical(value) === query));
  if (matches.length === 1) return { ...matches[0], strategy: 'registry-alias' };
  if (matches.length > 1) {
    throw Object.assign(new Error(`MAX destination query matched ${matches.length} private registry aliases.`), {
      name: 'DestinationRegistryError',
      code: 'registry-alias-ambiguous',
    });
  }
  return null;
}

async function buttonTitleLines(button) {
  return button.evaluate((element) => {
    const raw = element.innerText || element.textContent || '';
    return raw.split(/\n+/).map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }).catch(() => []);
}

async function visibleCandidates(page) {
  const locator = page.locator('aside button, [role="presentation"] > button');
  const count = Math.min(await locator.count(), 600);
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const button = locator.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    const box = await button.boundingBox().catch(() => null);
    if (!box || box.x > 470) continue;
    const lines = await buttonTitleLines(button);
    const title = normalizeText(lines[0]);
    if (!title) continue;
    candidates.push({ button, index, box, title, lines });
  }
  return candidates;
}

async function verifyOpenChatHeader(page, title) {
  const expectedAria = `Открыть профиль ${title}`;
  const headerByAria = page.locator(`button[aria-label="${expectedAria.replace(/"/g, '\\"')}"]`);
  const headerByText = page.getByText(title, { exact: true });
  return Boolean(await firstVisible(headerByAria, 10) || await firstVisible(headerByText, 100));
}

export async function resolveDestination(page, destination = {}) {
  const registered = registryMatch(destination);
  const exactTitle = normalizeText(registered?.title || destination.exactTitle || destination.title);
  const query = normalizeText(exactTitle || destination.query);
  if (!query) {
    throw Object.assign(new Error('MAX destination requires key, exactTitle, title, or query.'), {
      name: 'DestinationResolutionError',
      code: 'destination-empty',
    });
  }

  const search = await firstVisible(page.locator([
    'input[placeholder="Найти"]',
    'input[placeholder*="Поиск" i]',
    'input[aria-label*="Поиск" i]',
    '[role="searchbox"]',
    'input[type="search"]',
  ].join(',')));
  if (!search) throw new Error('MAX chat search input was not found.');

  await search.fill(query);
  await page.waitForTimeout(1_800);
  const candidates = await visibleCandidates(page);
  const scored = candidates
    .map((candidate) => ({ ...candidate, score: similarity(query, candidate.title) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);

  let chosen = null;
  let strategy = registered?.strategy || null;
  if (exactTitle) {
    const exact = scored.filter((candidate) => canonical(candidate.title) === canonical(exactTitle));
    if (exact.length === 1) {
      chosen = exact[0];
      strategy ||= 'exact-title';
    } else {
      throw Object.assign(new Error(`Expected one visible MAX destination named «${exactTitle}», found ${exact.length}.`), {
        name: 'DestinationResolutionError',
        code: exact.length ? 'exact-title-ambiguous' : 'exact-title-not-found',
        candidates: scored.slice(0, 8).map((item) => ({ title: item.title, score: item.score })),
      });
    }
  } else {
    const top = scored[0];
    const second = scored[1];
    const threshold = canonical(query).length < 4 ? 0.97 : 0.86;
    const margin = top ? top.score - (second?.score || 0) : 0;
    const uniqueStrong = Boolean(top && top.score >= threshold && (scored.length === 1 || margin >= 0.12));
    if (uniqueStrong) {
      chosen = top;
      strategy = 'deterministic-fuzzy';
    } else {
      throw Object.assign(new Error(`MAX destination query «${query}» is not unambiguous enough for an automatic send.`), {
        name: 'DestinationResolutionError',
        code: scored.length ? 'fuzzy-ambiguous' : 'fuzzy-not-found',
        candidates: scored.slice(0, 8).map((item) => ({ title: item.title, score: item.score })),
      });
    }
  }

  await chosen.button.click({ timeout: 10_000 });
  await page.waitForTimeout(1_800);
  if (!(await verifyOpenChatHeader(page, chosen.title))) {
    throw Object.assign(new Error(`MAX destination «${chosen.title}» was clicked, but the open-chat header could not be verified.`), {
      name: 'DestinationResolutionError',
      code: 'opened-header-mismatch',
    });
  }

  return {
    query,
    title: chosen.title,
    kind: registered?.kind || normalizeText(destination.kind) || null,
    strategy,
    score: Number(chosen.score.toFixed(4)),
    candidateCount: scored.length,
    candidateIndex: chosen.index,
    candidateBox: chosen.box,
    url: page.url(),
    alternatives: scored.slice(0, 5).map((item) => ({
      titleHint: maskTitle(item.title),
      score: Number(item.score.toFixed(4)),
    })),
  };
}

export function destinationForLegacyChat(chat = {}) {
  return {
    exactTitle: normalizeText(chat.title),
    kind: normalizeText(chat.kind),
  };
}

export const destinationMatching = {
  canonical,
  similarity,
};

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
  for (let index = 0; index < normalized.length - 1; index += 1) result.push(normalized.slice(index, index + 2));
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

  if (t.startsWith(q)) return 0.92 + 0.07 * lengthRatio;
  if (q.startsWith(t)) return 0.68 + 0.18 * lengthRatio;
  if (t.includes(q)) return 0.86 + 0.10 * lengthRatio;
  if (q.includes(t)) return 0.66 + 0.18 * lengthRatio;

  const editRatio = 1 - levenshtein(q, t) / Math.max(q.length, t.length);
  return Math.max(0, Math.min(0.91,
    0.58 * dice(q, t) + 0.32 * editRatio + 0.10 * jaccard(q, t)));
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

function searchVariants(query) {
  const original = normalizeText(query);
  const parts = canonical(query).split(' ').filter(Boolean);
  const variants = [original];
  const add = (value) => {
    const normalized = normalizeText(value);
    if (normalized && !variants.some((item) => canonical(item) === canonical(normalized))) variants.push(normalized);
  };

  // MAX search is prefix-friendly but not reliably typo-tolerant. Relax long tokens
  // by one or two trailing characters, then let the independent title scorer decide.
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const token = parts[index];
    if (token.length < 5) continue;
    for (let cut = 1; cut <= Math.min(2, token.length - 4); cut += 1) {
      const copy = [...parts];
      copy[index] = token.slice(0, -cut);
      add(copy.join(' '));
    }
  }
  if (parts.length > 1 && parts.at(-1).length > 4) {
    add([...parts.slice(0, -1), parts.at(-1).slice(0, 4)].join(' '));
  }
  return variants.slice(0, 7);
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
  const seen = new Set();
  for (let index = 0; index < count; index += 1) {
    const button = locator.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    const box = await button.boundingBox().catch(() => null);
    if (!box || box.x > 470 || box.width < 250 || box.height < 48) continue;
    const lines = await buttonTitleLines(button);
    const title = normalizeText(lines[0]);
    if (!title) continue;
    const key = `${canonical(title)}|${Math.round(box.x)}|${Math.round(box.y)}|${Math.round(box.width)}|${Math.round(box.height)}`;
    if (seen.has(key)) continue;
    seen.add(key);
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

function maskedCandidates(scored) {
  return scored.slice(0, 8).map((item) => ({
    titleHint: maskTitle(item.title),
    score: Number(item.score.toFixed(4)),
  }));
}

function scoreCandidates(candidates, originalQuery) {
  return candidates
    .map((candidate) => ({ ...candidate, score: similarity(originalQuery, candidate.title) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
}

function uniqueStrongCandidate(scored, originalQuery) {
  const top = scored[0];
  const second = scored[1];
  const threshold = canonical(originalQuery).length < 4 ? 0.97 : 0.84;
  const margin = top ? top.score - (second?.score || 0) : 0;
  return {
    candidate: top && top.score >= threshold && (scored.length === 1 || margin >= 0.08) ? top : null,
    topScore: top?.score || 0,
    margin,
  };
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

  let chosen = null;
  let chosenScored = [];
  let searchQueryUsed = query;
  let strategy = registered?.strategy || null;

  if (exactTitle) {
    await search.fill(exactTitle);
    await page.waitForTimeout(1_800);
    chosenScored = scoreCandidates(await visibleCandidates(page), exactTitle);
    const exact = chosenScored.filter((candidate) => canonical(candidate.title) === canonical(exactTitle));
    if (exact.length === 1) {
      chosen = exact[0];
      strategy ||= 'exact-title';
    } else {
      throw Object.assign(new Error(`Expected one visible MAX destination named «${exactTitle}», found ${exact.length}.`), {
        name: 'DestinationResolutionError',
        code: exact.length ? 'exact-title-ambiguous' : 'exact-title-not-found',
        candidates: maskedCandidates(chosenScored),
      });
    }
  } else {
    let bestAttempt = { scored: [], topScore: 0, margin: 0, searchQuery: query };
    for (const searchQuery of searchVariants(query)) {
      await search.fill(searchQuery);
      await page.waitForTimeout(1_500);
      const scored = scoreCandidates(await visibleCandidates(page), query);
      const selection = uniqueStrongCandidate(scored, query);
      if (selection.topScore > bestAttempt.topScore
        || (selection.topScore === bestAttempt.topScore && selection.margin > bestAttempt.margin)) {
        bestAttempt = { scored, topScore: selection.topScore, margin: selection.margin, searchQuery };
      }
      if (selection.candidate) {
        chosen = selection.candidate;
        chosenScored = scored;
        searchQueryUsed = searchQuery;
        strategy = canonical(searchQuery) === canonical(query)
          ? 'deterministic-fuzzy'
          : 'deterministic-fuzzy-expanded';
        break;
      }
    }
    if (!chosen) {
      throw Object.assign(new Error(`MAX destination query «${query}» is not unambiguous enough for an automatic send.`), {
        name: 'DestinationResolutionError',
        code: bestAttempt.scored.length ? 'fuzzy-ambiguous' : 'fuzzy-not-found',
        candidates: maskedCandidates(bestAttempt.scored),
        searchVariants: searchVariants(query),
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
    searchQueryUsed,
    title: chosen.title,
    kind: registered?.kind || normalizeText(destination.kind) || null,
    strategy,
    score: Number(chosen.score.toFixed(4)),
    candidateCount: chosenScored.length,
    candidateIndex: chosen.index,
    candidateBox: chosen.box,
    url: page.url(),
    alternatives: chosenScored.slice(0, 5).map((item) => ({
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

export const destinationMatching = { canonical, similarity, searchVariants };

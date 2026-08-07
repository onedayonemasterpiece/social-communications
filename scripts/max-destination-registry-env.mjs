import fs from 'node:fs/promises';

const PUBLIC_REGISTRY_URL = new URL('../config/max-destinations.public.json', import.meta.url);

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function registryEntries(parsed) {
  if (!parsed) return [];
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.destinations)
      ? parsed.destinations
      : Object.entries(parsed).map(([key, value]) => ({
        key,
        ...(typeof value === 'string' ? { title: value } : value),
      }));

  return entries
    .filter((entry) => entry && normalizeText(entry.title))
    .map((entry) => ({
      key: normalizeText(entry.key),
      title: normalizeText(entry.title),
      kind: normalizeText(entry.kind),
      aliases: Array.isArray(entry.aliases)
        ? [...new Set(entry.aliases.map(normalizeText).filter(Boolean))]
        : [],
    }));
}

function parsePrivateRegistry(rawValue) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return [];
  try {
    return registryEntries(JSON.parse(raw));
  } catch (error) {
    throw new Error(`MAX_DESTINATIONS_JSON is not valid JSON: ${error?.message || error}`);
  }
}

function mergeRegistries(publicEntries, privateEntries) {
  const merged = [];
  const keyedIndexes = new Map();

  for (const entry of [...publicEntries, ...privateEntries]) {
    if (!entry.key) {
      merged.push(entry);
      continue;
    }

    const existingIndex = keyedIndexes.get(entry.key);
    if (existingIndex === undefined) {
      keyedIndexes.set(entry.key, merged.length);
      merged.push(entry);
      continue;
    }

    const existing = merged[existingIndex];
    merged[existingIndex] = {
      key: entry.key,
      title: entry.title || existing.title,
      kind: entry.kind || existing.kind,
      aliases: [...new Set([...(existing.aliases || []), ...(entry.aliases || [])])],
    };
  }

  const duplicateKeys = new Map();
  for (const entry of merged) {
    if (!entry.key) continue;
    duplicateKeys.set(entry.key, (duplicateKeys.get(entry.key) || 0) + 1);
  }
  const invalidKeys = [...duplicateKeys.entries()].filter(([, count]) => count !== 1);
  if (invalidKeys.length) {
    throw new Error(`Merged MAX destination registry contains non-unique keys: ${invalidKeys.map(([key]) => key).join(', ')}`);
  }

  return merged;
}

const publicParsed = JSON.parse(await fs.readFile(PUBLIC_REGISTRY_URL, 'utf8'));
const publicEntries = registryEntries(publicParsed);
const privateEntries = parsePrivateRegistry(process.env.MAX_DESTINATIONS_JSON);
const destinations = mergeRegistries(publicEntries, privateEntries);

process.env.MAX_DESTINATIONS_JSON = JSON.stringify({
  version: 1,
  destinations,
});

console.log(
  `MAX_DESTINATION_REGISTRY=loaded public=${publicEntries.length} private=${privateEntries.length} merged=${destinations.length}`,
);

export const destinationRegistry = Object.freeze(destinations.map((entry) => Object.freeze({
  ...entry,
  aliases: Object.freeze([...(entry.aliases || [])]),
})));

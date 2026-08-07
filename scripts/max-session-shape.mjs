import fs from 'node:fs/promises';
import path from 'node:path';

const raw = String(process.env.MAX_SESSION || '').trim();
const artifactDir = path.resolve(process.env.MAX_ARTIFACT_DIR || 'artifacts/max-web');
await fs.mkdir(artifactDir, { recursive: true });

function classifyString(value) {
  const trimmed = value.trim();
  return {
    type: 'string',
    length: value.length,
    empty: value.length === 0,
    startsWithJsonDelimiter: /^[\[{\"]/.test(trimmed),
    looksLikeJwt: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed),
    looksLikeUrl: /^https?:\/\//i.test(trimmed),
    looksLikeCookieHeader: /^[^=;\s]+=[^;]*(?:;\s*[^=;\s]+=[^;]*)+$/.test(trimmed),
    looksLikeBase64: trimmed.length >= 16 && /^[A-Za-z0-9+/_=-]+$/.test(trimmed.replace(/\s+/g, '')),
  };
}

function summarize(value, depth = 0, seen = new WeakSet()) {
  if (value === null) return { type: 'null' };
  if (typeof value === 'string') return classifyString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return { type: typeof value };
  if (typeof value !== 'object') return { type: typeof value };
  if (seen.has(value)) return { type: 'circular' };
  seen.add(value);

  if (Array.isArray(value)) {
    const result = {
      type: 'array',
      length: value.length,
    };
    if (depth < 5) {
      result.items = value.slice(0, 5).map((item) => summarize(item, depth + 1, seen));
    }
    return result;
  }

  const keys = Object.keys(value).sort();
  const result = {
    type: 'object',
    keyCount: keys.length,
    keys,
  };
  if (depth < 5) {
    result.properties = Object.fromEntries(
      keys.slice(0, 100).map((key) => [key, summarize(value[key], depth + 1, seen)]),
    );
  }
  return result;
}

const report = {
  rawLength: raw.length,
  empty: raw.length === 0,
  firstNonWhitespaceKind: raw ? ({ '{': 'object', '[': 'array', '"': 'quoted-string' }[raw[0]] || 'other') : 'none',
  parses: [],
};

let current = raw;
for (let depth = 0; depth < 4; depth += 1) {
  try {
    const parsed = JSON.parse(current);
    report.parses.push({ depth, success: true, shape: summarize(parsed) });
    if (typeof parsed === 'string' && parsed !== current) {
      current = parsed.trim();
      continue;
    }
    break;
  } catch (error) {
    report.parses.push({
      depth,
      success: false,
      errorName: error?.name || 'Error',
      errorMessage: String(error?.message || error).replace(/position \d+/i, 'position [redacted]'),
    });
    break;
  }
}

await fs.writeFile(
  path.join(artifactDir, 'session-shape.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
);

console.log(`MAX_SESSION_SHAPE_WRITTEN=1 raw_length=${raw.length}`);

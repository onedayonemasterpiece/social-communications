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
    const result = { type: 'array', length: value.length };
    if (depth < 5) result.items = value.slice(0, 5).map((item) => summarize(item, depth + 1, seen));
    return result;
  }

  const keys = Object.keys(value).sort();
  const result = { type: 'object', keyCount: keys.length, keys };
  if (depth < 5) {
    result.properties = Object.fromEntries(
      keys.slice(0, 100).map((key) => [key, summarize(value[key], depth + 1, seen)]),
    );
  }
  return result;
}

function appendMissingJsonClosers(value) {
  const stack = [];
  let inString = false;
  let escaped = false;

  for (const character of value) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{' || character === '[') {
      stack.push(character);
    } else if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '[';
      if (stack.at(-1) === expected) stack.pop();
    }
  }

  if (inString || stack.length === 0 || stack.length > 8) {
    return { repaired: value, appended: '', inString, stackDepth: stack.length };
  }

  const appended = stack.reverse().map((opening) => (opening === '{' ? '}' : ']')).join('');
  return { repaired: `${value}${appended}`, appended, inString, stackDepth: stack.length };
}

function safeParse(value) {
  try {
    return { success: true, parsed: JSON.parse(value) };
  } catch (error) {
    return {
      success: false,
      errorName: error?.name || 'Error',
      errorMessage: String(error?.message || error).replace(/position \d+/i, 'position [redacted]'),
    };
  }
}

const report = {
  rawLength: raw.length,
  empty: raw.length === 0,
  firstNonWhitespaceKind: raw ? ({ '{': 'object', '[': 'array', '"': 'quoted-string' }[raw[0]] || 'other') : 'none',
  parses: [],
};

let current = raw;
for (let depth = 0; depth < 4; depth += 1) {
  const direct = safeParse(current);
  if (direct.success) {
    report.parses.push({ depth, success: true, mode: 'direct', shape: summarize(direct.parsed) });
    if (typeof direct.parsed === 'string' && direct.parsed !== current) {
      current = direct.parsed.trim();
      continue;
    }
    break;
  }

  report.parses.push({
    depth,
    success: false,
    mode: 'direct',
    errorName: direct.errorName,
    errorMessage: direct.errorMessage,
  });

  const repair = appendMissingJsonClosers(current);
  report.repair = {
    attempted: repair.appended.length > 0,
    appendedCharacters: repair.appended.length,
    appendedKinds: repair.appended.replace(/}/g, 'object-close').replace(/]/g, 'array-close'),
    stringWasOpenAtEnd: repair.inString,
    unmatchedContainerCount: repair.stackDepth,
  };

  if (repair.appended.length > 0) {
    const repaired = safeParse(repair.repaired);
    if (repaired.success) {
      report.parses.push({ depth, success: true, mode: 'appended-missing-closers', shape: summarize(repaired.parsed) });
    } else {
      report.parses.push({
        depth,
        success: false,
        mode: 'appended-missing-closers',
        errorName: repaired.errorName,
        errorMessage: repaired.errorMessage,
      });
    }
  }
  break;
}

await fs.writeFile(
  path.join(artifactDir, 'session-shape.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
);

console.log(`MAX_SESSION_SHAPE_WRITTEN=1 raw_length=${raw.length}`);

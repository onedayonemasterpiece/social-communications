import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeText } from './max-ui.mjs';
import { destinationForLegacyChat } from './max-destination.mjs';

const DEFAULT_COMMAND_FILE = '.github/max-live-command.json';
const DELIVERY_MODES = new Set(['send_now', 'schedule_at', 'stage_only']);
const CONTENT_TYPES = new Set(['text', 'rich_post']);

function normalizeLinks(links) {
  if (!Array.isArray(links)) return [];
  if (links.length > 10) throw new Error('MAX command supports at most 10 formatted links.');
  return links.map((link) => {
    const text = normalizeText(link?.text);
    if (!text) throw new Error('Each formatted link requires text.');
    const url = new URL(link?.url);
    if (url.protocol !== 'https:') throw new Error('Formatted links must use HTTPS.');
    return { text, url: url.href };
  });
}

function normalizeDestination(value = {}) {
  const destination = {
    key: normalizeText(value.key) || null,
    exactTitle: normalizeText(value.exactTitle || value.title) || null,
    query: normalizeText(value.query) || null,
    kind: normalizeText(value.kind) || null,
  };
  if (!destination.key && !destination.exactTitle && !destination.query) {
    throw new Error('MAX command requires destination.key, destination.exactTitle, or destination.query.');
  }
  return destination;
}

function normalizeContent(value = {}) {
  const type = normalizeText(value.type || 'text');
  if (!CONTENT_TYPES.has(type)) throw new Error(`Unsupported MAX content type: ${type}.`);
  const text = normalizeText(value.text);
  if (!text) throw new Error('MAX command requires non-empty content.text.');
  if (text.length > 4_000) throw new Error('MAX command text exceeds the 4000-character safety limit.');

  if (type === 'text') return { type, text, links: [] };

  const imagePath = normalizeText(value.image?.path);
  if (!imagePath) throw new Error('MAX rich_post content requires image.path.');
  const links = normalizeLinks(value.links);
  if (!links.length) throw new Error('MAX rich_post content requires at least one formatted HTTPS link.');
  return {
    type,
    text,
    image: { path: imagePath },
    links,
  };
}

function normalizeDelivery(value = {}, fallbackMode = 'send_now') {
  const mode = normalizeText(value.mode || fallbackMode);
  if (!DELIVERY_MODES.has(mode)) throw new Error(`Unsupported MAX delivery mode: ${mode}.`);
  const timeZone = normalizeText(value.timeZone) || 'Europe/Kaliningrad';
  const scheduleAt = normalizeText(value.scheduleAt) || null;
  const stageAt = normalizeText(value.stageAt) || null;
  if (mode === 'schedule_at' && !scheduleAt) throw new Error('MAX schedule_at delivery requires scheduleAt.');
  for (const [field, raw] of [['scheduleAt', scheduleAt], ['stageAt', stageAt]]) {
    if (!raw) continue;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid MAX ${field}: ${raw}.`);
  }
  return {
    mode,
    scheduleAt,
    stageAt,
    timeZone,
    recipientInvisiblePreparation: value.recipientInvisiblePreparation !== false,
    reuseExistingStage: value.reuseExistingStage !== false,
  };
}

function normalizeV1(command) {
  const action = normalizeText(command.action);
  if (!['text', 'schedule_text', 'rich_post'].includes(action)) {
    throw new Error(`Unsupported legacy MAX action: ${action}.`);
  }
  const content = normalizeContent({
    type: action === 'rich_post' ? 'rich_post' : 'text',
    text: command.text,
    image: command.image,
    links: command.links,
  });
  const fallbackMode = action === 'schedule_text' ? 'schedule_at' : 'send_now';
  const delivery = normalizeDelivery({
    mode: command.delivery?.mode || fallbackMode,
    scheduleAt: command.delivery?.scheduleAt || command.scheduleAt,
    stageAt: command.delivery?.stageAt,
    timeZone: command.delivery?.timeZone || command.timeZone,
    recipientInvisiblePreparation: command.delivery?.recipientInvisiblePreparation,
    reuseExistingStage: command.delivery?.reuseExistingStage,
  }, fallbackMode);
  return {
    version: 2,
    sourceVersion: 1,
    requestId: normalizeText(command.requestId),
    destination: normalizeDestination(command.destination || destinationForLegacyChat(command.chat)),
    content,
    delivery,
    verifyOnly: command.verifyOnly === true,
  };
}

function normalizeV2(command) {
  return {
    version: 2,
    sourceVersion: 2,
    requestId: normalizeText(command.requestId),
    destination: normalizeDestination(command.destination),
    content: normalizeContent(command.content),
    delivery: normalizeDelivery(command.delivery),
    verifyOnly: command.verifyOnly === true,
  };
}

export function normalizeMaxCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new Error('MAX command must be a JSON object.');
  }
  const version = Number(command.version);
  const normalized = version === 1 ? normalizeV1(command) : version === 2 ? normalizeV2(command) : null;
  if (!normalized) throw new Error('MAX command version must be 1 or 2.');
  if (!normalized.requestId) throw new Error('MAX command requires requestId.');
  if (normalized.requestId.length > 200) throw new Error('MAX requestId exceeds 200 characters.');
  if (normalized.verifyOnly && normalized.delivery.mode === 'stage_only') {
    throw new Error('verifyOnly cannot be combined with stage_only.');
  }
  if (normalized.delivery.recipientInvisiblePreparation !== true) {
    throw new Error('MAX recipientInvisiblePreparation cannot be disabled in the safe sender.');
  }
  return normalized;
}

export async function loadMaxCommand(options = {}) {
  const commandFile = options.commandFile
    || process.env.MAX_COMMAND_FILE?.trim()
    || DEFAULT_COMMAND_FILE;
  const raw = process.env.MAX_COMMAND_JSON?.trim()
    || await fs.readFile(path.resolve(commandFile), 'utf8');
  return normalizeMaxCommand(JSON.parse(raw));
}

export function commandReceipt(command) {
  return {
    version: command.version,
    sourceVersion: command.sourceVersion,
    requestId: command.requestId,
    destination: {
      key: command.destination.key,
      exactTitle: command.destination.exactTitle,
      query: command.destination.query,
      kind: command.destination.kind,
    },
    contentType: command.content.type,
    deliveryMode: command.delivery.mode,
    scheduleAt: command.delivery.scheduleAt,
    stageAt: command.delivery.stageAt,
    timeZone: command.delivery.timeZone,
    verifyOnly: command.verifyOnly,
  };
}

export function legacyVerifierCommand(command, resolvedTitle, scheduleAt = command.delivery.scheduleAt) {
  return {
    version: 1,
    requestId: command.requestId,
    chat: { title: resolvedTitle },
    action: command.content.type === 'rich_post' ? 'rich_post' : command.delivery.mode === 'schedule_at' ? 'schedule_text' : 'text',
    text: command.content.text,
    image: command.content.image,
    links: command.content.links,
    scheduleAt,
    timeZone: command.delivery.timeZone,
    verifyOnly: command.verifyOnly,
  };
}

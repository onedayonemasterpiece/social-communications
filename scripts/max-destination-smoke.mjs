await import('./max-destination-registry-env.mjs');

const { launchAuthenticatedMax } = await import('./max-runtime.mjs');
const { resolveDestination } = await import('./max-destination.mjs');

const keys = String(
  process.env.MAX_DESTINATION_KEYS
    || 'polubit-kaliningrad-anonsy,uh-ty-kaliningrad',
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

if (!keys.length) throw new Error('MAX destination smoke requires at least one registry key.');

const results = [];
for (const key of keys) {
  let runtime;
  try {
    runtime = await launchAuthenticatedMax();
    const resolved = await resolveDestination(runtime.page, { key });
    results.push({
      key,
      title: resolved.title,
      kind: resolved.kind,
      strategy: resolved.strategy,
      score: resolved.score,
      searchQueryUsed: resolved.searchQueryUsed,
    });
    console.log(
      `MAX_DESTINATION_SMOKE=pass key=${key} kind=${resolved.kind || 'unknown'} strategy=${resolved.strategy} title=${JSON.stringify(resolved.title)}`,
    );
  } finally {
    if (runtime?.context) await runtime.context.close().catch(() => {});
    if (runtime?.browser) await runtime.browser.close().catch(() => {});
  }
}

console.log(`MAX_DESTINATION_SMOKE_RESULT=pass count=${results.length}`);

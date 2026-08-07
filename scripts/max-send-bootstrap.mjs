// Canonical bootstrap: load the merged public/private destination registry before
// any sender module imports the deterministic resolver.
await import('./max-destination-registry-env.mjs');
await import('./max-schedule-ui-compat.mjs');
await import('./max-safe-send.mjs');

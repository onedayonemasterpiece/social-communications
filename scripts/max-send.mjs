// Compatibility entrypoint. Direct sending is intentionally disabled:
// all commands are routed through the canonical staged bootstrap, which loads
// public/private destination registries before the deterministic resolver.
console.warn('MAX_LEGACY_ENTRYPOINT_REDIRECT=max-send.mjs->max-send-bootstrap.mjs');
await import('./max-send-bootstrap.mjs');

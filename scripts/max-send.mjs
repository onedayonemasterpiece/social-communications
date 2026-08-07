// Compatibility entrypoint. Direct sending is intentionally disabled:
// all commands are routed through the recipient-invisible staged executor.
console.warn('MAX_LEGACY_ENTRYPOINT_REDIRECT=max-send.mjs->max-safe-send.mjs');
await import('./max-safe-send.mjs');

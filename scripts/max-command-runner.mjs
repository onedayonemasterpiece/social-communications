// Compatibility entrypoint. Legacy command envelopes are normalized by
// max-command-contract.mjs and executed only through the staged sender.
console.warn('MAX_LEGACY_ENTRYPOINT_REDIRECT=max-command-runner.mjs->max-safe-send.mjs');
await import('./max-safe-send.mjs');

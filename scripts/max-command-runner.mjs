// Compatibility entrypoint. Legacy command envelopes are normalized by
// max-command-contract.mjs and executed only through the canonical staged
// bootstrap with merged public/private destination registries.
console.warn('MAX_LEGACY_ENTRYPOINT_REDIRECT=max-command-runner.mjs->max-send-bootstrap.mjs');
await import('./max-send-bootstrap.mjs');

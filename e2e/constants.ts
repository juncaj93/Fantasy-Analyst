/** Shared e2e constants. Kept free of `test()` calls so the config can import it. */
export const AUTH_STATE = 'test-results/.auth/state.json';
export const E2E_PASSPHRASE = process.env.E2E_PASSPHRASE ?? 'e2e-passphrase';

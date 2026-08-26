/** Shared e2e constants. Kept free of `test()` calls so the config can import it. */

/**
 * Where the shared login is stored.
 *
 * Overridable because the shards can run side by side. CI gives each
 * `--shard=n/3` its own machine, so one fixed path is enough there; running the
 * same twelve combinations locally means twelve processes in one checkout, and
 * Playwright empties its output directory at the start of a run — so a sibling
 * that started a second later would delete the state file this one is about to
 * read. Point each run at its own `--output` directory and its own
 * `E2E_AUTH_STATE` inside it and they stop colliding.
 *
 * The default is the path every existing caller already uses, so a plain
 * `npm run e2e` is unchanged.
 */
export const AUTH_STATE = process.env.E2E_AUTH_STATE ?? 'test-results/.auth/state.json';
export const E2E_PASSPHRASE = process.env.E2E_PASSPHRASE ?? 'e2e-passphrase';

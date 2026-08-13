/**
 * Logs in once per run and stores the session for every other spec.
 *
 * Without this, each test would burn a login attempt and trip the server's
 * brute-force limiter — which is a feature, not something to weaken for tests.
 * The UI login flow itself is still covered by `auth.spec.ts`.
 */

import { test as setup, expect } from '@playwright/test';
import { AUTH_STATE, E2E_PASSPHRASE } from './constants.ts';

setup('authenticate', async ({ request }) => {
  const res = await request.post('/api/auth/login', {
    data: { passphrase: E2E_PASSPHRASE },
  });
  expect(res.status(), 'login should succeed').toBe(200);
  await request.storageState({ path: AUTH_STATE });
});

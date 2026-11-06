/**
 * One request, retried only when the connection itself failed.
 *
 * The deploy check used to be a row of `curl` calls under `set -e`, so one
 * dropped connection failed the whole deploy: on 5 November 2026 the lineup
 * route's curl ended with error 56 (the connection was reset while the answer
 * was arriving) on a release that was perfectly fine, and the deploy had to be
 * re-run by hand.
 *
 * A network error is retried, up to {@link NETWORK_ATTEMPTS} tries in all: the
 * request could not be sent, the connection dropped or was reset, the answer
 * stopped part way, or it took longer than {@link REQUEST_TIMEOUT_MS}. A real
 * answer is never retried here, whatever its status: a 404, a 500 or a wrong
 * body is the deployment speaking, and the caller decides what it means.
 *
 * Dependency-free, like the other release scripts, so it runs before `npm ci`.
 */

export const NETWORK_ATTEMPTS = 3;
export const NETWORK_RETRY_DELAY_MS = 3_000;
export const REQUEST_TIMEOUT_MS = 30_000;

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Why a request threw, in a few words, for the log. */
export function describeNetworkError(err) {
  const cause = err && typeof err === 'object' && 'cause' in err ? err.cause : null;
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
  const message = err instanceof Error ? err.message : String(err);
  return code ? `${message} (${code})` : message;
}

/**
 * Fetch `url` and read the whole body, retrying network errors only.
 *
 * Resolves to `{ ok: true, status, headers, text, attempts }` (`buffer` in
 * place of `text` with `binary: true`) for any answer
 * the site gave, or `{ ok: false, error, attempts }` when every try failed to
 * get one. The body is read inside the retry, because a connection that drops
 * while the answer is arriving (curl's error 56) is a network error too.
 */
export async function fetchWithRetry(url, init = {}, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? NETWORK_ATTEMPTS;
  const delayMs = opts.delayMs ?? NETWORK_RETRY_DELAY_MS;
  const sleep = opts.sleep ?? sleepFor;
  const onRetry = opts.onRetry ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;

  let error = 'no attempt was made';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
      const res = await fetchImpl(url, { redirect: 'follow', ...init, ...(signal ? { signal } : {}) });
      if (opts.binary) {
        const buffer = await res.arrayBuffer();
        return { ok: true, status: res.status, headers: res.headers, buffer, attempts: attempt };
      }
      const text = await res.text();
      return { ok: true, status: res.status, headers: res.headers, text, attempts: attempt };
    } catch (err) {
      error = describeNetworkError(err);
      if (attempt < attempts) {
        onRetry(`  network error on ${url} (try ${attempt}/${attempts}): ${error}; trying again`);
        await sleep(delayMs);
      }
    }
  }
  return { ok: false, error, attempts };
}

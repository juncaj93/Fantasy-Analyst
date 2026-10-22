/**
 * Tiny Web-standard router.
 *
 * Dependency-free and runtime-agnostic: the same handler set runs on Cloudflare
 * Workers and on the local Node dev/e2e server.
 */

export interface RouteContext<Env = unknown> {
  request: Request;
  env: Env;
  params: Record<string, string>;
  url: URL;
  /** Parsed JSON body, or null. Never throws on malformed input. */
  json<T>(): Promise<T | null>;
}

export type Handler<Env> = (ctx: RouteContext<Env>) => Promise<Response> | Response;

interface Route<Env> {
  method: string;
  pattern: string;
  segments: string[];
  handler: Handler<Env>;
}

export class Router<Env> {
  private readonly routes: Route<Env>[] = [];
  private middlewares: ((ctx: RouteContext<Env>) => Promise<Response | null>)[] = [];

  use(mw: (ctx: RouteContext<Env>) => Promise<Response | null>): this {
    this.middlewares.push(mw);
    return this;
  }

  add(method: string, pattern: string, handler: Handler<Env>): this {
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      segments: pattern.split('/').filter(Boolean),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: Handler<Env>): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler<Env>): this {
    return this.add('POST', pattern, handler);
  }

  async handle(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/').filter(Boolean);

    for (const route of this.routes) {
      if (route.method !== request.method.toUpperCase()) continue;
      const params = matchSegments(route.segments, pathSegments);
      if (!params) continue;

      const ctx: RouteContext<Env> = {
        request,
        env,
        params,
        url,
        json: async <T,>() => {
          try {
            return (await request.clone().json()) as T;
          } catch {
            return null;
          }
        },
      };

      /*
       * Middleware inside the guard, not beside it.
       *
       * It used to run before the `try`, which meant an exception from a
       * middleware — `verifySession` is `crypto.subtle` work and can throw —
       * left this router entirely, left the Worker, and was answered by
       * Cloudflare's own error page: `text/html`, status 500, on a path under
       * `/api/`. A client that asked for JSON got markup, which is the failure
       * this whole change exists to remove, arriving from the one source this
       * repository owns.
       *
       * The rule the API keeps, stated in one place: **every answer to an
       * `/api/` request that leaves this router is JSON**, including the ones
       * nobody meant to send.
       */
      try {
        for (const mw of this.middlewares) {
          const early = await mw(ctx);
          if (early) return early;
        }
        return await route.handler(ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        /*
         * Written down as well as answered. A caught exception never reaches
         * the Workers log on its own, so without this line the only trace of
         * a screen that failed to load was the response the phone threw away.
         */
        console.error(`${request.method.toUpperCase()} ${url.pathname} failed`, err);
        return jsonResponse(uncaughtBody(request.method, message), 500);
      }
    }
    return jsonResponse({ error: 'not found', path: url.pathname }, 404);
  }
}

function matchSegments(routeSegments: string[], pathSegments: string[]): Record<string, string> | null {
  if (routeSegments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < routeSegments.length; i++) {
    const r = routeSegments[i]!;
    const p = pathSegments[i]!;
    if (r.startsWith(':')) params[r.slice(1)] = decodeURIComponent(p);
    else if (r !== p) return null;
  }
  return params;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

/**
 * The body of a 500 nobody meant to send.
 *
 * A read that throws is a screen failing to load, and the exception's own
 * words ("Cannot read properties of undefined", "D1_ERROR …") are not
 * something to put in front of a reader. With no `error` string, the client
 * shows its own line ("Couldn’t load this yet. Pull to refresh or try
 * again."); the message stays in `detail` for diagnostics and in the log.
 *
 * A write keeps the message as `error`, because Setup's actions say their
 * own failures that way (connecting an unknown Sleeper username, an import
 * the parser refused) and those words are the useful part.
 */
export function uncaughtBody(method: string, message: string): { error: string } | { detail: string } {
  const verb = method.toUpperCase();
  return verb === 'GET' || verb === 'HEAD' ? { detail: message } : { error: message };
}

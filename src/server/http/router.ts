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

      for (const mw of this.middlewares) {
        const early = await mw(ctx);
        if (early) return early;
      }

      try {
        return await route.handler(ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResponse({ error: message }, 500);
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

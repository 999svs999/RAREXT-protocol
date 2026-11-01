/**
 * Types for build-route-index.mjs.
 *
 * The generator is plain JavaScript (like every script here) but a test imports it to prove the
 * committed artifact came from the committed generator, and an untyped import would be an implicit
 * `any` — a hole in exactly the check that is supposed to have none.
 */

export interface RouteIndexRoute {
  method: string;
  path: string;
  body: string;
  response: string;
}

export interface RouteIndex {
  kind: string;
  note: string;
  schemas: Record<string, string>;
  count: number;
  routes: RouteIndexRoute[];
}

/** Parse the doc's `| METHOD | \`path\` | body | response |` table, in order. */
export function routeIndexFromDoc(doc: string): RouteIndexRoute[];

/** The index as an object. */
export function buildRouteIndex(): RouteIndex;

/** The index as the exact bytes that belong in site/schema/routes.json. */
export function serializeRouteIndex(): string;

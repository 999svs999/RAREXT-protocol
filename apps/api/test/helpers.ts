import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { createApp } from "../src/app.ts";
import type { AppOptions } from "../src/app.ts";
import { RarextStore } from "../src/store.ts";

export async function start(
  store: RarextStore = new RarextStore(),
  options: Omit<AppOptions, "store"> = {},
) {
  const server = createApp({ store, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { server, store, base: `http://127.0.0.1:${port}` };
}

export function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function stop(server: ReturnType<typeof createApp>): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

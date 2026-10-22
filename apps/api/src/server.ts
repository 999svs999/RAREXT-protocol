import { createApp } from "./app.ts";
import { RarextStore } from "./store.ts";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA = process.env.RAREXT_DATA;
const store = DATA === "none" ? new RarextStore() : new RarextStore(DATA ?? ".data/rarext.json");

const server = createApp({ store });

server.listen(PORT, HOST, () => {
  console.log(`RAREXT API listening on http://${HOST}:${PORT}`);
});

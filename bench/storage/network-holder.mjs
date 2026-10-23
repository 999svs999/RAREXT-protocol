import { createHolderServer } from "../../apps/api/src/holder-server.ts";

const id = process.env.HOLDER_ID;
const directory = process.env.HOLDER_DIR;
const token = process.env.HOLDER_TOKEN;

if (!id || !directory) throw new Error("HOLDER_ID and HOLDER_DIR are required");

const server = createHolderServer({ id, directory, token });
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log(`PORT ${typeof address === "object" && address ? address.port : 0}`);
});

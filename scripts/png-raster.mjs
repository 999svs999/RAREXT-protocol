// Re-exported from the SDK: one encoder, used by the publishers AND by a
// resident that wants to ship the same artifact shape (`selfPublishGenerative`'s
// `rendition`). The implementation moved; this file's API did not.
export { crc32, encodePngRaster } from "../packages/agent-sdk/src/png.ts";

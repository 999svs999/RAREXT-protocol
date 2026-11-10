export interface HfTensor {
  name: string;
  type: number;
  dims: number[];
  bytes: Uint8Array;
}
export function mapTensorName(name: string): string | null;
export function readSafetensors(files: string[]): Map<
  string,
  { dtype: string; shape: number[]; bytes: Uint8Array }
>;
export function parseSentencePieceModel(buffer: Uint8Array): {
  pieces: string[];
  scores: number[];
  types: number[];
};
export function tokenizeSection(dir: string, config: Record<string, unknown>): Record<string, unknown>;
export function hparamsSection(config: Record<string, unknown>): Record<string, unknown>;
export function buildContainer(kv: Record<string, unknown>, tensors: HfTensor[]): Buffer;
export function convertHfDirectory(dir: string): {
  bytes: Buffer;
  tensorCount: number;
  ggmlTypes: string[];
};

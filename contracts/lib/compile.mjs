import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import solc from "solc";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function walk(directory, visit) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else if (entry.name.endsWith(".sol")) visit(path);
  }
}

function addTree(sources, prefix, directory) {
  walk(directory, (path) => {
    sources[`${prefix}/${relative(directory, path)}`] = {
      content: readFileSync(path, "utf8"),
    };
  });
}

/**
 * Compile the anchor contract and its test fixture against the pinned
 * OpenZeppelin sources in `node_modules`. All sources are passed to solc
 * explicitly, so the result does not depend on an import callback or on the
 * caller's working directory.
 */
export function compileContracts({ includeTestFixture = true } = {}) {
  const sources = {};

  addTree(sources, "@openzeppelin/contracts", join(ROOT, "node_modules/@openzeppelin/contracts"));
  addTree(
    sources,
    "@openzeppelin/contracts-upgradeable",
    join(ROOT, "node_modules/@openzeppelin/contracts-upgradeable"),
  );

  sources["contracts/RarextAnchor.sol"] = {
    content: readFileSync(join(ROOT, "contracts/RarextAnchor.sol"), "utf8"),
  };
  if (includeTestFixture) {
    sources["contracts/test/RarextAnchorV2.sol"] = {
      content: readFileSync(join(ROOT, "contracts/test/RarextAnchorV2.sol"), "utf8"),
    };
  }

  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: {
        "*": {
          "*": [
            "abi",
            "evm.bytecode.object",
            "evm.deployedBytecode.object",
            "storageLayout",
          ],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const fatal = (output.errors ?? []).filter((entry) => entry.severity === "error");

  if (fatal.length > 0) {
    throw new Error(fatal.map((entry) => entry.formattedMessage).join("\n"));
  }

  return {
    anchor: output.contracts["contracts/RarextAnchor.sol"].RarextAnchor,
    v2: includeTestFixture
      ? output.contracts["contracts/test/RarextAnchorV2.sol"].RarextAnchorV2
      : undefined,
    proxy:
      output.contracts["@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol"][
        "ERC1967Proxy"
      ],
  };
}

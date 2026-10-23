#!/usr/bin/env node
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  getAddress,
} from "ethers";

import { compileContracts } from "../lib/compile.mjs";

const {
  ANCHOR_RPC_URL,
  ANCHOR_DEPLOYER_KEY,
  ANCHOR_EXPECTED_CHAIN_ID,
  ANCHOR_OWNER,
  ANCHOR_PUBLISHER,
} = process.env;

const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

function required(name, value) {
  if (!value || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

async function main() {
  const rpcUrl = required("ANCHOR_RPC_URL", ANCHOR_RPC_URL);
  const privateKey = required("ANCHOR_DEPLOYER_KEY", ANCHOR_DEPLOYER_KEY);
  const expectedChainId = BigInt(
    required("ANCHOR_EXPECTED_CHAIN_ID", ANCHOR_EXPECTED_CHAIN_ID),
  );

  const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });

  try {
    const wallet = new Wallet(privateKey, provider);
    const owner = ANCHOR_OWNER ? getAddress(ANCHOR_OWNER.trim()) : wallet.address;
    const publisher = ANCHOR_PUBLISHER
      ? getAddress(ANCHOR_PUBLISHER.trim())
      : undefined;

    if (publisher !== undefined && owner.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error(
        "ANCHOR_PUBLISHER can only be set when ANCHOR_OWNER is the deployer; " +
          "ask the owner to call setPublisher after deployment",
      );
    }

    const network = await provider.getNetwork();
    if (network.chainId !== expectedChainId) {
      throw new Error(
        `RPC is chain ${network.chainId}, expected ${expectedChainId}; refusing to deploy`,
      );
    }

    const balance = await provider.getBalance(wallet.address);
    if (balance === 0n) {
      throw new Error(`deployer ${wallet.address} has no native token for gas`);
    }

    const artifacts = compileContracts({ includeTestFixture: false });
    const anchorFactory = new ContractFactory(
      artifacts.anchor.abi,
      `0x${artifacts.anchor.evm.bytecode.object}`,
      wallet,
    );

    const implementation = await anchorFactory.deploy();
    const implementationTransaction = implementation.deploymentTransaction();
    if (!implementationTransaction) {
      throw new Error("implementation deployment produced no transaction");
    }
    const implementationReceipt = await implementationTransaction.wait();
    if (!implementationReceipt) {
      throw new Error("implementation deployment was not mined");
    }
    const implementationAddress = await implementation.getAddress();

    const proxyFactory = new ContractFactory(
      artifacts.proxy.abi,
      `0x${artifacts.proxy.evm.bytecode.object}`,
      wallet,
    );
    const initializeData = implementation.interface.encodeFunctionData(
      "initialize",
      [owner],
    );
    const proxy = await proxyFactory.deploy(implementationAddress, initializeData);
    const proxyTransaction = proxy.deploymentTransaction();
    if (!proxyTransaction) {
      throw new Error("proxy deployment produced no transaction");
    }
    const proxyReceipt = await proxyTransaction.wait();
    if (!proxyReceipt) {
      throw new Error("proxy deployment was not mined");
    }
    const proxyAddress = await proxy.getAddress();

    const [proxyCode, implementationCode, implementationSlot] = await Promise.all([
      provider.getCode(proxyAddress),
      provider.getCode(implementationAddress),
      provider.getStorage(proxyAddress, ERC1967_IMPLEMENTATION_SLOT),
    ]);

    if (proxyCode === "0x") throw new Error("proxy deployment produced no code");
    if (implementationCode === "0x") {
      throw new Error("implementation deployment produced no code");
    }

    const proxyImplementation = getAddress(`0x${implementationSlot.slice(-40)}`);
    if (proxyImplementation.toLowerCase() !== implementationAddress.toLowerCase()) {
      throw new Error(
        `proxy implementation mismatch: expected ${implementationAddress}, got ${proxyImplementation}`,
      );
    }

    const anchor = new Contract(proxyAddress, artifacts.anchor.abi, provider);
    const [version, paused, anchorCount, actualOwner, upgradeInterfaceVersion] =
      await Promise.all([
        anchor.version(),
        anchor.paused(),
        anchor.anchorCount(),
        anchor.owner(),
        anchor.UPGRADE_INTERFACE_VERSION(),
      ]);

    if (actualOwner.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(`owner mismatch: expected ${owner}, got ${actualOwner}`);
    }
    if (version !== "1.0.0") {
      throw new Error(`unexpected contract version: ${version}`);
    }
    if (upgradeInterfaceVersion !== "5.0.0") {
      throw new Error(
        `unexpected upgrade interface version: ${upgradeInterfaceVersion}`,
      );
    }
    if (paused) throw new Error("proxy initialized paused");
    if (anchorCount !== 0n) {
      throw new Error(`fresh proxy reports ${anchorCount} anchors`);
    }

    let publisherTransaction = null;
    if (publisher !== undefined) {
      const tx = await anchor.connect(wallet).setPublisher(publisher, true);
      const receipt = await tx.wait();
      if (!receipt) {
        throw new Error("publisher transaction was not mined");
      }
      const allowed = await anchor.isPublisher(publisher);
      if (!allowed) throw new Error(`publisher ${publisher} was not authorized`);
      publisherTransaction = { hash: tx.hash, blockNumber: receipt.blockNumber };
    }

    console.log(
      JSON.stringify(
        {
          chainId: network.chainId.toString(),
          deployer: wallet.address,
          owner: actualOwner,
          publisher: publisher ?? null,
          version,
          upgradeInterfaceVersion,
          paused,
          anchorCount: anchorCount.toString(),
          implementation: implementationAddress,
          proxy: proxyAddress,
          proxyImplementation,
          transactions: {
            implementation: {
              hash: implementationTransaction.hash,
              blockNumber: implementationReceipt.blockNumber,
            },
            proxy: {
              hash: proxyTransaction.hash,
              blockNumber: proxyReceipt.blockNumber,
            },
            publisher: publisherTransaction,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    provider.destroy();
  }
}

main().catch((error) => {
  console.error(`deploy-anchor: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

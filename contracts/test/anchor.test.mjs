import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Common, Hardfork, Mainnet } from "@ethereumjs/common";
import { createVM } from "@ethereumjs/vm";
import {
  createAccount,
  createAddressFromString,
  bytesToHex,
  hexToBytes,
} from "@ethereumjs/util";
import { AbiCoder, Interface, hexlify, keccak256, toUtf8Bytes } from "ethers";

import { compileContracts } from "./helpers.mjs";

const artifacts = compileContracts();
const anchorInterface = new Interface(artifacts.anchor.abi);
const v2Interface = new Interface(artifacts.v2.abi);

const ACCOUNTS = {
  deployer: "0x1000000000000000000000000000000000000001",
  owner: "0x2000000000000000000000000000000000000002",
  publisher: "0x3000000000000000000000000000000000000003",
  other: "0x4000000000000000000000000000000000000004",
  newOwner: "0x5000000000000000000000000000000000000005",
};

const BLOCK = {
  header: {
    number: 1n,
    coinbase: createAddressFromString(ACCOUNTS.deployer),
    timestamp: 1_700_000_000n,
    difficulty: 0n,
    prevRandao: new Uint8Array(32),
    gasLimit: 30_000_000n,
    baseFeePerGas: undefined,
    slotNumber: 0n,
    getBlobGasPrice: () => undefined,
  },
};

async function createNode() {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Prague });
  const vm = await createVM({ common });
  const accounts = {};

  for (const [name, address] of Object.entries(ACCOUNTS)) {
    const parsed = createAddressFromString(address);
    accounts[name] = parsed;
    await vm.stateManager.putAccount(
      parsed,
      createAccount({ nonce: 0n, balance: 10n ** 24n }),
    );
  }

  return { vm, accounts };
}

async function create(vm, from, abi, bytecode, types = [], values = []) {
  const encoded =
    types.length > 0
      ? AbiCoder.defaultAbiCoder().encode(types, values).slice(2)
      : "";
  const result = await vm.evm.runCall({
    block: BLOCK,
    caller: from,
    data: hexToBytes(`0x${bytecode}${encoded}`),
    gasLimit: 30_000_000n,
    skipBalance: true,
  });

  assert.equal(
    result.execResult.exceptionError,
    undefined,
    `create failed: ${result.execResult.exceptionError?.error ?? "unknown"}`,
  );
  assert.ok(result.createdAddress, "create returned no address");

  return result.createdAddress;
}

async function call(vm, from, to, iface, fn, args = []) {
  const data = iface.encodeFunctionData(fn, args);
  const result = await vm.evm.runCall({
    block: BLOCK,
    caller: from,
    to,
    data: hexToBytes(data),
    gasLimit: 10_000_000n,
    skipBalance: true,
  });

  return result;
}

async function read(vm, from, to, iface, fn, args = []) {
  const result = await call(vm, from, to, iface, fn, args);
  assert.equal(
    result.execResult.exceptionError,
    undefined,
    `read ${fn} reverted: ${result.execResult.exceptionError?.error ?? "unknown"}`,
  );
  return iface.decodeFunctionResult(fn, bytesToHex(result.execResult.returnValue));
}

function revert(result, iface) {
  assert.ok(result.execResult.exceptionError, "expected the call to revert");
  const parsed = iface.parseError(bytesToHex(result.execResult.returnValue));
  return parsed?.name ?? null;
}

function events(result, iface) {
  return (result.execResult.logs ?? []).map(([address, topics, data]) =>
    iface.parseLog({
      topics: topics.map((topic) => bytesToHex(topic)),
      data: bytesToHex(data),
    }),
  );
}

async function deployFixture() {
  const { vm, accounts } = await createNode();

  const implementation = await create(
    vm,
    accounts.deployer,
    artifacts.anchor.abi,
    artifacts.anchor.evm.bytecode.object,
  );
  const initialize = anchorInterface.encodeFunctionData("initialize", [
    accounts.owner.toString(),
  ]);
  const proxy = await create(
    vm,
    accounts.deployer,
    artifacts.proxy.abi,
    artifacts.proxy.evm.bytecode.object,
    ["address", "bytes"],
    [implementation.toString(), initialize],
  );

  return { vm, accounts, implementation, proxy };
}

describe("RarextAnchor", () => {
  it("deploys behind an upgradeable proxy and starts unpaused", async () => {
    const { vm, accounts, proxy } = await deployFixture();

    const [owner] = await read(vm, accounts.other, proxy, anchorInterface, "owner");
    const [version] = await read(vm, accounts.other, proxy, anchorInterface, "version");
    const [paused] = await read(vm, accounts.other, proxy, anchorInterface, "paused");
    const [count] = await read(vm, accounts.other, proxy, anchorInterface, "anchorCount");

    assert.equal(owner.toLowerCase(), accounts.owner.toString().toLowerCase());
    assert.equal(version, "1.0.0");
    assert.equal(paused, false);
    assert.equal(count, 0n);
  });

  it("publishes a root and metadata, emits the event, and exposes the adapter read", async () => {
    const { vm, accounts, proxy } = await deployFixture();

    await call(vm, accounts.owner, proxy, anchorInterface, "setPublisher", [
      accounts.publisher.toString(),
      true,
    ]);

    const root = keccak256(toUtf8Bytes("anchor-root-1"));
    const metadata = toUtf8Bytes("rarext:bundle:v1:publication-count=3");
    const result = await call(
      vm,
      accounts.publisher,
      proxy,
      anchorInterface,
      "publish",
      [root, metadata],
    );

    assert.equal(result.execResult.exceptionError, undefined);
    const [published] = events(result, anchorInterface);
    assert.equal(published.name, "AnchorPublished");
    assert.equal(published.args.id, 1n);
    assert.equal(published.args.root, root);
    assert.equal(published.args.metadataHash, keccak256(metadata));
    assert.equal(published.args.publisher.toLowerCase(), accounts.publisher.toString().toLowerCase());
    assert.ok(published.args.timestamp > 0n);
    assert.equal(published.args.metadata, hexlify(metadata));

    const [count] = await read(vm, accounts.other, proxy, anchorInterface, "anchorCount");
    const [id] = await read(vm, accounts.other, proxy, anchorInterface, "idOf", [root]);
    const [anchored] = await read(vm, accounts.other, proxy, anchorInterface, "isAnchored", [root]);
    const [storedRoot, timestamp] = await read(
      vm,
      accounts.other,
      proxy,
      anchorInterface,
      "anchors",
      [1n],
    );
    const [record] = await read(
      vm,
      accounts.other,
      proxy,
      anchorInterface,
      "anchorAt",
      [1n],
    );
    const [storedMetadata] = await read(
      vm,
      accounts.other,
      proxy,
      anchorInterface,
      "metadataOf",
      [1n],
    );

    assert.equal(count, 1n);
    assert.equal(id, 1n);
    assert.equal(anchored, true);
    assert.equal(storedRoot, root);
    assert.equal(timestamp, published.args.timestamp);
    assert.equal(record.metadataHash, keccak256(metadata));
    assert.equal(record.publisher.toLowerCase(), accounts.publisher.toString().toLowerCase());
    assert.equal(storedMetadata, hexlify(metadata));
  });

  it("rejects duplicate roots", async () => {
    const { vm, accounts, proxy } = await deployFixture();
    const root = keccak256(toUtf8Bytes("duplicate-root"));
    const metadata = toUtf8Bytes("first");

    await call(vm, accounts.owner, proxy, anchorInterface, "publish", [root, metadata]);
    const duplicate = await call(vm, accounts.owner, proxy, anchorInterface, "publish", [
      root,
      toUtf8Bytes("second"),
    ]);

    assert.equal(revert(duplicate, anchorInterface), "DuplicateRoot");
  });

  it("only the owner or an authorized publisher may publish", async () => {
    const { vm, accounts, proxy } = await deployFixture();
    const root = keccak256(toUtf8Bytes("unauthorized-root"));

    const unauthorized = await call(
      vm,
      accounts.other,
      proxy,
      anchorInterface,
      "publish",
      [root, toUtf8Bytes("nope")],
    );

    assert.equal(revert(unauthorized, anchorInterface), "NotPublisher");

    await call(vm, accounts.owner, proxy, anchorInterface, "publish", [
      root,
      toUtf8Bytes("owner-can-publish"),
    ]);
    const [count] = await read(vm, accounts.other, proxy, anchorInterface, "anchorCount");
    assert.equal(count, 1n);
  });

  it("bounds the metadata size", async () => {
    const { vm, accounts, proxy } = await deployFixture();
    const root = keccak256(toUtf8Bytes("too-large"));
    const metadata = new Uint8Array(513);

    const result = await call(vm, accounts.owner, proxy, anchorInterface, "publish", [
      root,
      metadata,
    ]);

    assert.equal(revert(result, anchorInterface), "MetadataTooLarge");
  });

  it("pauses and unpauses only through the owner", async () => {
    const { vm, accounts, proxy } = await deployFixture();
    const root = keccak256(toUtf8Bytes("paused-root"));

    const unauthorized = await call(
      vm,
      accounts.publisher,
      proxy,
      anchorInterface,
      "pause",
    );
    assert.equal(revert(unauthorized, anchorInterface), "OwnableUnauthorizedAccount");

    await call(vm, accounts.owner, proxy, anchorInterface, "pause");
    const [paused] = await read(vm, accounts.other, proxy, anchorInterface, "paused");
    assert.equal(paused, true);

    const blocked = await call(vm, accounts.owner, proxy, anchorInterface, "publish", [
      root,
      toUtf8Bytes("blocked"),
    ]);
    assert.equal(revert(blocked, anchorInterface), "EnforcedPause");

    await call(vm, accounts.owner, proxy, anchorInterface, "unpause");
    const allowed = await call(vm, accounts.owner, proxy, anchorInterface, "publish", [
      root,
      toUtf8Bytes("allowed"),
    ]);
    assert.equal(allowed.execResult.exceptionError, undefined);
  });

  it("moves ownership in two steps and disables renounce", async () => {
    const { vm, accounts, proxy } = await deployFixture();

    await call(vm, accounts.owner, proxy, anchorInterface, "transferOwnership", [
      accounts.newOwner.toString(),
    ]);

    const [stillOwner] = await read(vm, accounts.other, proxy, anchorInterface, "owner");
    const [pending] = await read(vm, accounts.other, proxy, anchorInterface, "pendingOwner");
    assert.equal(stillOwner.toLowerCase(), accounts.owner.toString().toLowerCase());
    assert.equal(pending.toLowerCase(), accounts.newOwner.toString().toLowerCase());

    const wrongAccept = await call(
      vm,
      accounts.other,
      proxy,
      anchorInterface,
      "acceptOwnership",
    );
    assert.equal(revert(wrongAccept, anchorInterface), "OwnableUnauthorizedAccount");

    await call(vm, accounts.newOwner, proxy, anchorInterface, "acceptOwnership");
    const [newOwner] = await read(vm, accounts.other, proxy, anchorInterface, "owner");
    assert.equal(newOwner.toLowerCase(), accounts.newOwner.toString().toLowerCase());

    const oldOwner = await call(
      vm,
      accounts.owner,
      proxy,
      anchorInterface,
      "setPublisher",
      [accounts.publisher.toString(), true],
    );
    assert.equal(revert(oldOwner, anchorInterface), "OwnableUnauthorizedAccount");

    const renounce = await call(
      vm,
      accounts.newOwner,
      proxy,
      anchorInterface,
      "renounceOwnership",
    );
    assert.equal(revert(renounce, anchorInterface), "RenounceDisabled");
  });

  it("upgrades only through the owner and preserves anchors", async () => {
    const { vm, accounts, proxy } = await deployFixture();
    const root = keccak256(toUtf8Bytes("upgrade-root"));
    const metadata = toUtf8Bytes("upgrade-metadata");

    await call(vm, accounts.owner, proxy, anchorInterface, "publish", [root, metadata]);

    const v2 = await create(
      vm,
      accounts.deployer,
      artifacts.v2.abi,
      artifacts.v2.evm.bytecode.object,
    );

    const unauthorized = await call(
      vm,
      accounts.other,
      proxy,
      anchorInterface,
      "upgradeToAndCall",
      [v2.toString(), "0x"],
    );
    assert.equal(revert(unauthorized, anchorInterface), "OwnableUnauthorizedAccount");

    const upgraded = await call(
      vm,
      accounts.owner,
      proxy,
      anchorInterface,
      "upgradeToAndCall",
      [v2.toString(), "0x"],
    );
    assert.equal(upgraded.execResult.exceptionError, undefined);

    const [version] = await read(vm, accounts.other, proxy, anchorInterface, "version");
    const [feature] = await read(vm, accounts.other, proxy, v2Interface, "feature");
    const [count] = await read(vm, accounts.other, proxy, anchorInterface, "anchorCount");
    const [storedMetadata] = await read(
      vm,
      accounts.other,
      proxy,
      anchorInterface,
      "metadataOf",
      [1n],
    );
    const [storedRoot] = await read(vm, accounts.other, proxy, anchorInterface, "anchors", [
      1n,
    ]);

    assert.equal(version, "2.0.0");
    assert.equal(feature, 42n);
    assert.equal(count, 1n);
    assert.equal(storedMetadata, hexlify(metadata));
    assert.equal(storedRoot, root);
  });

  it("keeps the documented anchor(bytes32,bytes32[]) entry point", async () => {
    const { vm, accounts, proxy } = await deployFixture();
    const root = keccak256(toUtf8Bytes("compat-root"));
    const ids = [keccak256(toUtf8Bytes("publication-1")), keccak256(toUtf8Bytes("publication-2"))];

    const result = await call(vm, accounts.owner, proxy, anchorInterface, "anchor", [
      root,
      ids,
    ]);

    assert.equal(result.execResult.exceptionError, undefined);
    const [published] = events(result, anchorInterface);
    assert.equal(published.args.id, 1n);
    assert.equal(published.args.root, root);
    assert.equal(
      published.args.metadataHash,
      keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32[]"], [ids])),
    );

    const [storedMetadata] = await read(
      vm,
      accounts.other,
      proxy,
      anchorInterface,
      "metadataOf",
      [1n],
    );
    assert.equal(
      storedMetadata,
      hexlify(AbiCoder.defaultAbiCoder().encode(["bytes32[]"], [ids])),
    );
  });

  it("cannot initialize or upgrade the implementation directly", async () => {
    const { vm, accounts, implementation } = await deployFixture();

    const initialize = await call(
      vm,
      accounts.other,
      implementation,
      anchorInterface,
      "initialize",
      [accounts.other.toString()],
    );
    assert.equal(revert(initialize, anchorInterface), "InvalidInitialization");

    const upgrade = await call(
      vm,
      accounts.owner,
      implementation,
      anchorInterface,
      "upgradeToAndCall",
      [implementation.toString(), "0x"],
    );
    assert.equal(revert(upgrade, anchorInterface), "UUPSUnauthorizedCallContext");
  });
});

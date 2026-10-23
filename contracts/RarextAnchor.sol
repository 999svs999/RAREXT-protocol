// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/**
 * Append-only anchor commitments for RAREXT.
 *
 * The contract stores a root, a bounded metadata blob and its hash, the
 * publisher, and the block timestamp. It emits the full metadata so an indexer
 * can rebuild the record from logs, and it exposes `anchors(uint256)` for the
 * registry's existing EVM read-back path.
 *
 * The contract is deployed behind an ERC-1967 proxy. The owner is a two-step
 * owner (OZ `Ownable2Step`) and is the only account that can upgrade the
 * implementation, pause the write path, or authorize publishers. Renouncing
 * ownership is disabled so the upgrade authority cannot be burned by accident.
 */
contract RarextAnchor is
    Initializable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable,
    PausableUpgradeable
{
    /// @notice Maximum size of the metadata blob. Larger blobs belong off-chain.
    uint256 public constant MAX_METADATA_BYTES = 512;

    struct Anchor {
        bytes32 root;
        bytes32 metadataHash;
        address publisher;
        uint64 timestamp;
    }

    uint256 private _anchorCount;
    mapping(bytes32 => uint256) private _idByRoot;
    mapping(uint256 => Anchor) private _anchors;
    mapping(uint256 => bytes) private _metadata;
    mapping(address => bool) private _publishers;

    /// @dev Reserved storage for future versions. Do not reorder the slots above.
    uint256[40] private __gap;

    event AnchorPublished(
        uint256 indexed id,
        bytes32 indexed root,
        bytes32 metadataHash,
        address indexed publisher,
        uint64 timestamp,
        bytes metadata
    );
    event PublisherSet(address indexed publisher, bool allowed);

    error ZeroAddress();
    error ZeroRoot();
    error DuplicateRoot(bytes32 root);
    error MetadataTooLarge(uint256 size);
    error NotPublisher(address account);
    error RenounceDisabled();

    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner) external initializer {
        __Ownable2Step_init();
        __Pausable_init();
        _transferOwnership(initialOwner);
    }

    function version() public pure virtual returns (string memory) {
        return "1.0.0";
    }

    /**
     * Publish a root with an arbitrary bounded metadata blob.
     *
     * The owner and any authorized publisher may write. Roots are unique; the
     * same root cannot be published twice, so a receipt always resolves to one
     * record.
     */
    function publish(
        bytes32 root,
        bytes calldata metadata
    ) external whenNotPaused returns (uint256 id) {
        return _publish(root, metadata);
    }

    /**
     * Compatibility entry point for the registry's documented EVM relay shape.
     * `publicationIds` are ABI-encoded as the metadata blob.
     */
    function anchor(
        bytes32 root,
        bytes32[] calldata publicationIds
    ) external whenNotPaused returns (uint256 id) {
        return _publish(root, abi.encode(publicationIds));
    }

    function setPublisher(address publisher, bool allowed) external onlyOwner {
        if (publisher == address(0)) revert ZeroAddress();
        _publishers[publisher] = allowed;
        emit PublisherSet(publisher, allowed);
    }

    function anchorCount() external view returns (uint256) {
        return _anchorCount;
    }

    /// @notice Read shape expected by `apps/api/src/chains/relay.ts`.
    function anchors(
        uint256 id
    ) external view returns (bytes32 root, uint64 timestamp) {
        Anchor storage record = _anchors[id];
        return (record.root, record.timestamp);
    }

    function anchorAt(uint256 id) external view returns (Anchor memory) {
        return _anchors[id];
    }

    function metadataOf(uint256 id) external view returns (bytes memory) {
        return _metadata[id];
    }

    function idOf(bytes32 root) external view returns (uint256) {
        return _idByRoot[root];
    }

    function isAnchored(bytes32 root) external view returns (bool) {
        return _idByRoot[root] != 0;
    }

    function isPublisher(address publisher) external view returns (bool) {
        return _publishers[publisher];
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function renounceOwnership() public override onlyOwner {
        revert RenounceDisabled();
    }

    function _publish(
        bytes32 root,
        bytes memory metadata
    ) private returns (uint256 id) {
        if (root == bytes32(0)) revert ZeroRoot();
        if (_idByRoot[root] != 0) revert DuplicateRoot(root);
        if (metadata.length > MAX_METADATA_BYTES) {
            revert MetadataTooLarge(metadata.length);
        }
        if (msg.sender != owner() && !_publishers[msg.sender]) {
            revert NotPublisher(msg.sender);
        }

        id = ++_anchorCount;
        uint64 timestamp = uint64(block.timestamp);
        bytes32 metadataHash = keccak256(metadata);

        _idByRoot[root] = id;
        _anchors[id] = Anchor({
            root: root,
            metadataHash: metadataHash,
            publisher: msg.sender,
            timestamp: timestamp
        });
        _metadata[id] = metadata;

        emit AnchorPublished(
            id,
            root,
            metadataHash,
            msg.sender,
            timestamp,
            metadata
        );
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}

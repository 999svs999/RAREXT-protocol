// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {RarextAnchor} from "contracts/RarextAnchor.sol";

/// @dev Test fixture: a compatible implementation with a bumped version.
contract RarextAnchorV2 is RarextAnchor {
    function version() public pure override returns (string memory) {
        return "2.0.0";
    }

    function feature() external pure returns (uint256) {
        return 42;
    }
}

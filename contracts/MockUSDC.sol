// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @notice Mock USDC pour testing sur Amoy
 */
contract MockUSDC is ERC20 {
    
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6; // USDC a 6 decimals
    }

    /**
     * @notice Mint gratuit pour testing
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /**
     * @notice Faucet : mint 10,000 USDC
     */
    function faucet() external {
        _mint(msg.sender, 10_000 * 10**6); // 10,000 USDC
    }
}

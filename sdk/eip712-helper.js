/**
 * EIP-712 Signature Helper for BundleFactory V5
 * 
 * Usage: user signs off-chain, relayer (Gelato/bot) submits on-chain
 * Compatible with: ethers.js v6, Safe SDK, MetaMask, WalletConnect
 */

const { ethers } = require("ethers");

// ========================
// EIP-712 DOMAIN & TYPES
// ========================

const EIP712_DOMAIN = {
    name: "PolyComboFactory",
    version: "5",
    // Set these at runtime
    chainId: null,
    verifyingContract: null,
};

const CREATE_BUNDLE_TYPES = {
    CreateBundle: [
        { name: "user", type: "address" },
        { name: "userCapital", type: "uint256" },
        { name: "marketsHash", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
    ],
};

// ========================
// SIGN BUNDLE CREATION
// ========================

/**
 * User signs the bundle parameters off-chain
 * 
 * @param {ethers.Signer} signer - User's wallet (MetaMask, Safe, etc.)
 * @param {string} factoryAddress - BundleFactory contract address
 * @param {number} chainId - Chain ID (137 for Polygon)
 * @param {Object} bundleParams - Bundle parameters
 * @returns {Object} { signature, deadline, nonce }
 */
async function signBundleCreation(signer, factoryAddress, chainId, bundleParams) {
    const {
        userCapital,
        marketIds,
        tokenIds,
        outcomes,
        oddsPpm,
        minOddsPpm,
        endTimes,
    } = bundleParams;

    // Get current nonce from contract
    const factory = new ethers.Contract(factoryAddress, [
        "function getNonce(address) view returns (uint256)",
    ], signer);
    
    const nonce = await factory.getNonce(await signer.getAddress());
    
    // Deadline: 10 minutes from now
    const deadline = Math.floor(Date.now() / 1000) + 600;

    // Hash markets params (must match contract encoding)
    const marketsHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            [
                "uint256[]", "uint256[]", "uint8[]",
                "uint256[]", "uint256[]", "uint64[]"
            ],
            [marketIds, tokenIds, outcomes, oddsPpm, minOddsPpm, endTimes]
        )
    );

    // Build domain
    const domain = {
        ...EIP712_DOMAIN,
        chainId,
        verifyingContract: factoryAddress,
    };

    // Build message
    const message = {
        user: await signer.getAddress(),
        userCapital,
        marketsHash,
        nonce,
        deadline,
    };

    // Sign (works with MetaMask, Safe, WalletConnect)
    const signature = await signer.signTypedData(domain, CREATE_BUNDLE_TYPES, message);

    return { signature, deadline: deadline.toString(), nonce: nonce.toString() };
}

// ========================
// RELAYER / GELATO SIDE
// ========================

/**
 * Relayer submits the signed bundle creation on-chain
 */
async function submitBundleCreation(relayerSigner, factoryAddress, userAddress, bundleParams, signature, deadline) {
    const factory = new ethers.Contract(factoryAddress, [
        `function createBundle(
            address user,
            uint256 userCapital,
            uint256[] memory marketIds,
            uint256[] memory tokenIds,
            uint8[] memory outcomes,
            uint256[] memory oddsPpm,
            uint256[] memory minOddsPpm,
            uint64[] memory endTimes,
            uint256 deadline,
            bytes memory signature
        ) external returns (address)`,
    ], relayerSigner);

    const tx = await factory.createBundle(
        userAddress,
        bundleParams.userCapital,
        bundleParams.marketIds,
        bundleParams.tokenIds,
        bundleParams.outcomes,
        bundleParams.oddsPpm,
        bundleParams.minOddsPpm,
        bundleParams.endTimes,
        deadline,
        signature
    );

    const receipt = await tx.wait();
    
    // Extract bundle address from event
    const event = receipt.logs.find(
        log => log.fragment?.name === "BundleCreated"
    );
    
    return {
        bundleAddress: event?.args?.[0],
        txHash: receipt.hash,
    };
}

// ========================
// SAFE WALLET NOTE
// ========================

/**
 * Safe wallets use EIP-1271 for signature verification.
 * 
 * OpenZeppelin's ECDSA.recover() handles EOA signatures.
 * For Safe compatibility, replace ECDSA.recover with
 * SignatureChecker.isValidSignatureNow() from OZ:
 * 
 *   import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
 * 
 *   // In createBundle:
 *   require(
 *       SignatureChecker.isValidSignatureNow(user, digest, signature),
 *       "invalid signature"
 *   );
 * 
 * This automatically handles both EOA (ecrecover) and
 * smart contract wallets (EIP-1271 isValidSignature).
 * 
 * IMPORTANT: If using a Safe, this is REQUIRED.
 */

module.exports = { signBundleCreation, submitBundleCreation };

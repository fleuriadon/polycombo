// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BundleFactory V6 - EIP-712 + Protocol Fee
 * @notice Features:
 *   - createBundle requires EIP-712 signature from user
 *   - Nonce replay protection
 *   - Deadline enforced on signature
 *   - Immutable protocol fee (0.5%) to protocol treasury
 *   - All previous features preserved (3-15 markets, adjustable max odds, Gelato relay)
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

interface IBundle {
    function transferFundsToBot(address botWallet) external;
    function resolveMarket(uint256 marketIndex, bool won, uint256 actualGains) external;
    function user() external view returns (address);
}

interface IVault {
    function registerBundle(address bundleAddress) external;
}

contract BundleFactory is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ========================
    // EIP-712 TYPE HASH
    // ========================
    bytes32 public constant CREATE_BUNDLE_TYPEHASH = keccak256(
        "CreateBundle(address user,uint256 userCapital,bytes32 marketsHash,uint256 nonce,uint256 deadline)"
    );

    IERC20 public immutable usdc;
    address public vaultAddress;
    address public feeCollectorAddress;
    address public botWallet;
    address public owner;

    // ========================
    // PROTOCOL FEE (immutable — cannot be changed or removed)
    // ========================
    address public immutable protocolTreasury;
    uint256 public constant PROTOCOL_FEE_PPM = 5000; // 0.5% — IMMUTABLE
    
    bytes public bundleBytecode;
    bool public bytecodeSet;

    // Deployer-configurable fees (capped)
    uint256 public entryFeePpm = 20000;              // 2% default, max 5%
    uint256 public exitFeePpm = 20000;               // 2% default, max 5%
    uint256 public constant MAX_DEPLOYER_FEE = 50000; // 5% hard cap
    
    uint256 public constant MAX_ODDS_PPM = 10_000_000; // 10x per market
    uint256 public constant MIN_ODDS_PPM = 1_100_000; // 1.1x minimum
    
    uint256 public maxCombinedOddsPpm = 100_000_000; // 100x default
    
    uint256 public constant MIN_MARKETS = 3;
    uint256 public constant MAX_MARKETS = 15;

    address[] public allBundles;
    mapping(address => bool) public isBundle;
    mapping(address => address[]) public userBundles;
    bool public paused;

    // ========================
    // REPLAY PROTECTION
    // ========================
    mapping(address => uint256) public nonces;

    event BundleCreated(address indexed bundle, address indexed user, uint256 userCapital, uint256 combinedOdds);
    event ProtocolFeePaid(address indexed bundle, uint256 fee);
    event FundsTransferredToBot(address indexed bundle);
    event MarketResolved(address indexed bundle, uint256 marketIndex, bool won, uint256 actualGains);
    event BotWalletUpdated(address indexed newBot);
    event VaultAddressUpdated(address indexed newVault);
    event FeeCollectorUpdated(address indexed newCollector);
    event BundleBytecodeSet(bytes32 indexed bytecodeHash);
    event MaxCombinedOddsUpdated(uint256 newMaxOdds);
    event EntryFeeUpdated(uint256 newFeePpm);
    event ExitFeeUpdated(uint256 newFeePpm);
    event Paused();
    event Unpaused();

    modifier whenNotPaused() {
        require(!paused, "factory paused");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    modifier onlyBot() {
        require(msg.sender == botWallet, "only bot");
        _;
    }

    constructor(
        address _usdc,
        address _vaultAddress,
        address _feeCollector,
        address _botWallet,
        address _protocolTreasury
    ) EIP712("PolyComboFactory", "6") {
        require(_protocolTreasury != address(0), "invalid protocol treasury");
        usdc = IERC20(_usdc);
        vaultAddress = _vaultAddress;
        feeCollectorAddress = _feeCollector;
        botWallet = _botWallet;
        protocolTreasury = _protocolTreasury;
        owner = msg.sender;
    }

    /**
     * @notice Set bytecode ONE TIME only
     */
    function setBundleBytecode(bytes memory _bytecode) external onlyOwner {
        require(!bytecodeSet, "bytecode already set");
        require(_bytecode.length > 0, "empty bytecode");
        
        bytes32 hash = keccak256(_bytecode);
        bundleBytecode = _bytecode;
        bytecodeSet = true;
        
        emit BundleBytecodeSet(hash);
    }

    /**
     * @notice Get bytecode hash for verification
     */
    function getCurrentBytecodeHash() external view returns (bytes32) {
        require(bundleBytecode.length > 0, "bytecode not set");
        return keccak256(bundleBytecode);
    }

    /**
     * @notice Set max combined odds (governance)
     */
    function setMaxCombinedOdds(uint256 _maxOddsPpm) external onlyOwner {
        require(_maxOddsPpm >= 10_000_000, "max odds too low");
        require(_maxOddsPpm <= 1_000_000_000, "max odds too high");
        
        maxCombinedOddsPpm = _maxOddsPpm;
        
        emit MaxCombinedOddsUpdated(_maxOddsPpm);
    }

    /**
     * @notice V5: Create bundle with EIP-712 signature from user
     * @dev Gelato/relayer calls this, but user MUST have signed the params
     * @param user The user who signed the bundle creation
     * @param signature EIP-712 signature from the user
     */
    function createBundle(
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
    ) external nonReentrant whenNotPaused returns (address) {
        require(bundleBytecode.length > 0, "bytecode not set");
        require(user != address(0), "invalid user");
        require(block.timestamp <= deadline, "deadline expired");

        // ========================
        // EIP-712 SIGNATURE CHECK
        // ========================
        uint256 currentNonce = nonces[user];

        bytes32 marketsHash = keccak256(
            abi.encode(marketIds, tokenIds, outcomes, oddsPpm, minOddsPpm, endTimes)
        );

        bytes32 structHash = keccak256(
            abi.encode(
                CREATE_BUNDLE_TYPEHASH,
                user,
                userCapital,
                marketsHash,
                currentNonce,
                deadline
            )
        );

        bytes32 digest = _hashTypedDataV4(structHash);
        require(
            SignatureChecker.isValidSignatureNow(user, digest, signature),
            "invalid signature"
        );

        // Increment nonce (replay protection)
        nonces[user] = currentNonce + 1;

        // ========================
        // EXISTING VALIDATION (unchanged)
        // ========================
        require(marketIds.length >= MIN_MARKETS, "too few markets");
        require(marketIds.length <= MAX_MARKETS, "too many markets");
        require(marketIds.length == tokenIds.length, "tokenIds length mismatch");
        require(marketIds.length == outcomes.length, "length mismatch");
        require(marketIds.length == oddsPpm.length, "length mismatch");
        require(marketIds.length == minOddsPpm.length, "minOdds length mismatch");
        require(marketIds.length == endTimes.length, "length mismatch");
        require(userCapital > 0, "capital must be > 0");
        
        // Check for duplicate markets
        for (uint256 i = 0; i < marketIds.length; i++) {
            for (uint256 j = i + 1; j < marketIds.length; j++) {
                require(marketIds[i] != marketIds[j], "duplicate markets");
            }
        }
        
        // Validate odds and calculate combined
        uint256 combinedOdds = 1_000_000;
        for (uint256 i = 0; i < oddsPpm.length; i++) {
            require(oddsPpm[i] <= MAX_ODDS_PPM, "odds too high");
            require(oddsPpm[i] >= MIN_ODDS_PPM, "odds too low");
            require(oddsPpm[i] >= minOddsPpm[i], "slippage too high");
            require(endTimes[i] > block.timestamp, "market already ended");
            combinedOdds = (combinedOdds * oddsPpm[i]) / 1_000_000;
        }
        
        require(combinedOdds <= maxCombinedOddsPpm, "combined odds exceed maximum");

        // Fee split: protocol fee (immutable) + deployer entry fee (configurable)
        uint256 protocolFee = (userCapital * PROTOCOL_FEE_PPM) / 1_000_000;
        uint256 entryFee = (userCapital * entryFeePpm) / 1_000_000;
        uint256 capitalForTrading = userCapital - entryFee - protocolFee;
        uint256 totalFromUser = userCapital;
        
        // Pull USDC from user (now secured by signature)
        usdc.safeTransferFrom(user, address(this), totalFromUser);
        usdc.safeTransfer(protocolTreasury, protocolFee);
        usdc.safeTransfer(feeCollectorAddress, entryFee);

        // Deploy bundle with CREATE2 (pass exitFeePpm so deployer controls exit fee)
        bytes memory constructorArgs = abi.encode(
            address(this), user, capitalForTrading, exitFeePpm,
            marketIds, tokenIds, outcomes, oddsPpm, endTimes
        );
        
        bytes memory bytecodeWithArgs = abi.encodePacked(bundleBytecode, constructorArgs);
        bytes32 salt = keccak256(abi.encodePacked(user, block.timestamp, allBundles.length));
        address bundleAddress;
        
        assembly {
            bundleAddress := create2(0, add(bytecodeWithArgs, 32), mload(bytecodeWithArgs), salt)
        }
        require(bundleAddress != address(0), "bundle creation failed");

        allBundles.push(bundleAddress);
        isBundle[bundleAddress] = true;
        userBundles[user].push(bundleAddress);

        IVault(vaultAddress).registerBundle(bundleAddress);
        usdc.safeTransfer(bundleAddress, capitalForTrading);

        emit BundleCreated(bundleAddress, user, capitalForTrading, combinedOdds);
        emit ProtocolFeePaid(bundleAddress, protocolFee);
        return bundleAddress;
    }

    /**
     * @notice Bot transfers funds from bundle to bot wallet
     */
    function transferFundsToBot(address bundleAddress) external nonReentrant onlyBot {
        require(isBundle[bundleAddress], "not a bundle");
        IBundle(bundleAddress).transferFundsToBot(botWallet);
        emit FundsTransferredToBot(bundleAddress);
    }

    /**
     * @notice Bot resolves a market
     */
    function resolveMarket(
        address bundleAddress,
        uint256 marketIndex,
        bool won,
        uint256 actualGains
    ) external nonReentrant onlyBot {
        require(isBundle[bundleAddress], "not a bundle");
        
        IBundle(bundleAddress).resolveMarket(marketIndex, won, actualGains);
        
        emit MarketResolved(bundleAddress, marketIndex, won, actualGains);
    }

    // ---- Admin Functions ----
    
    function setBotWallet(address _botWallet) external onlyOwner {
        require(_botWallet != address(0), "invalid bot");
        botWallet = _botWallet;
        emit BotWalletUpdated(_botWallet);
    }

    function setVaultAddress(address _vault) external onlyOwner {
        vaultAddress = _vault;
        emit VaultAddressUpdated(_vault);
    }

    function setFeeCollectorAddress(address _collector) external onlyOwner {
        feeCollectorAddress = _collector;
        emit FeeCollectorUpdated(_collector);
    }

    /**
     * @notice Deployer sets their entry fee (0–5%)
     */
    function setEntryFee(uint256 _feePpm) external onlyOwner {
        require(_feePpm <= MAX_DEPLOYER_FEE, "fee exceeds 5% cap");
        entryFeePpm = _feePpm;
        emit EntryFeeUpdated(_feePpm);
    }

    /**
     * @notice Deployer sets their exit fee (0–5%, applied on profit only)
     */
    function setExitFee(uint256 _feePpm) external onlyOwner {
        require(_feePpm <= MAX_DEPLOYER_FEE, "fee exceeds 5% cap");
        exitFeePpm = _feePpm;
        emit ExitFeeUpdated(_feePpm);
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused();
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused();
    }

    // ---- Views ----

    /**
     * @notice Get current nonce for a user (needed to build signature off-chain)
     */
    function getNonce(address user) external view returns (uint256) {
        return nonces[user];
    }

    /**
     * @notice Get EIP-712 domain separator (for off-chain signature building)
     */
    function getDomainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
    
    function getAllBundles() external view returns (address[] memory) {
        return allBundles;
    }

    function getUserBundles(address user) external view returns (address[] memory) {
        return userBundles[user];
    }

    function getBundlesCount() external view returns (uint256) {
        return allBundles.length;
    }
}

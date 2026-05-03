// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title LiquidityVault V4 - Access Control Fix
 * @notice SECURITY PATCH:
 *   - notifyResidual restricted to valid bundles only
 *   - All previous features preserved (early withdrawal fee, shares, fees)
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract LiquidityVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public immutable treasury;
    address public bundleFactory;

    uint256 public totalLiquidity;
    uint256 public availableLiquidity;
    uint256 public totalBonusPaid;
    uint256 public totalResidualsReceived;
    uint256 public totalProfitsRealized;

    mapping(address => bool) public validBundles;
    bool public paused;
    bool public factorySet;

    mapping(address => uint256) public shares;
    uint256 public totalShares;
    uint256 public constant MINIMUM_SHARES = 1000;

    uint256 public mgmtFeePerMonthPpm;
    uint256 public perfFeePpm;
    uint256 public lastFeeTimestamp;
    uint256 public totalFeesPaid;

    mapping(address => uint256) public lastDepositTime;
    uint256 public earlyWithdrawFeePpm;
    uint256 public earlyWithdrawPeriod;
    uint256 public totalEarlyWithdrawFees;

    event Deposit(address indexed user, uint256 amount, uint256 sharesIssued);
    event Withdraw(address indexed user, uint256 amount, uint256 sharesBurned, uint256 earlyFee);
    event BundleRegistered(address indexed bundle);
    event BonusPaid(address indexed bundle, uint256 amount);
    event ResidualReceived(address indexed bundle, uint256 amount);
    event FeesCollected(uint256 mgmtFee, uint256 perfFee);
    event EarlyWithdrawFeeUpdated(uint256 newFeePpm, uint256 newPeriod);
    event FactorySet(address indexed factory);
    event Paused();
    event Unpaused();

    modifier whenNotPaused() {
        require(!paused, "vault paused");
        _;
    }

    modifier onlyValidBundle() {
        require(validBundles[msg.sender], "not a valid bundle");
        _;
    }

    constructor(
        address _usdc,
        address _treasury,
        uint256 _mgmtFeePerMonthPpm,
        uint256 _perfFeePpm
    ) {
        usdc = IERC20(_usdc);
        treasury = _treasury;
        mgmtFeePerMonthPpm = _mgmtFeePerMonthPpm;
        perfFeePpm = _perfFeePpm;
        lastFeeTimestamp = block.timestamp;
        
        earlyWithdrawFeePpm = 25000;
        earlyWithdrawPeriod = 30 days;
    }

    function setFactory(address _factory) external {
        require(msg.sender == treasury, "only treasury");
        require(_factory != address(0), "invalid factory");
        require(!factorySet, "factory already set");
        
        bundleFactory = _factory;
        factorySet = true;
        
        emit FactorySet(_factory);
    }

    function registerBundle(address bundleAddress) external {
        require(msg.sender == bundleFactory, "only factory");
        require(!validBundles[bundleAddress], "already registered");
        
        validBundles[bundleAddress] = true;
        
        emit BundleRegistered(bundleAddress);
    }

    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "amount must be > 0");

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        uint256 sharesToIssue;
        if (totalShares == 0) {
            sharesToIssue = amount;
            require(sharesToIssue >= MINIMUM_SHARES, "first deposit too small");
            
            shares[msg.sender] += sharesToIssue - MINIMUM_SHARES;
            shares[address(0)] += MINIMUM_SHARES;
            totalShares += sharesToIssue;
        } else {
            sharesToIssue = (amount * totalShares) / totalLiquidity;
            shares[msg.sender] += sharesToIssue;
            totalShares += sharesToIssue;
        }

        totalLiquidity += amount;
        availableLiquidity += amount;

        lastDepositTime[msg.sender] = block.timestamp;

        emit Deposit(msg.sender, amount, sharesToIssue);
    }

    function withdraw(uint256 sharesToBurn) external nonReentrant {
        require(sharesToBurn > 0 && shares[msg.sender] >= sharesToBurn, "insufficient shares");

        uint256 amountToWithdraw = (sharesToBurn * totalLiquidity) / totalShares;
        require(amountToWithdraw <= availableLiquidity, "insufficient available liquidity");

        shares[msg.sender] -= sharesToBurn;
        totalShares -= sharesToBurn;
        totalLiquidity -= amountToWithdraw;
        availableLiquidity -= amountToWithdraw;

        uint256 earlyFee = 0;
        if (block.timestamp < lastDepositTime[msg.sender] + earlyWithdrawPeriod) {
            earlyFee = (amountToWithdraw * earlyWithdrawFeePpm) / 1_000_000;
            
            if (earlyFee > 0) {
                usdc.safeTransfer(treasury, earlyFee);
                totalEarlyWithdrawFees += earlyFee;
                amountToWithdraw -= earlyFee;
            }
        }

        usdc.safeTransfer(msg.sender, amountToWithdraw);

        emit Withdraw(msg.sender, amountToWithdraw, sharesToBurn, earlyFee);
    }

    function payBonus(address bundleAddress, uint256 bonusAmount) external nonReentrant onlyValidBundle {
        require(msg.sender == bundleAddress, "only bundle");
        require(bonusAmount <= availableLiquidity, "insufficient liquidity for bonus");

        availableLiquidity -= bonusAmount;
        totalBonusPaid += bonusAmount;

        usdc.safeTransfer(bundleAddress, bonusAmount);

        emit BonusPaid(bundleAddress, bonusAmount);
    }

    /**
     * @notice PATCHED: restricted to valid bundles only
     * @dev Previously open to anyone — allowed fake liquidity inflation
     */
    function notifyResidual(uint256 amount) external nonReentrant onlyValidBundle {
        require(amount > 0, "amount must be > 0");

        // Verify the bundle actually sent the tokens
        uint256 balance = usdc.balanceOf(address(this));
        require(balance >= totalLiquidity + amount, "tokens not received");

        availableLiquidity += amount;
        totalLiquidity += amount;
        totalResidualsReceived += amount;
        totalProfitsRealized += amount;

        emit ResidualReceived(msg.sender, amount);
    }

    function collectFees() external nonReentrant {
        uint256 timeElapsed = block.timestamp - lastFeeTimestamp;
        require(timeElapsed > 0, "no time elapsed");

        uint256 mgmtFee = (totalLiquidity * mgmtFeePerMonthPpm * timeElapsed) / (1_000_000 * 30 days);
        uint256 perfFee = (totalProfitsRealized * perfFeePpm) / 1_000_000;

        uint256 totalFee = mgmtFee + perfFee;
        if (totalFee > 0 && totalFee <= availableLiquidity) {
            availableLiquidity -= totalFee;
            totalLiquidity -= totalFee;
            totalFeesPaid += totalFee;
            totalProfitsRealized = 0;

            usdc.safeTransfer(treasury, totalFee);

            emit FeesCollected(mgmtFee, perfFee);
        }

        lastFeeTimestamp = block.timestamp;
    }

    function setEarlyWithdrawFee(uint256 _feePpm, uint256 _period) external {
        require(msg.sender == treasury, "only treasury");
        require(_feePpm <= 100_000, "fee too high");
        
        earlyWithdrawFeePpm = _feePpm;
        earlyWithdrawPeriod = _period;
        
        emit EarlyWithdrawFeeUpdated(_feePpm, _period);
    }

    function getVaultStats() external view returns (
        uint256 _totalLiquidity,
        uint256 _availableLiquidity,
        uint256 _totalBonusPaid,
        uint256 _totalResidualsReceived,
        uint256 _totalProfitsRealized,
        uint256 _totalEarlyWithdrawFees
    ) {
        return (
            totalLiquidity,
            availableLiquidity,
            totalBonusPaid,
            totalResidualsReceived,
            totalProfitsRealized,
            totalEarlyWithdrawFees
        );
    }

    function getUserShares(address user) external view returns (uint256 userShares, uint256 userValue) {
        userShares = shares[user];
        if (totalShares > 0) {
            userValue = (userShares * totalLiquidity) / totalShares;
        } else {
            userValue = 0;
        }
    }

    function getEarlyWithdrawFee(address user, uint256 sharesToBurn) external view returns (uint256 fee, bool isEarly) {
        if (block.timestamp < lastDepositTime[user] + earlyWithdrawPeriod) {
            uint256 amount = (sharesToBurn * totalLiquidity) / totalShares;
            fee = (amount * earlyWithdrawFeePpm) / 1_000_000;
            isEarly = true;
        } else {
            fee = 0;
            isEarly = false;
        }
    }

    function pause() external {
        require(msg.sender == treasury, "only treasury");
        paused = true;
        emit Paused();
    }

    function unpause() external {
        require(msg.sender == treasury, "only treasury");
        paused = false;
        emit Unpaused();
    }
}

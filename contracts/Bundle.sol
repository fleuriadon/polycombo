// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Bundle V6 - Configurable Exit Fee
 * @notice Settlement automatique par bot, distribution manuelle par user
 * @dev Exit fee passed from Factory at deploy — deployer-configurable, capped at 5%
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IFactory {
    function usdc() external view returns (address);
    function vaultAddress() external view returns (address);
    function feeCollectorAddress() external view returns (address);
}

interface IVault {
    function notifyResidual(uint256 amount) external;
    function payBonus(address bundleAddress, uint256 amount) external;
}

contract Bundle is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IFactory public immutable factory;
    IERC20 public immutable usdc;
    IVault public immutable vault;
    address public immutable feeCollector;

    address public user;
    uint256 public userCapital;

    uint256 public exitFeePpm; // Set by Factory at deploy (deployer-configurable)
    
    struct Fees {
        uint128 exitFeePaid;
    }
    Fees public fees;

    struct Market {
        uint256 marketId;
        uint256 tokenId;
        uint8 outcome;
        uint256 oddsPpm;
        uint64 endTime;
        uint256 actualGains;
        bool resolved;
        bool won;
    }

    Market[] public markets;
    uint256 public marketsWon;
    uint256 public marketsResolved;

    bool public isSettled;      // Bot a terminé settlement
    bool public isClaimed;      // User a claim ses gains
    bool public fundsTransferred;
    
    uint256 public userPayout;  // Montant calculé pour le user

    event FundsTransferredToBot(address indexed botWallet, uint256 amount);
    event MarketResolved(uint256 indexed marketIndex, bool won, uint256 actualGains);
    event ExitFeePaid(uint256 fee);
    event BonusPaid(uint256 bonusAmount);
    event BundleSettled(bool success, uint256 userPayout);
    event PayoutClaimed(address indexed user, uint256 amount);

    constructor(
        address _factory,
        address _user,
        uint256 _userCapital,
        uint256 _exitFeePpm,
        uint256[] memory _marketIds,
        uint256[] memory _tokenIds,
        uint8[] memory _outcomes,
        uint256[] memory _oddsPpm,
        uint64[] memory _endTimes
    ) {
        require(_marketIds.length >= 3, "min 3 markets");
        require(_marketIds.length <= 15, "max 15 markets");
        require(_marketIds.length == _tokenIds.length, "length mismatch");
        require(_marketIds.length == _outcomes.length, "length mismatch");
        require(_marketIds.length == _oddsPpm.length, "length mismatch");
        require(_marketIds.length == _endTimes.length, "length mismatch");
        require(_userCapital > 0, "capital must be > 0");
        require(_exitFeePpm <= 50000, "exit fee exceeds 5% cap");

        factory = IFactory(_factory);
        usdc = IERC20(factory.usdc());
        vault = IVault(factory.vaultAddress());
        feeCollector = factory.feeCollectorAddress();

        user = _user;
        userCapital = _userCapital;
        exitFeePpm = _exitFeePpm;

        for (uint256 i = 0; i < _marketIds.length; i++) {
            markets.push(Market({
                marketId: _marketIds[i],
                tokenId: _tokenIds[i],
                outcome: _outcomes[i],
                oddsPpm: _oddsPpm[i],
                endTime: _endTimes[i],
                actualGains: 0,
                resolved: false,
                won: false
            }));
        }
    }

    function transferFundsToBot(address botWallet) external nonReentrant {
        require(msg.sender == address(factory), "only factory");
        require(botWallet != address(0), "invalid bot wallet");
        require(!fundsTransferred, "already transferred");

        fundsTransferred = true;
        usdc.safeTransfer(botWallet, userCapital);

        emit FundsTransferredToBot(botWallet, userCapital);
    }

    function resolveMarket(uint256 marketIndex, bool won, uint256 actualGains) external nonReentrant {
        require(msg.sender == address(factory), "only factory");
        require(marketIndex < markets.length, "invalid index");
        
        Market storage market = markets[marketIndex];
        require(!market.resolved, "already resolved");
        require(block.timestamp >= market.endTime, "not ended yet");

        if (won) {
            uint256 amountPerMarket = userCapital / markets.length;
            uint256 maxPossibleGains = (amountPerMarket * market.oddsPpm) / 1_000_000;
            
            require(actualGains > 0, "gains must be > 0 if won");
            require(actualGains <= maxPossibleGains, "gains exceed max possible");
            require(actualGains >= amountPerMarket, "gains below capital");
        } else {
            require(actualGains == 0, "gains must be 0 if lost");
        }

        market.resolved = true;
        market.won = won;
        market.actualGains = actualGains;
        marketsResolved++;

        if (won) {
            marketsWon++;
        }

        emit MarketResolved(marketIndex, won, actualGains);

        // Auto-settle quand tous résolus
        if (marketsResolved == markets.length) {
            _settle();
        }
    }

    function _settle() internal {
        require(!isSettled, "already settled");
        isSettled = true;

        uint256 balance = usdc.balanceOf(address(this));

        if (marketsWon == markets.length) {
            _handleSuccess(balance);
        } else {
            _handleFailure(balance);
        }
    }

    function _handleSuccess(uint256 balance) internal {
        uint256 totalPolymarketGains = 0;
        for (uint256 i = 0; i < markets.length; i++) {
            totalPolymarketGains += markets[i].actualGains;
        }
        
        require(totalPolymarketGains > 0, "no gains");
        require(totalPolymarketGains >= userCapital, "total gains below capital");
        
        uint256 theoreticalGains = (userCapital * _getCombinedOdds()) / 1_000_000;
        require(totalPolymarketGains <= theoreticalGains, "gains exceed theoretical");
        
        // Vault paie le bonus
        uint256 bonusAmount = theoreticalGains - totalPolymarketGains;
        vault.payBonus(address(this), bonusAmount);
        emit BonusPaid(bonusAmount);

        // Recalculer balance après bonus
        balance = usdc.balanceOf(address(this));
        
        uint256 profitGross = balance - userCapital;
        
        // Collecter exit fee
        uint256 exitFee = (profitGross * exitFeePpm) / 1_000_000;
        if (exitFee > 0) {
            usdc.safeTransfer(feeCollector, exitFee);
            fees.exitFeePaid = uint128(exitFee);
            emit ExitFeePaid(exitFee);
        }

        // Calculer payout user (prêt à claim)
        uint256 profitNet = profitGross - exitFee;
        userPayout = userCapital + profitNet;

        emit BundleSettled(true, userPayout);
    }

    function _handleFailure(uint256 balance) internal {
        // Envoyer résiduel au vault
        if (balance > 0) {
            usdc.safeTransfer(address(vault), balance);
            vault.notifyResidual(balance);
        }

        userPayout = 0; // Pas de payout pour user

        emit BundleSettled(false, 0);
    }

    /**
     * @notice User claim son payout (Gelato compatible)
     * @param _user Address du user (pour Gelato relay)
     */
    function claimPayout(address _user) external nonReentrant {
        require(_user == user, "invalid user");
        require(isSettled, "not settled yet");
        require(!isClaimed, "already claimed");
        require(userPayout > 0, "no payout available");

        isClaimed = true;
        
        usdc.safeTransfer(user, userPayout);

        emit PayoutClaimed(user, userPayout);
    }

    function _getCombinedOdds() internal view returns (uint256) {
        uint256 combined = 1_000_000;
        
        for (uint256 i = 0; i < markets.length; i++) {
            combined = (combined * markets[i].oddsPpm) / 1_000_000;
        }
        
        return combined;
    }

    function getMarkets() external view returns (Market[] memory) {
        return markets;
    }

    function getBundleStatus() external view returns (
        uint256 _marketsWon,
        uint256 _marketsResolved,
        bool _isSettled,
        bool _isClaimed,
        uint256 _userPayout,
        uint256 _exitFeePaid
    ) {
        return (
            marketsWon, 
            marketsResolved, 
            isSettled, 
            isClaimed,
            userPayout,
            fees.exitFeePaid
        );
    }

    function getCombinedOdds() external view returns (uint256) {
        return _getCombinedOdds();
    }
}

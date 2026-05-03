/**
 * ConditionalTokensRedeemer - Handle redemption of resolved positions
 * Uses Gnosis Conditional Tokens Framework instead of selling on order book
 */
const { ethers } = require('ethers');

class ConditionalTokensRedeemer {
    constructor(wallet, chainId = 137) {
        this.wallet = wallet;
        this.chainId = chainId;
        
        // Conditional Tokens contract on Polygon
        this.CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
        
        // NegRisk Adapter for neg-risk markets (multi-outcome)
        this.NEG_RISK_ADAPTER_ADDRESS = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
        
        // Collateral token (USDCe on Polygon)
        this.COLLATERAL_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
        
        // ABIs
        this.ctfABI = [
            "function balanceOf(address account, uint256 id) external view returns (uint256)",
            "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external",
            "function getOutcomeSlotCount(bytes32 conditionId) external view returns (uint256)",
            "function payoutDenominator(bytes32 conditionId) external view returns (uint256)",
            "function payoutNumerators(bytes32 conditionId, uint256 index) external view returns (uint256)"
        ];

        // NegRiskAdapter: redeemPositions(bytes32 conditionId, uint256[] amounts)
        // amounts[i] = token amount to redeem for outcome slot i (0 for losing outcomes)
        this.negRiskAdapterABI = [
            "function redeemPositions(bytes32 conditionId, uint256[] amounts) external"
        ];
        
        this.ctf = new ethers.Contract(this.CTF_ADDRESS, this.ctfABI, wallet);
        this.negRiskAdapter = new ethers.Contract(this.NEG_RISK_ADAPTER_ADDRESS, this.negRiskAdapterABI, wallet);
        
        console.log('🔓 ConditionalTokensRedeemer initialized');
        console.log(`   CTF: ${this.CTF_ADDRESS}`);
        console.log(`   NegRiskAdapter: ${this.NEG_RISK_ADAPTER_ADDRESS}`);
        console.log(`   Collateral: ${this.COLLATERAL_ADDRESS}`);
    }

    /**
     * Derive conditionId from question/oracle (Polymarket's method)
     * conditionId = keccak256(abi.encodePacked(oracle, questionId, outcomeSlotCount))
     */
    deriveConditionId(oracle, questionId, outcomeSlotCount = 2) {
        // For binary markets, outcomeSlotCount is typically 2
        const encoded = ethers.solidityPacked(
            ['address', 'bytes32', 'uint256'],
            [oracle, questionId, outcomeSlotCount]
        );
        return ethers.keccak256(encoded);
    }

    /**
     * Get the market's condition ID from Polymarket API or market data
     * This needs to be fetched from Polymarket's metadata
     */
    async getConditionIdFromMarket(marketId) {
        try {
            // Polymarket API to get condition details
            const response = await fetch(`https://gamma-api.polymarket.com/markets/${marketId}`);
            if (!response.ok) {
                throw new Error(`Market ${marketId} not found`);
            }
            
            const data = await response.json();
            
            // Extract condition details
            const conditionId = data.conditionId || data.condition_id;
            const questionId = data.questionId || data.question_id;
            const oracle = data.oracle;
            
            if (!conditionId) {
                console.log(`   ⚠️  No conditionId in market data, deriving from oracle/questionId`);
                if (oracle && questionId) {
                    return {
                        conditionId: this.deriveConditionId(oracle, questionId),
                        negRisk: data.negRisk === true
                    };
                }
                throw new Error('Cannot derive conditionId - missing oracle or questionId');
            }
            
            return {
                conditionId,
                negRisk: data.negRisk === true
            };
        } catch (error) {
            console.error(`   ❌ Error fetching conditionId for market ${marketId}:`, error.message);
            return null;
        }
    }

    /**
     * Check if a condition is resolved and get payout info
     */
    async getConditionPayout(conditionId) {
        try {
            const outcomeSlotCount = await this.ctf.getOutcomeSlotCount(conditionId);
            const denominator = await this.ctf.payoutDenominator(conditionId);
            
            if (denominator === 0n) {
                return { resolved: false };
            }
            
            // Get payout for each outcome
            const payouts = [];
            for (let i = 0; i < Number(outcomeSlotCount); i++) {
                const numerator = await this.ctf.payoutNumerators(conditionId, i);
                payouts.push(numerator);
            }
            
            return {
                resolved: true,
                outcomeSlotCount: Number(outcomeSlotCount),
                denominator,
                payouts,
                winningOutcome: 1 - payouts.findIndex(p => p > 0n)
            };
        } catch (error) {
            console.error(`   ❌ Error checking condition payout:`, error.message);
            return { resolved: false };
        }
    }

    /**
     * Redeem a position after market resolution
     * @param conditionId - The condition ID from Polymarket
     * @param indexSets - Array of index sets to redeem (e.g., [1] for outcome 0, [2] for outcome 1)
     * @param nonceManager - Optional nonce manager for transaction ordering
     */
    async redeemPosition(conditionId, indexSets, nonceManager = null) {
        try {
            console.log(`   🔓 Redeeming position for condition: ${conditionId.slice(0, 20)}...`);
            console.log(`      Index sets: ${indexSets.join(', ')}`);
            
            // Check if condition is resolved
            const payoutInfo = await this.getConditionPayout(conditionId);
            if (!payoutInfo.resolved) {
                throw new Error('Condition not yet resolved');
            }
            
            console.log(`      ✅ Condition resolved - winning outcome: ${payoutInfo.winningOutcome}`);
            
            // Prepare transaction
            const tx = await this.ctf.redeemPositions(
                this.COLLATERAL_ADDRESS,
                ethers.ZeroHash, // parentCollectionId (usually zero for Polymarket)
                conditionId,
                indexSets,
                {
                    gasLimit: 300000,
                    nonce: nonceManager ? await nonceManager.getNext() : undefined
                }
            );
            
            console.log(`      📤 Redeem tx sent: ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`      ✅ Redeemed successfully!`);
            
            return {
                success: true,
                txHash: tx.hash,
                gasUsed: receipt.gasUsed
            };
            
        } catch (error) {
            console.error(`      ❌ Redeem failed:`, error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Redeem a neg-risk position via NegRiskAdapter
     * Signature: redeemPositions(bytes32 conditionId, uint256[] amounts)
     * amounts[outcome] = tokenAmount, all other slots = 0
     */
    async redeemNegRiskPosition(conditionId, winningOutcome, tokenAmountRaw, nonceManager = null) {
        try {
            console.log(`   🔓 Redeeming neg-risk via NegRiskAdapter...`);
            console.log(`      ConditionId: ${conditionId.slice(0, 20)}...`);
            console.log(`      Winning outcome: ${winningOutcome}`);
            console.log(`      Amount: ${ethers.formatUnits(tokenAmountRaw, 6)} USDCe`);

            // Build amounts array: only winning outcome slot gets the amount
            const amounts = [0n, 0n];
            amounts[1 - winningOutcome] = tokenAmountRaw;

            const tx = await this.negRiskAdapter.redeemPositions(
                conditionId,
                amounts,
                {
                    gasLimit: 300000,
                    nonce: nonceManager ? await nonceManager.getNext() : undefined
                }
            );

            console.log(`      📤 NegRisk redeem tx: ${tx.hash}`);
            await tx.wait();
            console.log(`      ✅ NegRisk redeemed!`);
            return { success: true, txHash: tx.hash };
        } catch (error) {
            console.error(`      ❌ NegRisk redeem failed:`, error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Calculate index set from outcome
     * For binary markets: outcome 0 → indexSet 1, outcome 1 → indexSet 2
     */
    outcomeToIndexSet(outcome, outcomeSlotCount = 2) {
        // Index sets are powers of 2: 2^outcome
        return 1 << (1 - outcome);
    }

    /**
     * Redeem all positions for a bundle
     * @param positions - Array of { tokenId, marketId, outcome, amount }
     * @param nonceManager - Nonce manager for sequential txs
     */
    async redeemBundlePositions(positions, nonceManager = null) {
        console.log(`\n🔓 Redeeming ${positions.length} positions...`);
        
        const results = [];
        let totalRedeemed = 0n;
        
        for (let i = 0; i < positions.length; i++) {
            const position = positions[i];
            
            console.log(`\n   Position ${i}:`);
            console.log(`      Market: ${position.marketId}`);
            console.log(`      Token: ${position.tokenId.toString()}`);
            console.log(`      Amount: ${position.amount} tokens`);
            
            try {
                // Get condition ID + negRisk flag from market
                const marketInfo = await this.getConditionIdFromMarket(position.marketId);
                if (!marketInfo) {
                    console.log(`      ⚠️  Cannot get market info - skipping`);
                    results.push({ success: false, amount: 0n, skipped: true });
                    continue;
                }
                const { conditionId, negRisk } = marketInfo;
                console.log(`      📊 Market type: ${negRisk ? 'NEG-RISK' : 'STANDARD CTF'}`);

                // Get winning outcome from condition payout
                const payoutInfo = await this.getConditionPayout(conditionId);
                if (!payoutInfo.resolved) {
                    console.log(`      ⏳ Condition not yet resolved on CTF - bundle must wait`);
                    results.push({ success: false, amount: 0n, skipped: true });
                    continue;
                }
                
                const winningOutcome = payoutInfo.winningOutcome;
                console.log(`      ✅ Winning outcome: ${winningOutcome} (we bet: ${position.outcome})`);

                // Check if we bet on the winning outcome
                const weBetCorrectly = Number(position.outcome) === winningOutcome;
                if (!weBetCorrectly) {
                    console.log(`      ❌ We bet on outcome ${position.outcome}, winner was ${winningOutcome} - no payout`);
                    results.push({ success: true, amount: 0n });
                    continue;
                }

                // ✅ CHECK ACTUAL ON-CHAIN BALANCE - source of truth
                // Prevents phantom positions (failed trades saved in positions.json) from redeeming
                const actualBalance = await this.ctf.balanceOf(this.wallet.address, BigInt(position.tokenId));
                if (actualBalance === 0n) {
                    console.log(`      ⚠️  No CTF balance for this token - position was never bought (phantom)`);
                    results.push({ success: true, amount: 0n });
                    continue;
                }
                console.log(`      ✅ CTF balance confirmed: ${ethers.formatUnits(actualBalance, 6)} tokens`);

                // Use actual on-chain balance as the amount (not positions.json estimate)
                const tokenAmountRaw = actualBalance;

                let result;
                if (negRisk) {
                    // NEG-RISK: NegRiskAdapter.redeemPositions(conditionId, amounts[])
                    result = await this.redeemNegRiskPosition(
                        conditionId,
                        winningOutcome,
                        tokenAmountRaw,
                        nonceManager
                    );
                } else {
                    // STANDARD CTF: redeemPositions with indexSet
                    const indexSet = this.outcomeToIndexSet(winningOutcome);
                    console.log(`      📝 Redeeming indexSet ${indexSet} via CTF`);
                    result = await this.redeemPosition(conditionId, [indexSet], nonceManager);
                }
                
                if (result.success) {
                    console.log(`      💰 Redeemed: ${ethers.formatUnits(tokenAmountRaw, 6)} USDCe`);
                    totalRedeemed += tokenAmountRaw;
                    results.push({ success: true, amount: tokenAmountRaw });
                } else {
                    results.push({ success: false, amount: 0n });
                }
                
            } catch (error) {
                console.error(`      ❌ Error:`, error.message);
                results.push({ success: false, amount: 0n });
            }
            
            // Small delay between redemptions
            if (i < positions.length - 1) {
                await this.sleep(1000);
            }
        }
        
        console.log(`\n✅ Redemption complete: ${ethers.formatUnits(totalRedeemed, 6)} USDCe total`);
        
        return {
            results,
            totalRedeemed
        };
    }

    /**
     * Get collateral (USDCe) balance
     */
    async getCollateralBalance() {
        const collateralABI = ["function balanceOf(address) view returns (uint256)"];
        const collateral = new ethers.Contract(
            this.COLLATERAL_ADDRESS,
            collateralABI,
            this.wallet
        );
        return await collateral.balanceOf(this.wallet.address);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = ConditionalTokensRedeemer;
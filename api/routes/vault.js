// api/routes/vault.js
const express = require('express');
const router = express.Router();
const { ethers } = require('ethers');
const { vault, provider } = require('../server');

// Route API /vault/stats - FIXED VERSION
router.get('/stats', async (req, res) => {
    try {
        // Fetch all vault stats
        const [totalLiquidity, availableLiquidity, totalBonusPaid, totalResidualsReceived, totalProfitsRealized] = await Promise.all([
            vault.totalLiquidity(),
            vault.availableLiquidity(),
            vault.totalBonusPaid(),
            vault.totalResidualsReceived(),
            vault.totalProfitsRealized()
        ]);

        const total      = Number(ethers.formatUnits(totalLiquidity, 6));
        const available  = Number(ethers.formatUnits(availableLiquidity, 6));
        const bonusPaid  = Number(ethers.formatUnits(totalBonusPaid, 6));
        const residuals  = Number(ethers.formatUnits(totalResidualsReceived, 6));
        const profits    = Number(ethers.formatUnits(totalProfitsRealized, 6));

        const utilized      = total - available;
        const utilizationRate = total > 0 ? (utilized / total) * 100 : 0;
        const netPerformance  = residuals - bonusPaid;

        // ── APY historique via events FeesCollected ──────────────────
        // Récupère tous les fees collectés depuis le déploiement
        // pour ne pas remettre l'APY à 0 après chaque collectFees()
        let totalProfitsAllTime = profits; // inclut profits non encore collectés
        let vaultAgeInYears = 1; // fallback 1 an si pas d'events

        try {
            const filter = vault.filters.FeesCollected();
            const events = await vault.queryFilter(filter, 0, 'latest');

            if (events.length > 0) {
                // Additionner tous les fees collectés historiquement
                for (const event of events) {
                    const mgmt = Number(ethers.formatUnits(event.args.mgmtFee, 6));
                    const perf = Number(ethers.formatUnits(event.args.perfFee, 6));
                    totalProfitsAllTime += mgmt + perf;
                }

                // Calculer l'âge du vault depuis le premier event
                const firstBlock = await provider.getBlock(events[0].blockNumber);
                const ageInSeconds = Date.now() / 1000 - firstBlock.timestamp;
                vaultAgeInYears = Math.max(ageInSeconds / (365 * 86400), 1/365); // min 1 jour
            }
        } catch (e) {
            console.log('⚠️  Could not fetch FeesCollected events:', e.message);
        }

        const estimatedAPY = total > 0
            ? (totalProfitsAllTime / total / vaultAgeInYears) * 100
            : 0;

        res.json({
            totalLiquidity:    parseFloat(total.toFixed(2)),
            availableLiquidity: parseFloat(available.toFixed(2)),
            utilizedLiquidity:  parseFloat(utilized.toFixed(2)),
            utilizationRate:    parseFloat(utilizationRate.toFixed(2)),
            totalBonusPaid:     parseFloat(bonusPaid.toFixed(2)),
            totalResiduals:     parseFloat(residuals.toFixed(2)),
            totalProfits:       parseFloat(profits.toFixed(2)),
            totalProfitsAllTime: parseFloat(totalProfitsAllTime.toFixed(2)),
            netPerformance:     parseFloat(netPerformance.toFixed(2)),
            estimatedAPY:       parseFloat(estimatedAPY.toFixed(2))
        });

    } catch (error) {
        console.error('Get vault stats error:', error);
        res.status(500).json({
            error: {
                code: 'FETCH_ERROR',
                message: error.message
            }
        });
    }
});


// GET /api/vault/balance
router.get('/balance', async (req, res) => {
    try {
        const [totalLiquidity, availableLiquidity] = await Promise.all([
            vault.totalLiquidity(),
            vault.availableLiquidity()
        ]);

        const total     = Number(ethers.formatUnits(totalLiquidity, 6));
        const available = Number(ethers.formatUnits(availableLiquidity, 6));

        res.json({
            totalLiquidity:     parseFloat(total.toFixed(2)),
            availableLiquidity: parseFloat(available.toFixed(2)),
            utilized:           parseFloat((total - available).toFixed(2))
        });

    } catch (error) {
        console.error('Get vault balance error:', error);
        res.status(500).json({
            error: {
                code: 'FETCH_ERROR',
                message: error.message
            }
        });
    }
});

// GET /api/vault/shares/:address
router.get('/shares/:address', async (req, res) => {
    try {
        const { address } = req.params;
        
        if (!ethers.isAddress(address)) {
            return res.status(400).json({
                error: {
                    code: 'INVALID_ADDRESS',
                    message: 'Invalid address'
                }
            });
        }
        
        const [userShares, userValue] = await vault.getUserShares(address);
        const [totalShares, availableLiquidity] = await Promise.all([
            vault.totalShares(),
            vault.availableLiquidity()
        ]);

        const percentOwnership = totalShares > 0n
            ? Number((userShares * 10000n) / totalShares) / 100
            : 0;

        res.json({
            userAddress: address,
            shares: ethers.formatUnits(userShares, 6),
            sharesRaw: userShares.toString(),
            valueInVault: parseFloat(ethers.formatUnits(userValue, 6)),
            percentOwnership: percentOwnership,
            canWithdraw: userValue <= availableLiquidity
        });
        
    } catch (error) {
        console.error('Get user shares error:', error);
        res.status(500).json({
            error: {
                code: 'FETCH_ERROR',
                message: error.message
            }
        });
    }
});


router.get('/raw', async (req, res) => {
    try {
        // Create USDC contract
        const USDC_ABI = ["function balanceOf(address) view returns (uint256)"];
        const usdc = new ethers.Contract(
            process.env.USDC_ADDRESS, 
            USDC_ABI, 
            provider
        );
        
        const usdcBalance = await usdc.balanceOf(process.env.VAULT_ADDRESS);
        const totalLiq = await vault.totalLiquidity();
        
        res.json({
            usdcBalance: ethers.formatUnits(usdcBalance, 6),
            totalLiquidity: ethers.formatUnits(totalLiq, 6),
            vaultAddress: process.env.VAULT_ADDRESS
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/vault/withdraw/preview?address=0x...&amount=100
// Calcule combien de shares brûler pour retirer X USDC
router.get('/withdraw/preview', async (req, res) => {
    try {
        const { address, amount } = req.query;

        if (!ethers.isAddress(address)) {
            return res.status(400).json({ error: { code: 'INVALID_ADDRESS', message: 'Invalid address' } });
        }
        if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
            return res.status(400).json({ error: { code: 'INVALID_AMOUNT', message: 'Invalid amount' } });
        }

        const amountWei = ethers.parseUnits(parseFloat(amount).toFixed(6), 6);

        const [totalShares, totalLiquidity, availableLiquidity] = await Promise.all([
            vault.totalShares(),
            vault.totalLiquidity(),
            vault.availableLiquidity()
        ]);

        const [userShares, userValue] = await vault.getUserShares(address);

        // sharesToBurn = amount * totalShares / totalLiquidity
        const sharesToBurn = (amountWei * totalShares) / totalLiquidity;

        if (sharesToBurn > userShares) {
            return res.status(400).json({
                error: {
                    code: 'INSUFFICIENT_SHARES',
                    message: `Pas assez de shares. Max retirable: ${ethers.formatUnits(userValue, 6)} USDC`
                }
            });
        }

        if (amountWei > availableLiquidity) {
            return res.status(400).json({
                error: {
                    code: 'INSUFFICIENT_LIQUIDITY',
                    message: `Liquidité insuffisante. Disponible: ${ethers.formatUnits(availableLiquidity, 6)} USDC`
                }
            });
        }

        res.json({
            address,
            amountUSDC: parseFloat(amount),
            sharesToBurn: sharesToBurn.toString(),
            sharesToBurnFormatted: ethers.formatUnits(sharesToBurn, 6),
            userShares: userShares.toString(),
            userValueUSDC: parseFloat(ethers.formatUnits(userValue, 6)),
            canWithdraw: true
        });

    } catch (error) {
        console.error('Withdraw preview error:', error);
        res.status(500).json({ error: { code: 'FETCH_ERROR', message: error.message } });
    }
});

module.exports = router;
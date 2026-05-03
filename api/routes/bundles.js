// api/routes/bundles.js - V6: Multi-source + EIP-712
const express = require('express');
const router = express.Router();
const { ethers } = require('ethers');
const {
    provider,
    factory,
    getBundleDetails,
    buildSignDigest,
    generateTestnetMarketIds,
    SUPPORTED_SOURCES,
    PROTOCOL_FEE_RATE,
    ENTRY_FEE_RATE,
    EXIT_FEE_RATE
} = require('../server');

// ========================
// POST /api/bundles/validate
// Source-agnostic validation
// ========================
router.post('/validate', async (req, res) => {
    try {
        const { capital, markets } = req.body;

        if (!capital || capital < 1) {
            return res.status(400).json({
                error: { code: 'INVALID_CAPITAL', message: 'Capital must be at least 1 USDC' }
            });
        }

        if (!markets || markets.length < 3 || markets.length > 15) {
            return res.status(400).json({
                error: { code: 'INVALID_MARKETS', message: '3-15 markets required' }
            });
        }

        const isSimulation = process.env.SIMULATION_MODE === 'true';
        const warnings = [];
        const sourcesUsed = new Set();

        // Validate each market
        for (let i = 0; i < markets.length; i++) {
            const m = markets[i];

            // Source validation
            const source = (m.source || 'polymarket').toLowerCase();
            if (!SUPPORTED_SOURCES[source]) {
                return res.status(400).json({
                    error: {
                        code: 'UNSUPPORTED_SOURCE',
                        message: `Market ${i}: source "${source}" not supported. Use: ${Object.keys(SUPPORTED_SOURCES).join(', ')}`
                    }
                });
            }
            sourcesUsed.add(source);

            // MarketId required in production
            if (!isSimulation && !m.marketId) {
                return res.status(400).json({
                    error: { code: 'MISSING_MARKET_ID', message: `Market ${i}: marketId required` }
                });
            }

            // Odds validation
            if (!m.currentOdds || m.currentOdds < 1.1 || m.currentOdds > 10) {
                return res.status(400).json({
                    error: {
                        code: 'INVALID_ODDS',
                        message: `Market ${i}: odds must be between 1.1x and 10x (got ${m.currentOdds})`
                    }
                });
            }
        }

        // Check duplicates
        if (!isSimulation) {
            const marketIds = markets.map(m => m.marketId);
            if (new Set(marketIds).size !== marketIds.length) {
                return res.status(400).json({
                    error: { code: 'DUPLICATE_MARKETS', message: 'Cannot bet on same market twice' }
                });
            }
        }

        // Multi-source warning
        if (sourcesUsed.size > 1) {
            warnings.push({
                code: 'MULTI_SOURCE',
                message: `Bundle combines markets from ${[...sourcesUsed].join(', ')}. Settlement bot must support all sources.`
            });
        }

        // Calculate fees (V6: protocol fee + entry fee)
        let combinedOdds = 1;
        markets.forEach(m => { combinedOdds *= m.currentOdds; });

        const protocolFee = capital * PROTOCOL_FEE_RATE;
        const entryFee = capital * ENTRY_FEE_RATE;
        const capitalForTrading = capital - protocolFee - entryFee;
        const potentialPayout = capitalForTrading * combinedOdds;
        const profit = potentialPayout - capitalForTrading;
        const exitFee = profit > 0 ? profit * EXIT_FEE_RATE : 0;
        const netPayout = potentialPayout - exitFee;

        res.json({
            valid: true,
            combinedOdds: parseFloat(combinedOdds.toFixed(6)),
            potentialPayout: parseFloat(netPayout.toFixed(2)),
            capitalForTrading: parseFloat(capitalForTrading.toFixed(2)),
            fees: {
                protocol: parseFloat(protocolFee.toFixed(2)),
                entry: parseFloat(entryFee.toFixed(2)),
                exit: parseFloat(exitFee.toFixed(2)),
                total: parseFloat((protocolFee + entryFee + exitFee).toFixed(2))
            },
            sources: [...sourcesUsed],
            warnings,
            errors: []
        });

    } catch (error) {
        console.error('Validate error:', error);
        res.status(500).json({
            error: { code: 'VALIDATION_ERROR', message: error.message }
        });
    }
});

// ========================
// POST /api/bundles/prepare
// Build EIP-712 typed data for user to sign
// Replaces the old /create that encoded tx directly
// ========================
router.post('/prepare', async (req, res) => {
    try {
        const { userAddress, capital, markets, deadline, scenario } = req.body;

        if (!ethers.isAddress(userAddress)) {
            return res.status(400).json({
                error: { code: 'INVALID_ADDRESS', message: 'Invalid user address' }
            });
        }

        if (!capital || capital < 1) {
            return res.status(400).json({
                error: { code: 'INVALID_CAPITAL', message: 'Capital must be at least 1 USDC' }
            });
        }

        if (!markets || markets.length < 3 || markets.length > 15) {
            return res.status(400).json({
                error: { code: 'INVALID_MARKETS', message: '3-15 markets required' }
            });
        }

        const capitalWei = ethers.parseUnits(capital.toString(), 6);
        const isSimulation = process.env.SIMULATION_MODE === 'true';
        const now = Math.floor(Date.now() / 1000);

        // Parse market data (source-agnostic)
        const marketIds = isSimulation
            ? generateTestnetMarketIds(scenario || 'random', markets.length).map(id => BigInt(id))
            : markets.map(m => BigInt(m.marketId.toString().trim()));

        const tokenIds = markets.map(m => {
            if (isSimulation) return BigInt('1' + Math.floor(Math.random() * 1e17).toString());
            return BigInt(m.tokenId.toString().trim());
        });

        const outcomes = markets.map(m => m.outcome?.toString().toUpperCase() === 'YES' ? 1 : 0);
        const oddsPpm = markets.map(m => Math.floor(m.currentOdds * 1_000_000));
        const minOddsPpm = markets.map(m => {
            if (m.minOdds) return Math.floor(m.minOdds * 1_000_000);
            return Math.floor(m.currentOdds * 0.90 * 1_000_000); // 10% slippage default
        });

        const endTimes = isSimulation
            ? markets.map(() => BigInt(now + 600))
            : markets.map(m => BigInt(m.endTime));

        const txDeadline = deadline ? BigInt(deadline) : BigInt(now + 600);

        // Build EIP-712 typed data for user to sign
        const signData = await buildSignDigest(
            userAddress,
            capitalWei,
            marketIds,
            tokenIds,
            outcomes,
            oddsPpm,
            minOddsPpm,
            endTimes,
            txDeadline
        );

        // Also return the encoded params (relayer needs these after signature)
        const bundleParams = {
            marketIds: marketIds.map(id => id.toString()),
            tokenIds: tokenIds.map(id => id.toString()),
            outcomes,
            oddsPpm,
            minOddsPpm,
            endTimes: endTimes.map(t => t.toString()),
            deadline: txDeadline.toString()
        };

        // Tag sources used
        const sourcesUsed = [...new Set(markets.map(m => m.source || 'polymarket'))];

        res.json({
            success: true,
            // Client passes this to wallet.signTypedData()
            typedData: {
                domain: signData.domain,
                types: signData.types,
                message: signData.message
            },
            nonce: signData.nonce,
            // Client sends these back with signature to /submit
            bundleParams,
            sources: sourcesUsed,
            fees: {
                protocol: parseFloat((capital * PROTOCOL_FEE_RATE).toFixed(2)),
                entry: parseFloat((capital * ENTRY_FEE_RATE).toFixed(2))
            }
        });

    } catch (error) {
        console.error('Prepare error:', error);
        res.status(500).json({
            error: { code: 'PREPARE_ERROR', message: error.message }
        });
    }
});

// ========================
// POST /api/bundles/submit
// Submit signed bundle creation (direct or via relayer)
// ========================
router.post('/submit', async (req, res) => {
    try {
        const { userAddress, capital, bundleParams, signature } = req.body;

        if (!ethers.isAddress(userAddress)) {
            return res.status(400).json({
                error: { code: 'INVALID_ADDRESS', message: 'Invalid user address' }
            });
        }

        if (!signature) {
            return res.status(400).json({
                error: { code: 'MISSING_SIGNATURE', message: 'EIP-712 signature required' }
            });
        }

        if (!bundleParams) {
            return res.status(400).json({
                error: { code: 'MISSING_PARAMS', message: 'Bundle params from /prepare required' }
            });
        }

        const capitalWei = ethers.parseUnits(capital.toString(), 6);

        // Encode V6 createBundle (with signature)
        const txData = factory.interface.encodeFunctionData('createBundle', [
            userAddress,
            capitalWei,
            bundleParams.marketIds.map(id => BigInt(id)),
            bundleParams.tokenIds.map(id => BigInt(id)),
            bundleParams.outcomes,
            bundleParams.oddsPpm,
            bundleParams.minOddsPpm,
            bundleParams.endTimes.map(t => BigInt(t)),
            BigInt(bundleParams.deadline),
            signature
        ]);

        res.json({
            success: true,
            transaction: {
                to: process.env.FACTORY_ADDRESS,
                data: txData,
                value: '0'
            }
        });

    } catch (error) {
        console.error('Submit error:', error);
        res.status(500).json({
            error: { code: 'SUBMIT_ERROR', message: error.message }
        });
    }
});

// ========================
// GET /api/bundles/:address
// ========================
router.get('/:address', async (req, res) => {
    try {
        const { address } = req.params;

        if (!ethers.isAddress(address)) {
            return res.status(400).json({
                error: { code: 'INVALID_ADDRESS', message: 'Invalid bundle address' }
            });
        }

        const details = await getBundleDetails(address);

        // Add creation timestamp
        try {
            const filter = factory.filters.BundleCreated(address);
            const events = await factory.queryFilter(filter);
            if (events.length > 0) {
                const block = await provider.getBlock(events[0].blockNumber);
                details.createdAt = block.timestamp;
                details.createdAtHuman = new Date(block.timestamp * 1000).toISOString();
            }
        } catch (err) {
            details.createdAt = null;
            details.createdAtHuman = null;
        }

        // Add protocol fee info
        try {
            const filter = factory.filters.ProtocolFeePaid(address);
            const events = await factory.queryFilter(filter);
            if (events.length > 0) {
                details.protocolFeePaid = Number(ethers.formatUnits(events[0].args.fee, 6));
            }
        } catch (err) {
            details.protocolFeePaid = null;
        }

        res.json(details);

    } catch (error) {
        console.error('Get bundle error:', error);
        res.status(500).json({
            error: { code: 'FETCH_ERROR', message: error.message }
        });
    }
});

// ========================
// GET /api/bundles
// ========================
router.get('/', async (req, res) => {
    try {
        const { limit = 20, offset = 0, status } = req.query;

        const allBundleAddresses = await factory.getAllBundles();

        const bundles = [];
        for (const addr of allBundleAddresses.slice(parseInt(offset), parseInt(offset) + parseInt(limit))) {
            try {
                const details = await getBundleDetails(addr);

                try {
                    const filter = factory.filters.BundleCreated(addr);
                    const events = await factory.queryFilter(filter);
                    if (events.length > 0) {
                        const block = await provider.getBlock(events[0].blockNumber);
                        details.createdAt = block.timestamp;
                        details.createdAtHuman = new Date(block.timestamp * 1000).toISOString();
                    }
                } catch (err) {
                    details.createdAt = null;
                    details.createdAtHuman = null;
                }

                bundles.push(details);
                await new Promise(r => setTimeout(r, 100));
            } catch (err) {
                console.log(`Skip ${addr}: ${err.message}`);
            }
        }

        let filtered = bundles;
        if (status) {
            filtered = bundles.filter(b => b.status === status.toUpperCase());
        }

        res.json({
            total: allBundleAddresses.length,
            count: filtered.length,
            bundles: filtered
        });

    } catch (error) {
        console.error('List bundles error:', error);
        res.status(500).json({
            error: { code: 'FETCH_ERROR', message: error.message }
        });
    }
});

module.exports = router;

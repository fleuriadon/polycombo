// api/routes/users.js
const express = require('express');
const router = express.Router();
const { ethers } = require('ethers');
const { provider, factory, getBundleDetails } = require('../server');

// GET /api/users/:address/bundles
router.get('/:address/bundles', async (req, res) => {
    try {
        const { address } = req.params;
        const { status, limit = 10, offset = 0 } = req.query;
        
        if (!ethers.isAddress(address)) {
            return res.status(400).json({
                error: {
                    code: 'INVALID_ADDRESS',
                    message: 'Invalid user address'
                }
            });
        }
        
        // Get user's bundles from contract
        const userBundleAddresses = await factory.getUserBundles(address);
        
        // Get details for all with timestamps
        const bundles = [];
        for (const addr of userBundleAddresses) {
            try {
                const details = await getBundleDetails(addr);
                
                // Add creation timestamp
                try {
                    const filter = factory.filters.BundleCreated(addr);
                    const events = await factory.queryFilter(filter);
                    if (events.length > 0) {
                        const block = await provider.getBlock(events[0].blockNumber);
                        details.createdAt = block.timestamp;
                    }
                } catch (err) {
                    details.createdAt = 0;
                }
                
                bundles.push(details);
            } catch (err) {
                console.log(`Skip ${addr}: ${err.message}`);
            }
        }
        
        // Filter by status if provided
        let filtered = bundles;
        if (status) {
            const statusUpper = status.toUpperCase();
            if (statusUpper === 'ACTIVE') {
                filtered = bundles.filter(b => !b.isSettled);
            } else if (statusUpper === 'SETTLED') {
                filtered = bundles.filter(b => b.isSettled);
            } else {
                filtered = bundles.filter(b => b.status === statusUpper);
            }
        }
        
        // Sort by creation timestamp (newest first)
        filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        
        // Pagination
        const paginatedList = filtered.slice(
            parseInt(offset),
            parseInt(offset) + parseInt(limit)
        );
        
        // Calculate stats
        const stats = {
            totalBundles: filtered.length,
            activeBundles: bundles.filter(b => !b.isSettled).length,
            wonBundles: bundles.filter(b => b.status === 'WON').length,
            lostBundles: bundles.filter(b => b.status === 'LOST').length,
            totalWagered: bundles.reduce((sum, b) => sum + b.capital, 0),
            totalWon: bundles.filter(b => b.status === 'WON')
                .reduce((sum, b) => sum + b.actualPayout, 0)
        };
        
        res.json({
            user: address,
            stats,
            total: filtered.length,
            bundles: paginatedList.map(b => ({
                address: b.address,
                status: b.status,
                capital: b.capital,
                payout: b.actualPayout,
                roi: b.actualPayout > 0 ? 
                    parseFloat((((b.actualPayout - b.capital) / b.capital) * 100).toFixed(2)) : 
                    -100,
                marketsWon: b.marketsWon,
                marketsTotal: b.marketsTotal,
                combinedOdds: b.combinedOdds,
                settled: b.isSettled
            }))
        });
        
    } catch (error) {
        console.error('Get user bundles error:', error);
        res.status(500).json({
            error: {
                code: 'FETCH_ERROR',
                message: error.message
            }
        });
    }
});

// GET /api/users/:address/stats
router.get('/:address/stats', async (req, res) => {
    try {
        const { address } = req.params;
        
        if (!ethers.isAddress(address)) {
            return res.status(400).json({
                error: {
                    code: 'INVALID_ADDRESS',
                    message: 'Invalid user address'
                }
            });
        }
        
        const userBundleAddresses = await factory.getUserBundles(address);
        const bundles = await Promise.all(
            userBundleAddresses.map(addr => getBundleDetails(addr))
        );
        
        const totalWagered = bundles.reduce((sum, b) => sum + b.capital, 0);
        const totalWon = bundles.filter(b => b.status === 'WON')
            .reduce((sum, b) => sum + b.actualPayout, 0);
        const netProfit = totalWon - totalWagered;
        
        const wonBundles = bundles.filter(b => b.status === 'WON');
        const lostBundles = bundles.filter(b => b.status === 'LOST');
        
        res.json({
            user: address,
            totalBundles: bundles.length,
            activeBundles: bundles.filter(b => !b.isSettled).length,
            settledBundles: bundles.filter(b => b.isSettled).length,
            wonBundles: wonBundles.length,
            lostBundles: lostBundles.length,
            winRate: bundles.filter(b => b.isSettled).length > 0 ?
                parseFloat(((wonBundles.length / bundles.filter(b => b.isSettled).length) * 100).toFixed(2)) : 0,
            totalWagered: parseFloat(totalWagered.toFixed(2)),
            totalWon: parseFloat(totalWon.toFixed(2)),
            netProfit: parseFloat(netProfit.toFixed(2)),
            roi: totalWagered > 0 ? 
                parseFloat(((netProfit / totalWagered) * 100).toFixed(2)) : 0,
            avgOdds: bundles.length > 0 ?
                parseFloat((bundles.reduce((sum, b) => sum + b.combinedOdds, 0) / bundles.length).toFixed(2)) : 0,
            bestWin: wonBundles.length > 0 ?
                Math.max(...wonBundles.map(b => b.actualPayout - b.capital)) : 0
        });
        
    } catch (error) {
        console.error('Get user stats error:', error);
        res.status(500).json({
            error: {
                code: 'FETCH_ERROR',
                message: error.message
            }
        });
    }
});

module.exports = router;

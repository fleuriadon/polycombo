// api/routes/gelato.js - V6: EIP-712 signed relay
const express = require('express');
const router = express.Router();
const { ethers } = require('ethers');
const {
    factory,
    buildSignDigest,
    generateTestnetMarketIds,
    PROTOCOL_FEE_RATE,
    ENTRY_FEE_RATE
} = require('../server');

// ========================
// POST /api/gelato/create-bundle
// V6: Requires signature from /api/bundles/prepare
// ========================
router.post('/create-bundle', async (req, res) => {
    try {
        const { userAddress, capital, bundleParams, signature } = req.body;

        console.log('📊 Gelato relay request:', { userAddress, capital });

        // Validate
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

        if (!signature) {
            return res.status(400).json({
                error: {
                    code: 'MISSING_SIGNATURE',
                    message: 'EIP-712 signature required. Call /api/bundles/prepare first, sign the typedData, then submit here.'
                }
            });
        }

        if (!bundleParams) {
            return res.status(400).json({
                error: {
                    code: 'MISSING_PARAMS',
                    message: 'Bundle params from /api/bundles/prepare required'
                }
            });
        }

        const capitalWei = ethers.parseUnits(capital.toString(), 6);

        // Encode V6 createBundle with signature
        const iface = new ethers.Interface([
            "function createBundle(address user, uint256 userCapital, uint256[] memory marketIds, uint256[] memory tokenIds, uint8[] memory outcomes, uint256[] memory oddsPpm, uint256[] memory minOddsPpm, uint64[] memory endTimes, uint256 deadline, bytes memory signature) external returns (address)"
        ]);

        const data = iface.encodeFunctionData("createBundle", [
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

        console.log('✅ V6 transaction encoded with signature');
        console.log('🚀 Submitting sponsored call to Gelato...');

        const gelatoResponse = await fetch('https://relay.gelato.digital/relays/v2/sponsored-call', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chainId: parseInt(process.env.CHAIN_ID || '80002'),
                target: process.env.FACTORY_ADDRESS,
                data,
                user: userAddress,
                gasLimit: "5000000",
                sponsorApiKey: process.env.GELATO_API_KEY
            })
        });

        if (!gelatoResponse.ok) {
            const errorText = await gelatoResponse.text();
            throw new Error(`Gelato API error: ${gelatoResponse.status} - ${errorText}`);
        }

        const response = await gelatoResponse.json();
        console.log(`✅ Task submitted: ${response.taskId}`);

        res.json({
            success: true,
            taskId: response.taskId,
            message: 'Signed bundle creation submitted (gasless via Gelato)'
        });

    } catch (error) {
        console.error('❌ Gelato createBundle error:', error);
        res.status(500).json({
            error: { code: 'GELATO_ERROR', message: error.message }
        });
    }
});

// ========================
// GET /api/gelato/status/:taskId
// ========================
router.get('/status/:taskId', async (req, res) => {
    try {
        const { taskId } = req.params;

        const response = await fetch(`https://api.gelato.digital/tasks/status/${taskId}`);

        if (!response.ok) {
            return res.status(404).json({
                error: { code: 'TASK_NOT_FOUND', message: 'Task not found' }
            });
        }

        const data = await response.json();
        const task = data.task;

        res.json({
            taskId,
            status: task?.taskState || 'Unknown',
            transactionHash: task?.transactionHash,
            blockNumber: task?.blockNumber,
            createdAt: task?.creationDate
        });

    } catch (error) {
        console.error('Status fetch error:', error);
        res.status(500).json({
            error: { code: 'STATUS_ERROR', message: error.message }
        });
    }
});

// ========================
// POST /api/gelato/claim-payout
// ========================
router.post('/claim-payout', async (req, res) => {
    try {
        const { userAddress, bundleAddress } = req.body;

        if (!ethers.isAddress(userAddress)) {
            return res.status(400).json({
                error: { code: 'INVALID_ADDRESS', message: 'Invalid user address' }
            });
        }

        if (!ethers.isAddress(bundleAddress)) {
            return res.status(400).json({
                error: { code: 'INVALID_BUNDLE', message: 'Invalid bundle address' }
            });
        }

        console.log('🎁 Claim payout:', { userAddress, bundleAddress });

        const iface = new ethers.Interface([
            "function claimPayout(address user) external"
        ]);

        const data = iface.encodeFunctionData("claimPayout", [userAddress]);

        const gelatoResponse = await fetch('https://relay.gelato.digital/relays/v2/sponsored-call', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chainId: parseInt(process.env.CHAIN_ID || '80002'),
                target: bundleAddress,
                data,
                user: userAddress,
                sponsorApiKey: process.env.GELATO_API_KEY,
                gasLimit: "500000"
            })
        });

        if (!gelatoResponse.ok) {
            const errorText = await gelatoResponse.text();
            throw new Error(`Gelato API error: ${gelatoResponse.status} - ${errorText}`);
        }

        const response = await gelatoResponse.json();
        console.log(`✅ Claim submitted: ${response.taskId}`);

        res.json({
            success: true,
            taskId: response.taskId,
            message: 'Payout claim submitted (gasless via Gelato)'
        });

    } catch (error) {
        console.error('❌ Gelato claim error:', error);
        res.status(500).json({
            error: { code: 'CLAIM_ERROR', message: error.message }
        });
    }
});

module.exports = router;

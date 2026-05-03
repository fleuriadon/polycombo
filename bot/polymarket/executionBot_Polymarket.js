// executionBot_Polymarket_V7_NONCE_RETRY.js
// ⚡ OPTIMIZED VERSION with NONCE RETRY LOGIC:
// 1. Approvals once at startup (not per bundle)
// 2. Position persistence on disk
// 3. Skip settled bundles index
// 4. transferWithRetry() for nonce error handling
// PERFORMANCE: ~118 seconds faster per cycle + robust nonce handling

const { ethers } = require('ethers');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const PolymarketClient = require('./polymarketClient');
const NonceManager = require('./NonceManager');
const ResolutionQueue = require('./ResolutionQueue');
const ConditionalTokensRedeemer = require('./ConditionalTokensRedeemer');

dotenv.config();

class ExecutionBotPolymarket {
    constructor() {
        // Provider configuration
        const rpcUrl = process.env.RPC_URL;
        if (rpcUrl.startsWith('wss://')) {
            this.provider = new ethers.WebSocketProvider(rpcUrl);
        } else {
            this.provider = new ethers.JsonRpcProvider(
                rpcUrl,
                undefined,
                { polling: true, pollingInterval: 10000 }
            );
        }
        this.wallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, this.provider);
        
        // Nonce Manager
        this.nonceManager = new NonceManager(this.wallet);
        
        // Resolution Queue
        this.resolutionQueue = new ResolutionQueue();
        
        // Polymarket client
        this.polymarket = new PolymarketClient(
            process.env.BOT_PRIVATE_KEY,
            parseInt(process.env.POLYMARKET_CHAIN_ID || '137')
        );
        
        // CTF Redeemer
        this.redeemer = new ConditionalTokensRedeemer(
            this.wallet,
            parseInt(process.env.POLYMARKET_CHAIN_ID || '137')
        );
        
        console.log('🤖 Bot wallet:', this.wallet.address);
        
        // Polymarket contract addresses
        this.POLYMARKET_CONTRACTS = {
            CTF: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
            CTF_EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
            NEG_RISK_ADAPTER: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
            NEG_RISK_EXCHANGE: '0xC5d563A36AE78145C45a50134d48A1215220f80a'
        };
        
        // ABIs
        this.factoryABI = [
            "event BundleCreated(address indexed parlay, address indexed user, uint256 userCapital, uint256 combinedOdds)",
            "function transferFundsToBot(address bundleAddress) external",
            "function resolveMarket(address bundleAddress, uint256 marketIndex, bool won, uint256 actualGains) external",
            "function getAllBundles() external view returns (address[] memory)"
        ];
        
        this.bundleABI = [
            "function fundsTransferred() external view returns (bool)",
            "function getMarkets() external view returns (tuple(uint256 marketId, uint256 tokenId, uint8 outcome, uint256 oddsPpm, uint64 endTime, uint256 actualGains, bool resolved, bool won)[] memory)",
            "function isSettled() external view returns (bool)",
            "function isClaimed() external view returns (bool)",
            "function userCapital() external view returns (uint256)",
            "function userPayout() external view returns (uint256)",
            "function getBundleStatus() external view returns (uint256 marketsWon, uint256 marketsResolved, bool isSettled, bool isClaimed, uint256 userPayout, uint256 exitFeePaid)"
        ];

        this.usdcABI = [
            "function transfer(address to, uint256 amount) external returns (bool)",
            "function balanceOf(address account) external view returns (uint256)",
            "function approve(address spender, uint256 amount) external returns (bool)",
            "function allowance(address owner, address spender) external view returns (uint256)"
        ];

        // Contracts
        this.factory = new ethers.Contract(process.env.FACTORY_ADDRESS, this.factoryABI, this.wallet);
        this.usdc = new ethers.Contract(process.env.USDC_ADDRESS, this.usdcABI, this.wallet);
        
        // ⚡ OPTIMIZATION 3: Track only active bundles
        this.activeBundles = new Map();
        this.activeBundleAddresses = new Set(); // Only unsettled bundles
        this.processedBundles = new Set();
        
        // ⚡ OPTIMIZATION 2: Position persistence
        this.polymarketPositions = new Map();
        this.positionsFile = path.join(__dirname, 'positions.json');
        
        // ✅ FIX: Track redeem retries per bundle address (survives queue re-add)
        this.redeemRetriesMap = new Map();
        
        // ⚡ OPTIMIZATION 1: Approval state
        this.approvalsComplete = false;
        
        // Stats
        this.stats = {
            bundlesProcessed: 0,
            bundlesFailed: 0,
            totalProfit: 0n
        };
        
        // ⚡ Gas cache (30 second TTL)
        this.gasCache = null;
        this.gasCacheTime = 0;
        
        // Timers
        this.wakeupTimer = null;
        this.fallbackTimer = null;
    }

    /**
     * ✅ CRITICAL: Retry wrapper for transactions with nonce error AND revert handling
     * @param fn - Async function that returns transaction result
     * @param label - Description for logging
     * @param retries - Number of retry attempts
     */
    async transferWithRetry(fn, label = 'Transaction', retries = 2) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                console.log(`   📤 ${label} (attempt ${attempt + 1}/${retries + 1})...`);
                return await fn();
            } catch (error) {
                const isNonceError = error.code === 'NONCE_EXPIRED' || error.message.includes('nonce');
                const isRevertError = error.code === 'CALL_EXCEPTION';  // ✅ NEW: Detect reverts
                
                if ((isNonceError || isRevertError) && attempt < retries) {
                    if (isNonceError) {
                        console.log(`   ⚠️  Nonce error detected - resetting nonce manager...`);
                        await this.nonceManager.reset();
                    } else {
                        console.log(`   ⚠️  Contract reverted - retrying...`);
                    }
                    console.log(`   🔄 Retrying ${label}...`);
                    await this.sleep(1000);
                    continue;
                }
                
                // If not retryable or last retry, throw
                console.error(`   ❌ ${label} failed:`, error.message);
                throw error;
            }
        }
    }

    /**
     * ⚡ OPTIMIZED: Gas settings with 30s cache
     */
    async getGasSettings() {
        try {
            // Return cached if less than 30s old
            if (this.gasCache && Date.now() - this.gasCacheTime < 30000) {
                return this.gasCache;
            }
            
            const feeData = await this.provider.getFeeData();
            const minPriorityFee = ethers.parseUnits("30", "gwei");
            const minMaxFee = ethers.parseUnits("60", "gwei");
            
            const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas 
                ? (feeData.maxPriorityFeePerGas * 150n) / 100n 
                : minPriorityFee;
                
            const maxFeePerGas = feeData.maxFeePerGas 
                ? (feeData.maxFeePerGas * 150n) / 100n 
                : minMaxFee;
            
            this.gasCache = { 
                maxPriorityFeePerGas: maxPriorityFeePerGas > minPriorityFee ? maxPriorityFeePerGas : minPriorityFee,
                maxFeePerGas: maxFeePerGas > minMaxFee ? maxFeePerGas : minMaxFee
            };
            this.gasCacheTime = Date.now();
            
            return this.gasCache;
        } catch (error) {
            return {
                maxPriorityFeePerGas: ethers.parseUnits("30", "gwei"),
                maxFeePerGas: ethers.parseUnits("60", "gwei")
            };
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async rateLimitedCall(fn, retries = 3) {
        for (let i = 0; i < retries; i++) {
            try {
                return await fn();
            } catch (error) {
                if (i === retries - 1) throw error;
                await this.sleep(1000 * (i + 1));
            }
        }
    }

    /**
     * ⚡ OPTIMIZATION 2: Load positions from disk on startup
     */
    loadPositionsFromDisk() {
        try {
            if (fs.existsSync(this.positionsFile)) {
                const data = fs.readFileSync(this.positionsFile, 'utf8');
                const saved = JSON.parse(data);
                
                for (const [address, positions] of Object.entries(saved)) {
                    this.polymarketPositions.set(address, positions);
                }
                
                console.log(`📁 Loaded ${this.polymarketPositions.size} positions from disk`);
            }
        } catch (error) {
            console.error('⚠️  Error loading positions:', error.message);
        }
    }

    /**
     * ⚡ OPTIMIZATION 2: Save positions to disk
     */
    savePositionsToDisk() {
        try {
            const data = {};
            for (const [address, positions] of this.polymarketPositions.entries()) {
                data[address] = positions.map(p => ({
                    ...p,
                    tokenId: p.tokenId?.toString(),
                    marketId: p.marketId?.toString(),
                    amount: Number(p.amount)
                }));
            }
            
            fs.writeFileSync(this.positionsFile, JSON.stringify(data, (key, value) =>
                typeof value === 'bigint' ? value.toString() : value, 2));
        } catch (error) {
            console.error('⚠️  Error saving positions:', error.message);
        }
    }

    /**
     * ⚡ OPTIMIZATION 1: Do all approvals once at startup
     */
    async ensureApprovals() {
        if (this.approvalsComplete) {
            console.log('✅ Approvals already complete');
            return;
        }
        
        console.log('\n🔐 Checking Polymarket approvals...');
        
        const USDCE_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
        const usdce = new ethers.Contract(USDCE_ADDRESS, [
            "function approve(address, uint256) returns (bool)",
            "function allowance(address, address) view returns (uint256)"
        ], this.wallet);
        
        // Check if all approvals already done
        let allApproved = true;
        
        // 1. Check USDC approvals
        const usdcSpenders = [
            this.POLYMARKET_CONTRACTS.CTF,
            this.POLYMARKET_CONTRACTS.CTF_EXCHANGE,
            this.POLYMARKET_CONTRACTS.NEG_RISK_ADAPTER,
            this.POLYMARKET_CONTRACTS.NEG_RISK_EXCHANGE
        ];
        
        for (const spender of usdcSpenders) {
            const allowance = await usdce.allowance(this.wallet.address, spender);
            if (allowance === 0n) {
                allApproved = false;
                break;
            }
        }
        
        // 2. Check CTF approvals
        if (allApproved) {
            const ctfABI = [
                "function isApprovedForAll(address account, address operator) external view returns (bool)"
            ];
            const ctf = new ethers.Contract(this.POLYMARKET_CONTRACTS.CTF, ctfABI, this.wallet);
            
            const outcomeTokenSpenders = [
                this.POLYMARKET_CONTRACTS.CTF_EXCHANGE,
                this.POLYMARKET_CONTRACTS.NEG_RISK_ADAPTER,
                this.POLYMARKET_CONTRACTS.NEG_RISK_EXCHANGE
            ];
            
            for (const spender of outcomeTokenSpenders) {
                const isApproved = await ctf.isApprovedForAll(this.wallet.address, spender);
                if (!isApproved) {
                    allApproved = false;
                    break;
                }
            }
        }
        
        if (allApproved) {
            console.log('✅ All approvals already in place');
            this.approvalsComplete = true;
            return;
        }
        
        // Do approvals
        console.log('⚡ Performing one-time approvals...');
        
        // Approve USDC for all 4 contracts
        console.log('   Approving USDCe for 4 contracts...');
        for (const spender of usdcSpenders) {
            const allowance = await usdce.allowance(this.wallet.address, spender);
            if (allowance === 0n) {
                await this.transferWithRetry(
                    async () => {
                        const nonce = await this.nonceManager.getNext();
                        const gasSettings = await this.getGasSettings();
                        const approveTx = await usdce.approve(spender, ethers.MaxUint256, { ...gasSettings, nonce });
                        await approveTx.wait();
                    },
                    `USDC approval for ${spender.slice(0, 10)}...`,
                    1
                );
                console.log(`   ✅ Approved USDC for ${spender.slice(0, 10)}...`);
            }
        }
        
        // Approve CTF tokens for all 3 exchanges
        const ctfABI = [
            "function setApprovalForAll(address operator, bool approved) external", 
            "function isApprovedForAll(address account, address operator) external view returns (bool)"
        ];
        const ctf = new ethers.Contract(this.POLYMARKET_CONTRACTS.CTF, ctfABI, this.wallet);
        
        const outcomeTokenSpenders = [
            this.POLYMARKET_CONTRACTS.CTF_EXCHANGE,
            this.POLYMARKET_CONTRACTS.NEG_RISK_ADAPTER,
            this.POLYMARKET_CONTRACTS.NEG_RISK_EXCHANGE
        ];
        
        console.log('   Approving CTF tokens for 3 exchanges...');
        for (const spender of outcomeTokenSpenders) {
            const isApproved = await ctf.isApprovedForAll(this.wallet.address, spender);
            if (!isApproved) {
                await this.transferWithRetry(
                    async () => {
                        const nonce = await this.nonceManager.getNext();
                        const gasSettings = await this.getGasSettings();
                        const approveCtfTx = await ctf.setApprovalForAll(spender, true, { ...gasSettings, nonce });
                        await approveCtfTx.wait();
                    },
                    `CTF approval for ${spender.slice(0, 10)}...`,
                    1
                );
                console.log(`   ✅ Approved CTF for ${spender.slice(0, 10)}...`);
            }
        }
        
        this.approvalsComplete = true;
        console.log('✅ All approvals complete!\n');
    }

    /**
     * ⚡ OPTIMIZATION 3: Load and index active bundles once
     */
    async initializeActiveBundles() {
        try {
            const allBundles = await this.rateLimitedCall(() => this.factory.getAllBundles());
            
            console.log(`📦 Indexing ${allBundles.length} bundles...`);
            
            // Check each bundle once
            for (const address of allBundles) {
                try {
                    const bundle = new ethers.Contract(address, this.bundleABI, this.wallet);
                    const isSettled = await bundle.isSettled();
                    
                    if (!isSettled) {
                        this.activeBundleAddresses.add(address);
                    } else {
                        this.processedBundles.add(address);
                    }
                } catch (error) {
                    // Skip problematic bundles
                }
            }
            
            console.log(`✅ Found ${this.activeBundleAddresses.size} active bundles`);
            console.log(`   (${this.processedBundles.size} already settled)\n`);
            
        } catch (error) {
            console.error('⚠️  Error initializing bundles:', error.message);
        }
    }

    /**
     * ⚡ OPTIMIZED: Check only active bundles
     */
    async checkExistingBundles() {
        try {
            // Get new bundles since last check
            const allBundles = await this.rateLimitedCall(() => this.factory.getAllBundles());
            
            // Add any new bundles to active list
            for (const address of allBundles) {
                if (!this.activeBundleAddresses.has(address) && !this.processedBundles.has(address)) {
                    this.activeBundleAddresses.add(address);
                }
            }
            
            console.log(`\n🔍 Checking ${this.activeBundleAddresses.size} active bundles...`);
            
            // Check only active bundles
            for (const address of this.activeBundleAddresses) {
                console.log(`   🔎 Checking ${address.slice(0, 10)}...`);

                try {
                    const bundle = new ethers.Contract(address, this.bundleABI, this.wallet);
                    
                    const [fundsTransferred, isSettled, userCapital, markets] = await this.rateLimitedCall(() =>
                        Promise.all([
                            bundle.fundsTransferred(),
                            bundle.isSettled(),
                            bundle.userCapital(),
                            bundle.getMarkets()
                        ])
                    );

                    console.log(`      fundsTransferred=${fundsTransferred}, isSettled=${isSettled}, markets=${markets.length}`);

                    // ⚡ Remove from active if settled
                    if (isSettled) {
                        this.activeBundleAddresses.delete(address);
                        this.processedBundles.add(address);
                        console.log(`      ✅ Settled - removed from active list`);
                        continue;
                    }

                    // Check if ready to resolve
                    // ✅ +60s buffer: absorbs delta between JS clock and Polygon block timestamp
                    // Prevents resolveMarket revert on "not ended yet" require in Bundle.sol
                    const allExpired = markets.every(m => Date.now() > (Number(m.endTime) + 60) * 1000);
                    const anyUnresolved = markets.some(m => !m.resolved);
                    
                    console.log(`      allExpired=${allExpired}, anyUnresolved=${anyUnresolved}`);

                    if (fundsTransferred && allExpired && anyUnresolved) {
                        const added = this.resolutionQueue.add({
                            address,
                            capital: userCapital,
                            markets: markets.map(m => ({
                                marketId: m.marketId.toString(),
                                tokenId: m.tokenId.toString(),
                                outcome: Number(m.outcome),
                                oddsPpm: m.oddsPpm,
                                endTime: m.endTime,
                                resolved: m.resolved,
                                won: m.won
                            }))
                        });

                        if (added) {
                            console.log(`      📅 ADDED TO QUEUE for resolution`);
                        }
                    }

                    // Handle new bundles
                    if (!fundsTransferred && !allExpired && !this.activeBundles.has(address)) {
                        console.log(`      🆕 NEW BUNDLE - will trade`);
                        await this.handleNewBundle(address, userCapital, markets);
                    }

                } catch (error) {
                    console.error(`      ❌ Error: ${error.message}`);
                }
            }

            this.processQueue();

        } catch (error) {
            console.error('❌ Error checkExistingBundles:', error.message);
        }
    }

    async processQueue() {
        if (this.resolutionQueue.isProcessing()) {
            return;
        }

        if (this.resolutionQueue.isEmpty()) {
            return;
        }

        this.resolutionQueue.setProcessing(true);
        console.log(`\n🔄 Starting queue processing...`);

        while (!this.resolutionQueue.isEmpty()) {
            const bundleData = this.resolutionQueue.next();
            
            console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            console.log(`📦 Processing bundle ${this.resolutionQueue.getStats().processed + 1}`);
            console.log(`   Address: ${bundleData.address}`);
            console.log(`   Queue remaining: ${this.resolutionQueue.size()}`);
            console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

            try {
                const result = await this.resolveBundle(bundleData);
                
                if (result === 'PENDING') {
                    // ⏳ CTF not yet resolved - keep in active list, retry next cycle (5 min)
                    console.log(`   ⏳ Bundle kept active - will retry next cycle`);
                    // Do NOT delete from activeBundleAddresses, do NOT mark as processed
                } else {
                    this.resolutionQueue.recordSuccess();
                    this.stats.bundlesProcessed++;
                    // ⚡ Remove from active bundles only when truly resolved
                    this.activeBundleAddresses.delete(bundleData.address);
                    this.processedBundles.add(bundleData.address);
                }
            } catch (error) {
                console.error(`❌ Bundle resolution failed:`, error.message);
                
                // ✅ NONCE FIX: Detect nonce errors and reset
                if (error.code === 'NONCE_EXPIRED' || error.message.includes('nonce')) {
                    console.log(`🔄 Nonce error detected - resetting nonce manager`);
                    await this.nonceManager.reset();
                }
                
                this.resolutionQueue.recordFailure();
                this.stats.bundlesFailed++;
            }

            await this.sleep(2000);
        }

        this.resolutionQueue.setProcessing(false);
        console.log(`\n✅ Queue processing complete!`);
        this.resolutionQueue.printStatus();
    }

    async resolveBundle(bundleData) {
        console.log(`\n🎯 RESOLVING: ${bundleData.address}`);
        
        try {
            const bundle = new ethers.Contract(bundleData.address, this.bundleABI, this.wallet);
            const currentMarkets = await bundle.getMarkets();
            
            console.log(`   📊 Bundle state:`);
            console.log(`      Markets: ${currentMarkets.length}`);
            console.log(`      Resolved: ${currentMarkets.filter(m => m.resolved).length}/${currentMarkets.length}`);
            
            let actualGains = await this.redeemPositions(bundleData);

            // ✅ FIX: PENDING = some CTF conditions not yet resolved → signal caller to retry
            if (actualGains === 'PENDING') {
                console.log(`\n⏳ Markets not yet resolved on CTF - will retry next cycle`);
                return 'PENDING';
            }

            // ✅ FIX: null = positions not found → retry up to 3 times then resolve as lost
            // redeemRetriesMap survives queue re-add (bundleData est un nouvel objet à chaque cycle)
            if (actualGains === null) {
                const retries = (this.redeemRetriesMap.get(bundleData.address) || 0) + 1;
                this.redeemRetriesMap.set(bundleData.address, retries);
                
                if (retries < 3) {
                    console.log(`\n⏭️  No positions found - retry ${retries}/3 next cycle`);
                    return 'PENDING';
                }
                
                console.log(`\n⚠️  Max retries (3/3) - resolving as lost`);
                this.redeemRetriesMap.delete(bundleData.address);
                actualGains = bundleData.markets.map(() => 0n);
            }
            
            let totalGains = 0n;
            for (const gain of actualGains) {
                totalGains += gain;
            }
            
            console.log(`\n💰 Total redeemed: ${ethers.formatUnits(totalGains, 6)} USDC`);
            
            console.log(`\n🔄 Resolving ${currentMarkets.length} markets onchain...`);
            
            for (let i = 0; i < currentMarkets.length; i++) {
                const market = currentMarkets[i];
                
                if (market.resolved) {
                    console.log(`   ⭐️ Market ${i} already resolved onchain`);
                    continue;
                }
                
                const actualGain = actualGains[i] || 0n;
                
                // ✅ CRITICAL: Calculate minimum gain required for "won" status
                const amountPerMarket = bundleData.capital / BigInt(bundleData.markets.length);
                
                // If actualGain < amountPerMarket, mark as lost (contract requirement)
                let won = false;
                let finalGain = 0n;
                
                if (actualGain > 0n && actualGain >= amountPerMarket) {
                    won = true;
                    finalGain = actualGain;
                    console.log(`   ✅ Market ${i}: WON (${ethers.formatUnits(actualGain, 6)} USDC >= min ${ethers.formatUnits(amountPerMarket, 6)})`);
                } else if (actualGain > 0n && actualGain < amountPerMarket) {
                    won = false;
                    finalGain = 0n;
                    console.log(`   ⚠️ Market ${i}: DOWNGRADED TO LOSS (${ethers.formatUnits(actualGain, 6)} < min ${ethers.formatUnits(amountPerMarket, 6)})`);
                } else {
                    won = false;
                    finalGain = 0n;
                    console.log(`   ❌ Market ${i}: LOST (0 gains)`);
                }
                
                // ✅ CRITICAL FIX: Wrap with retry + error handling for already resolved
                try {
                    await this.transferWithRetry(
                        async () => {
                            const nonce = await this.nonceManager.getNext();
                            const gasSettings = await this.getGasSettings();
                            const tx = await this.factory.resolveMarket(
                                bundleData.address,
                                i,
                                won,
                                finalGain,
                                { ...gasSettings, gasLimit: 2000000, nonce }
                            );
                            await tx.wait();
                        },
                        `Resolve market ${i} (won=${won})`,
                        2  // 2 retries for resolveMarket
                    );
                    
                    console.log(`   ✅ Market ${i} resolved: won=${won}, gains=${ethers.formatUnits(finalGain, 6)} USDC`);
                } catch (error) {
                    if (error.message.includes('already resolved')) {
                        console.log(`   ⭐️ Market ${i} was already resolved`);
                        continue;
                    }
                    
                    console.error(`   ❌ Market ${i} failed: ${error.message}`);
                    throw error;
                }
                
                await this.sleep(500);
            }
            
            console.log(`\n✅ Bundle resolved successfully!`);
            
            // ✅ Cleanup retries map
            this.redeemRetriesMap.delete(bundleData.address);
            
            // Non-blocking webhook
            this.sendWebhook(bundleData.address, actualGains, currentMarkets).catch(err => {
                console.log(`   ⚠️ Webhook failed: ${err.message}`);
            });
            
        } catch (error) {
            console.error(`❌ Error resolving bundle:`, error);
            throw error;
        }
    }

    async redeemPositions(bundleData) {
        try {
            let positions = this.polymarketPositions.get(bundleData.address);
            
            // Try loading from disk first
            if (!positions || positions.length === 0) {
                console.log('   ⚠️  Positions not in memory, checking disk...');
                this.loadPositionsFromDisk();
                positions = this.polymarketPositions.get(bundleData.address);
            }
            
            // If still not found, reconstruct from CTF balances
            if (!positions || positions.length === 0) {
                console.log('   ⚠️  Reconstructing from CTF balances...');
                positions = await this.reconstructPositionsFromCTF(bundleData);
            }

            // ✅ FIX: If no positions found at all, return null to signal "skip this cycle"
            if (!positions || positions.length === 0) {
                console.log('   ⚠️  No positions found - markets may not have been traded');
                console.log('   ⏭️  Skipping resolve to avoid incorrectly marking as lost');
                return null;
            }
            
            // ✅ CRITICAL: Balance is the source of TRUTH
            const balanceBefore = await this.redeemer.getCollateralBalance();
            console.log(`   💰 USDCe balance before: ${ethers.formatUnits(balanceBefore, 6)}`);
            
            const redemptionResult = await this.redeemer.redeemBundlePositions(
                positions,
                this.nonceManager
            );
            
            const balanceAfter = await this.redeemer.getCollateralBalance();
            const totalActuallyRedeemed = balanceAfter - balanceBefore;
            
            console.log(`   💰 USDCe balance after: ${ethers.formatUnits(balanceAfter, 6)}`);
            console.log(`   💰 Total ACTUALLY redeemed: ${ethers.formatUnits(totalActuallyRedeemed > 0n ? totalActuallyRedeemed : 0n, 6)} USDCe`);
            
            // ✅ Check for pending markets
            const hasSkipped = redemptionResult.results.some(r => r.skipped);
            if (hasSkipped) {
                console.log(`   ⏳ Some markets not yet resolved on CTF - will requeue bundle`);
                return 'PENDING';
            }
            
            // ✅ DISTRIBUTE actual gains based on REAL balance change
            // CRITICAL: array must be indexed by MARKET index (not position index)
            // because resolveBundle iterates over currentMarkets[i] using market index i
            const numMarkets = bundleData.markets.length;
            let actualGains;
            
            if (totalActuallyRedeemed <= 0n) {
                // No redemption happened
                console.log(`   ⚠️  No balance change - all positions lost or not exist`);
                actualGains = new Array(numMarkets).fill(0n);
            } else {
                // Distribute the REAL amount among winning positions
                const winningIndices = [];
                for (let i = 0; i < redemptionResult.results.length; i++) {
                    if (redemptionResult.results[i].success && redemptionResult.results[i].amount > 0n) {
                        winningIndices.push(i);
                    }
                }
                
                if (winningIndices.length === 0) {
                    console.log(`   ⚠️  No winning positions despite balance change - allocation error`);
                    actualGains = new Array(numMarkets).fill(0n);
                } else {
                    // Split totalActuallyRedeemed equally among winners
                    actualGains = new Array(numMarkets).fill(0n);
                    
                    for (const idx of winningIndices) {
                        // Use marketIndex to map position → correct market slot
                        const marketIdx = positions[idx].marketIndex ?? idx;
                        actualGains[marketIdx] = redemptionResult.results[idx].amount;
                    }
                    
                    console.log(`   ✅ Distributed ${ethers.formatUnits(totalActuallyRedeemed, 6)} USDCe among ${winningIndices.length} winners`);
                }
            }
            
            // Swap and transfer REAL amount to bundle
            if (totalActuallyRedeemed > 0n) {
                await this.swapAndTransfer(bundleData.address, totalActuallyRedeemed);
            }
            
            return actualGains;
            
        } catch (error) {
            console.error('❌ Error redeemPositions:', error.message);
            return null;
        }
    }

    async reconstructPositionsFromCTF(bundleData) {
        try {
            console.log(`   🔍 Reconstructing positions from CTF balances...`);
            
            const ctfABI = [
                "function balanceOf(address account, uint256 id) external view returns (uint256)"
            ];
            const ctf = new ethers.Contract(this.POLYMARKET_CONTRACTS.CTF, ctfABI, this.wallet);
            
            const positions = [];
            
            for (let i = 0; i < bundleData.markets.length; i++) {
                const market = bundleData.markets[i];
                
                const balance = await ctf.balanceOf(this.wallet.address, market.tokenId);
                
                if (balance > 0n) {
                    const amount = Number(ethers.formatUnits(balance, 6));
                    
                    positions.push({
                        marketIndex: i,
                        marketId: market.marketId,
                        tokenId: market.tokenId,
                        outcome: market.outcome,
                        amount: amount
                    });
                    
                    console.log(`      Market ${i}: ${amount.toFixed(2)} tokens`);
                }
            }
            
            return positions;
            
        } catch (error) {
            console.error(`   ❌ Error reconstructing:`, error.message);
            return [];
        }
    }

    async swapAndTransfer(bundleAddress, amountUSDCe) {
        try {
            const USDC_ADDRESS = process.env.USDC_ADDRESS;
            const USDCE_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
            const UNISWAP_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
            
            console.log(`\n🔄 Swapping ${ethers.formatUnits(amountUSDCe, 6)} USDCe → USDC...`);
            
            const usdce = new ethers.Contract(USDCE_ADDRESS, [
                "function approve(address, uint256) returns (bool)",
                "function allowance(address, address) view returns (uint256)"
            ], this.wallet);
            
            const usdc = new ethers.Contract(USDC_ADDRESS, [
                "function balanceOf(address) view returns (uint256)",
                "function transfer(address, uint256) returns (bool)"
            ], this.wallet);
            
            const usdcBalanceBefore = await usdc.balanceOf(this.wallet.address);
            
            await this.transferWithRetry(
                async () => {
                    const uniswapAllowance = await usdce.allowance(this.wallet.address, UNISWAP_V3_ROUTER);
                    if (uniswapAllowance < amountUSDCe) {
                        const nonce = await this.nonceManager.getNext();
                        const gasSettings = await this.getGasSettings();
                        const approveTx = await usdce.approve(UNISWAP_V3_ROUTER, ethers.MaxUint256, { ...gasSettings, nonce });
                        await approveTx.wait();
                    }
                },
                'USDCe approval for Uniswap',
                1
            );
            
            const swapRouterABI = [
                "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
            ];
            const swapRouter = new ethers.Contract(UNISWAP_V3_ROUTER, swapRouterABI, this.wallet);
            
            await this.transferWithRetry(
                async () => {
                    const nonce = await this.nonceManager.getNext();
                    const gasSettings = await this.getGasSettings();
                    // ✅ swapParams built inside closure so deadline is fresh on each retry attempt
                    const swapParams = {
                        tokenIn: USDCE_ADDRESS,
                        tokenOut: USDC_ADDRESS,
                        fee: 100,
                        recipient: this.wallet.address,
                        deadline: Math.floor(Date.now() / 1000) + 300,
                        amountIn: amountUSDCe,
                        amountOutMinimum: amountUSDCe * 9995n / 10000n,
                        sqrtPriceLimitX96: 0
                    };
                    const swapTx = await swapRouter.exactInputSingle(swapParams, { ...gasSettings, nonce });
                    await swapTx.wait();
                },
                'USDCe swap to USDC',
                1
            );
            
            const usdcBalanceAfter = await usdc.balanceOf(this.wallet.address);
            const usdcReceived = usdcBalanceAfter - usdcBalanceBefore;
            
            console.log(`💰 USDC received: ${ethers.formatUnits(usdcReceived, 6)}`);
            
            console.log(`\n🔄 Transferring to bundle...`);
            
            await this.transferWithRetry(
                async () => {
                    const nonce = await this.nonceManager.getNext();
                    const gasSettings = await this.getGasSettings();
                    const transferTx = await usdc.transfer(bundleAddress, usdcReceived, { ...gasSettings, nonce });
                    await transferTx.wait();
                },
                'Transfer USDC to bundle',
                1
            );
            
            console.log(`✅ Transferred ${ethers.formatUnits(usdcReceived, 6)} USDC to bundle`);
            
        } catch (error) {
            console.error('❌ Error swapAndTransfer:', error.message);
            throw error;
        }
    }

    async handleNewBundle(bundleAddress, capital, markets) {
        try {
            console.log(`\n🆕 New bundle: ${bundleAddress}`);
            console.log(`   Capital: ${ethers.formatUnits(capital, 6)} USDC`);
            console.log(`   Markets: ${markets.length}`);
            
            this.activeBundles.set(bundleAddress, {
                capital,
                markets,
                addedAt: Date.now()
            });
            
            // Check if funds already transferred (bot restart case)
            const bundle = new ethers.Contract(bundleAddress, this.bundleABI, this.wallet);
            const alreadyTransferred = await bundle.fundsTransferred();
            
            if (alreadyTransferred) {
                console.log(`\n⚠️  Funds already transferred - skipping transfer`);
            } else {
                // Transfer funds from bundle to bot
                console.log(`\n💸 Transferring funds from bundle to bot...`);
                
                await this.transferWithRetry(
                    async () => {
                        const nonce = await this.nonceManager.getNext();
                        const gasSettings = await this.getGasSettings();
                        const transferTx = await this.factory.transferFundsToBot(
                            bundleAddress, 
                            { ...gasSettings, nonce }
                        );
                        await transferTx.wait();
                    },
                    'Transfer funds to bot',
                    2  // 2 retries for this critical tx
                );
                
                console.log(`✅ Funds transferred to bot wallet`);
            }
            
            // Execute Polymarket trades and check if successful
            const tradingSuccess = await this.executePolymarketTrades(bundleAddress, capital, markets);
            
            // If trading failed (geo-blocked, API error, etc), return funds to bundle
            if (!tradingSuccess) {
                console.log(`\n⚠️  Trading failed - returning funds to bundle...`);
                await this.returnFundsToBundle(bundleAddress, capital);
            }
            
        } catch (error) {
			this.activeBundles.delete(bundleAddress);
            console.error('❌ Error handleNewBundle:', error.message);
            
            // Try to return funds on any error
            try {
                console.log(`\n🔄 Attempting to return funds after error...`);
                await this.returnFundsToBundle(bundleAddress, capital);
            } catch (returnError) {
                console.error('❌ Failed to return funds:', returnError.message);
            }
        }
    }

    /**
     * Return funds to bundle if trading failed
     * Swaps any USDCe back to USDC and transfers to bundle
     */
    async returnFundsToBundle(bundleAddress, originalCapital) {
        try {
            const USDC_ADDRESS = process.env.USDC_ADDRESS;
            const USDCE_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
            
            // Check bot's USDC balance (if swap didn't happen)
            const usdcBalance = await this.usdc.balanceOf(this.wallet.address);
            
            if (usdcBalance >= originalCapital) {
                console.log(`   💰 Bot has ${ethers.formatUnits(usdcBalance, 6)} USDC`);
                console.log(`   📤 Transferring USDC back to bundle...`);
                
                await this.transferWithRetry(
                    async () => {
                        const nonce = await this.nonceManager.getNext();
                        const gasSettings = await this.getGasSettings();
                        const transferTx = await this.usdc.transfer(
                            bundleAddress, 
                            originalCapital,
                            { ...gasSettings, nonce }
                        );
                        await transferTx.wait();
                    },
                    'Return USDC to bundle',
                    1
                );
                
                console.log(`   ✅ Returned ${ethers.formatUnits(originalCapital, 6)} USDC to bundle`);
                return;
            }
            
            // Check bot's USDCe balance (if swap happened but trades failed)
            const usdce = new ethers.Contract(USDCE_ADDRESS, [
                "function balanceOf(address) view returns (uint256)"
            ], this.wallet);
            
            const usdceBalance = await usdce.balanceOf(this.wallet.address);
            
            if (usdceBalance > 0n) {
                console.log(`   💰 Bot has ${ethers.formatUnits(usdceBalance, 6)} USDCe to return`);
                
                // Use existing swapAndTransfer function to convert USDCe → USDC and send to bundle
                await this.swapAndTransfer(bundleAddress, usdceBalance);
                console.log(`   ✅ Swapped USDCe → USDC and returned to bundle`);
                return;
            }
            
            console.log(`   ⚠️  No funds to return (already transferred or spent)`);
            
        } catch (error) {
            console.error('   ❌ Error returnFundsToBundle:', error.message);
            throw error;
        }
    }

    /**
     * ⚡ OPTIMIZED: No approvals in this function (done at startup)
     */
    async executePolymarketTrades(bundleAddress, capital, markets) {
        try {
            console.log(`\n📊 Executing Polymarket trades for ${bundleAddress.slice(0, 10)}...`);
            
            const botBalance = await this.usdc.balanceOf(this.wallet.address);
            console.log(`💰 Bot USDC balance: ${ethers.formatUnits(botBalance, 6)} USDC`);
            
            if (botBalance < capital) {
                throw new Error(`Insufficient balance: has ${ethers.formatUnits(botBalance, 6)}, needs ${ethers.formatUnits(capital, 6)}`);
            }
            
            // Swap USDC → USDCe
            const USDCE_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
            const UNISWAP_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
            
            console.log(`\n🔄 Swapping USDC → USDCe...`);
            
            const usdce = new ethers.Contract(USDCE_ADDRESS, [
                "function balanceOf(address) view returns (uint256)",
                "function approve(address, uint256) returns (bool)",
                "function allowance(address, address) view returns (uint256)"
            ], this.wallet);
            
            const usdceBalanceBefore = await usdce.balanceOf(this.wallet.address);
            
            await this.transferWithRetry(
                async () => {
                    const uniswapAllowance = await this.usdc.allowance(this.wallet.address, UNISWAP_V3_ROUTER);
                    if (uniswapAllowance < capital) {
                        console.log(`🔐 Approving USDC for Uniswap...`);
                        const nonce = await this.nonceManager.getNext();
                        const gasSettings = await this.getGasSettings();
                        const approveTx = await this.usdc.approve(UNISWAP_V3_ROUTER, ethers.MaxUint256, { ...gasSettings, nonce });
                        await approveTx.wait();
                        console.log(`✅ USDC approved`);
                    }
                },
                'Approve USDC for swap',
                1
            );
            
            const swapRouterABI = [
                "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
            ];
            const swapRouter = new ethers.Contract(UNISWAP_V3_ROUTER, swapRouterABI, this.wallet);
            
            await this.transferWithRetry(
                async () => {
                    const nonce = await this.nonceManager.getNext();
                    const gasSettings = await this.getGasSettings();
                    // ✅ swapParams built inside closure so deadline is fresh on each retry attempt
                    const swapParams = {
                        tokenIn: process.env.USDC_ADDRESS,
                        tokenOut: USDCE_ADDRESS,
                        fee: 100,
                        recipient: this.wallet.address,
                        deadline: Math.floor(Date.now() / 1000) + 300,
                        amountIn: capital,
                        amountOutMinimum: capital * 9995n / 10000n,
                        sqrtPriceLimitX96: 0
                    };
                    console.log(`💱 Swapping ${ethers.formatUnits(capital, 6)} USDC...`);
                    const swapTx = await swapRouter.exactInputSingle(swapParams, { ...gasSettings, nonce });
                    await swapTx.wait();
                    console.log(`✅ Swap successful!`);
                },
                'USDC to USDCe swap',
                1
            );
            
            const usdceBalanceAfter = await usdce.balanceOf(this.wallet.address);
            const usdceSwapped = usdceBalanceAfter - usdceBalanceBefore;
            console.log(`💰 Swapped: ${ethers.formatUnits(usdceSwapped, 6)} USDCe`);
            
            // ⚡ SKIP APPROVALS - Already done at startup!
            console.log(`⚡ Skipping approvals (already done at startup)`);
            
            // Calculate capital per market
            const totalCapitalUSDC = Number(ethers.formatUnits(usdceSwapped, 6));
            const safeCapital = totalCapitalUSDC * 0.989;
            const capitalPerMarket = safeCapital / markets.length;
            
            console.log(`\n💰 Trading:`);
            console.log(`   Total: ${totalCapitalUSDC.toFixed(6)} USDCe`);
            console.log(`   Safe (98.9%): ${safeCapital.toFixed(6)} USDCe`);
            console.log(`   Per market: ${capitalPerMarket.toFixed(6)} USDCe`);
            
            // Execute orders sequentially
            const positions = [];
            let usdceToRefund = 0; // Track USDCe that failed to trade (already swapped)

            for (let i = 0; i < markets.length; i++) {
                const market = markets[i];
                const tokenId = market.tokenId.toString();
                const marketId = market.marketId.toString();
                
                console.log(`\n   Market ${i}: ${tokenId.slice(0, 20)}...`);
                
                // Fetch negRisk flag from Polymarket API
                let isNegRisk = false;
                try {
                    const mktResp = await fetch(`https://gamma-api.polymarket.com/markets/${marketId}`);
                    if (mktResp.ok) {
                        const mktData = await mktResp.json();
                        isNegRisk = mktData.negRisk === true;
                        if (isNegRisk) console.log(`      🔄 Neg-risk market detected`);
                    }
                } catch (e) {
                    console.log(`      ⚠️ Could not fetch negRisk flag: ${e.message}`);
                }
                
                const midPrice = await this.polymarket.getMidPrice(tokenId);
                if (!midPrice) {
                    console.log(`      ⚠️ Price unavailable - will refund ${capitalPerMarket.toFixed(6)} USDCe`);
                    usdceToRefund += capitalPerMarket;
                    continue;
                }
                
                console.log(`      Price: $${midPrice.toFixed(4)}`);
                const quantity = capitalPerMarket / midPrice;
                
                // Retry logic - up to 3 attempts with exception handling
                let order = null;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        order = await this.polymarket.marketBuy(tokenId, capitalPerMarket, isNegRisk);
                        
                        if (order && order.success) {
                            console.log(`      ✅ Bought ${quantity.toFixed(2)} tokens (attempt ${attempt}/3)`);
                            break;
                        } else {
                            // Order returned but not successful
                            console.log(`      ⚠️ Attempt ${attempt}/3 failed: ${order?.errorMsg || 'unknown'}`);
                            if (attempt < 3) await this.sleep(3000);
                        }
                    } catch (error) {
                        // Exception thrown - retry
                        console.log(`      ⚠️ Attempt ${attempt}/3 exception: ${error.message}`);
                        if (attempt < 3) await this.sleep(3000);
                    }
                }

                if (order && order.success) {
                    positions.push({
                        marketIndex: i,
                        marketId: market.marketId.toString(),
                        outcome: market.outcome,
                        tokenId,
                        amount: quantity,
                        entryPrice: midPrice,
                        orderId: order.orderID,
                        negRisk: isNegRisk
                    });
                    console.log(`      ✅ Position saved to positions.json`);
                } else {
                    console.log(`      ❌ Order failed after 3 attempts - will refund ${capitalPerMarket.toFixed(6)} USDCe`);
                    usdceToRefund += capitalPerMarket;
                }
                
                if (i < markets.length - 1) {
                    await this.sleep(2000);
                }
            }

            // Refund untraded USDCe: swap back to USDC and send to bundle
            if (usdceToRefund > 0) {
                console.log(`\n⚠️ Refunding ${usdceToRefund.toFixed(6)} USDCe to bundle (swap → USDC)...`);
                try {
                    const refundWei = ethers.parseUnits(usdceToRefund.toFixed(6), 6);
                    await this.swapAndTransfer(bundleAddress, refundWei);
                    console.log(`✅ Refunded ${usdceToRefund.toFixed(6)} USDC to bundle`);
                } catch (refundError) {
                    console.error(`❌ Refund failed: ${refundError.message} - ${usdceToRefund.toFixed(6)} USDCe stuck in bot wallet`);
                }
            }
            
            // ⚡ OPTIMIZATION 2: Save positions to disk
            // Only successful positions are saved (order.success === true)
            // Phantom positions (failed trades) are NOT in this array
            this.polymarketPositions.set(bundleAddress, positions);
            this.savePositionsToDisk();
            
            console.log(`\n✅ ${positions.length}/${markets.length} positions opened`);
            console.log(`📁 Positions saved to disk`);
            
            // Return success if at least one position opened
            return positions.length > 0;
            
        } catch (error) {
            console.error('❌ Error executePolymarketTrades:', error.message);
            // Return false on failure instead of throwing
            return false;
        }
    }

    async sendWebhook(bundleAddress, actualGains, markets) {
        if (!process.env.WEBHOOK_URL) {
            return;
        }
        
        try {
            console.log(`   📡 Sending webhook...`);
            
            const allWon = actualGains.every(g => g > 0n);
            const status = allWon ? 'won' : 'lost';
            
            const payload = {
                bundleAddress,
                status,
                markets: markets.length,
                totalGains: ethers.formatUnits(
                    actualGains.reduce((sum, g) => sum + g, 0n),
                    6
                )
            };
            
            const response = await fetch(process.env.WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            if (response.ok) {
                console.log(`   ✅ Webhook sent`);
            } else {
                console.log(`   ⚠️ Webhook failed: ${response.status}`);
            }
        } catch (error) {
            console.log(`   ⚠️ Webhook error: ${error.message}`);
        }
    }

    async start() {
        console.log('\n🚀 Bot starting...');
        console.log('📋 Configuration:');
        console.log(`   Factory: ${process.env.FACTORY_ADDRESS}`);
        console.log(`   USDC: ${process.env.USDC_ADDRESS}`);
        console.log(`   Chain: ${process.env.POLYMARKET_CHAIN_ID || '137'}`);
        console.log(`   Bot: ${this.wallet.address}\n`);
        
        // Initialize nonce manager
        await this.nonceManager.initialize();
        
        // ✅ NONCE FIX: Reset to ensure sync with network at startup
        await this.nonceManager.reset();
        console.log('✅ Nonce manager synced with network\n');
        
        // ⚡ OPTIMIZATION 1: Do approvals once at startup
        await this.ensureApprovals();
        
        // ⚡ OPTIMIZATION 2: Load positions from disk
        this.loadPositionsFromDisk();
        
        // ⚡ OPTIMIZATION 3: Index active bundles once
        await this.initializeActiveBundles();
        
        // Start monitoring
        await this.checkExistingBundles();
        
        // Check every 5 minutes
        setInterval(() => {
            this.checkExistingBundles();
        }, 5 * 60 * 1000);
    }

    async shutdown() {
        console.log('\n👋 Shutting down...');
        
        // ⚡ Save positions before exit
        this.savePositionsToDisk();
        
        if (this.wakeupTimer) clearTimeout(this.wakeupTimer);
        if (this.fallbackTimer) clearInterval(this.fallbackTimer);
        process.exit(0);
    }
}

if (require.main === module) {
    const bot = new ExecutionBotPolymarket();
    
    process.on('SIGINT', () => bot.shutdown());
    process.on('SIGTERM', () => bot.shutdown());
    
    bot.start().catch(error => {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    });
}

module.exports = ExecutionBotPolymarket;

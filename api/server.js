// api/server.js - V6: Multi-source agnostic + EIP-712 + Protocol Fee
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { ethers } = require('ethers');

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

// ========================
// ETHERS SETUP
// ========================
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

// V6 Factory ABI (with signature param + protocol fee + nonce)
const factoryABI = [
    "function createBundle(address user, uint256 userCapital, uint256[] memory marketIds, uint256[] memory tokenIds, uint8[] memory outcomes, uint256[] memory oddsPpm, uint256[] memory minOddsPpm, uint64[] memory endTimes, uint256 deadline, bytes memory signature) external returns (address)",
    "function getAllBundles() external view returns (address[] memory)",
    "function getUserBundles(address user) external view returns (address[] memory)",
    "function getNonce(address user) external view returns (uint256)",
    "function getDomainSeparator() external view returns (bytes32)",
    "function protocolTreasury() external view returns (address)",
    "function PROTOCOL_FEE_PPM() external view returns (uint256)",
    "function entryFeePpm() external view returns (uint256)",
    "function exitFeePpm() external view returns (uint256)",
    "function MAX_DEPLOYER_FEE() external view returns (uint256)",
    "event BundleCreated(address indexed bundle, address indexed user, uint256 userCapital, uint256 combinedOdds)",
    "event ProtocolFeePaid(address indexed bundle, uint256 fee)"
];

const bundleABI = [
    "function user() external view returns (address)",
    "function userCapital() external view returns (uint256)",
    "function getCombinedOdds() external view returns (uint256)",
    "function getMarkets() external view returns (tuple(uint256 marketId, uint256 tokenId, uint8 outcome, uint256 oddsPpm, uint64 endTime, uint256 actualGains, bool resolved, bool won)[] memory)",
    "function getBundleStatus() external view returns (uint256 marketsWon, uint256 marketsResolved, bool isSettled, bool isClaimed, uint256 userPayout, uint256 exitFeePaid)",
    "function isSettled() external view returns (bool)",
    "function isClaimed() external view returns (bool)",
    "function userPayout() external view returns (uint256)"
];

const vaultABI = [
    "function totalLiquidity() external view returns (uint256)",
    "function availableLiquidity() external view returns (uint256)",
    "function totalBonusPaid() external view returns (uint256)",
    "function totalResidualsReceived() external view returns (uint256)",
    "function totalProfitsRealized() external view returns (uint256)",
    "function getUserShares(address user) external view returns (uint256 userShares, uint256 userValue)",
    "function totalShares() external view returns (uint256)",
    "event FeesCollected(uint256 mgmtFee, uint256 perfFee)"
];

const factory = new ethers.Contract(process.env.FACTORY_ADDRESS, factoryABI, provider);
const vault = new ethers.Contract(process.env.VAULT_ADDRESS, vaultABI, provider);

// ========================
// SUPPORTED MARKET SOURCES
// ========================
const SUPPORTED_SOURCES = {
    polymarket: {
        name: 'Polymarket',
        chain: 'polygon',
        settlement: 'UMA Optimistic Oracle',
        tokenStandard: 'ERC-1155 Conditional Tokens'
    },
    azuro: {
        name: 'Azuro',
        chain: 'polygon,gnosis,arbitrum,base',
        settlement: 'Azuro Oracle + Data Providers',
        tokenStandard: 'Azuro Liquidity Pool'
    },
    overtime: {
        name: 'Overtime / Thales',
        chain: 'optimism,arbitrum,base',
        settlement: 'Chainlink',
        tokenStandard: 'ERC-20 UP/DOWN'
    },
    sx: {
        name: 'SX Bet',
        chain: 'sx-network,arbitrum',
        settlement: 'SX Validator Network',
        tokenStandard: 'SX Order Book'
    },
    drift: {
        name: 'Drift BET',
        chain: 'solana',
        settlement: 'Drift Oracle',
        tokenStandard: 'Drift Perps Engine'
    },
    custom: {
        name: 'Custom',
        chain: 'any',
        settlement: 'User-defined',
        tokenStandard: 'User-defined'
    }
};

// ========================
// FEE CONSTANTS
// Protocol fee is immutable (0.5%). Entry/exit fees are deployer-configurable.
// API reads them from contract at startup and caches.
// ========================
const PROTOCOL_FEE_RATE = 0.005;  // 0.5% — immutable on-chain
let ENTRY_FEE_RATE = 0.02;       // default, updated from contract
let EXIT_FEE_RATE = 0.02;        // default, updated from contract

// Read deployer-configured fees from contract
async function refreshFeeRates() {
    try {
        const entryPpm = await factory.entryFeePpm();
        const exitPpm = await factory.exitFeePpm();
        ENTRY_FEE_RATE = Number(entryPpm) / 1_000_000;
        EXIT_FEE_RATE = Number(exitPpm) / 1_000_000;
        console.log(`💰 Fees loaded: entry=${ENTRY_FEE_RATE * 100}%, exit=${EXIT_FEE_RATE * 100}%`);
    } catch (err) {
        console.log('⚠️  Could not read fee rates from contract, using defaults');
    }
}
// Refresh on startup (called after listen)

// ========================
// EIP-712 CONSTANTS
// ========================
const EIP712_DOMAIN = {
    name: "PolyComboFactory",
    version: "6"
};

const CREATE_BUNDLE_TYPEHASH = ethers.keccak256(
    ethers.toUtf8Bytes("CreateBundle(address user,uint256 userCapital,bytes32 marketsHash,uint256 nonce,uint256 deadline)")
);

// ========================
// HELPERS
// ========================

function generateTestnetMarketIds(scenario = 'random', count = 3) {
    let baseId;
    if (scenario === 'random') {
        const rand = Math.random();
        if (rand < 0.064) baseId = 10000 + Math.floor(Math.random() * 130);
        else if (rand < 0.344) baseId = 10130 + Math.floor(Math.random() * 560);
        else if (rand < 0.774) baseId = 10690 + Math.floor(Math.random() * 860);
        else baseId = 11550 + Math.floor(Math.random() * 450);
    } else if (scenario === 'win') {
        baseId = 10000 + Math.floor(Math.random() * 130);
    } else if (scenario === '2/3') {
        baseId = 10130 + Math.floor(Math.random() * 560);
    } else if (scenario === '1/3') {
        baseId = 10690 + Math.floor(Math.random() * 860);
    } else {
        baseId = 11550 + Math.floor(Math.random() * 450);
    }
    return Array.from({ length: count }, (_, i) => baseId + i);
}

function oddsToPpm(odds) {
    return Math.floor(odds * 1_000_000);
}

/**
 * Build the EIP-712 digest that the user must sign
 */
async function buildSignDigest(userAddress, userCapital, marketIds, tokenIds, outcomes, oddsPpm, minOddsPpm, endTimes, deadline) {
    const nonce = await factory.getNonce(userAddress);
    const chainId = (await provider.getNetwork()).chainId;

    const marketsHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ["uint256[]", "uint256[]", "uint8[]", "uint256[]", "uint256[]", "uint64[]"],
            [marketIds, tokenIds, outcomes, oddsPpm, minOddsPpm, endTimes]
        )
    );

    const domainSeparator = ethers.TypedDataEncoder.hashDomain({
        ...EIP712_DOMAIN,
        chainId: Number(chainId),
        verifyingContract: process.env.FACTORY_ADDRESS
    });

    const structHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ["bytes32", "address", "uint256", "bytes32", "uint256", "uint256"],
            [CREATE_BUNDLE_TYPEHASH, userAddress, userCapital, marketsHash, nonce, deadline]
        )
    );

    const digest = ethers.keccak256(
        ethers.solidityPacked(
            ["string", "bytes32", "bytes32"],
            ["\x19\x01", domainSeparator, structHash]
        )
    );

    return {
        digest,
        nonce: nonce.toString(),
        chainId: Number(chainId),
        domain: {
            ...EIP712_DOMAIN,
            chainId: Number(chainId),
            verifyingContract: process.env.FACTORY_ADDRESS
        },
        types: {
            CreateBundle: [
                { name: "user", type: "address" },
                { name: "userCapital", type: "uint256" },
                { name: "marketsHash", type: "bytes32" },
                { name: "nonce", type: "uint256" },
                { name: "deadline", type: "uint256" }
            ]
        },
        message: {
            user: userAddress,
            userCapital: userCapital.toString(),
            marketsHash,
            nonce: nonce.toString(),
            deadline: deadline.toString()
        }
    };
}

async function getBundleDetails(bundleAddress) {
    const bundle = new ethers.Contract(bundleAddress, bundleABI, provider);

    const [user, capital, combinedOdds, markets, status, isSettled] = await Promise.all([
        bundle.user(),
        bundle.userCapital(),
        bundle.getCombinedOdds(),
        bundle.getMarkets(),
        bundle.getBundleStatus(),
        bundle.isSettled()
    ]);

    const [marketsWon, marketsResolved, _isSettled, isClaimed, userPayout, exitFeePaid] = status;

    const combinedOddsDecimal = Number(combinedOdds) / 1_000_000;
    const capitalDecimal = Number(ethers.formatUnits(capital, 6));
    const potentialPayout = capitalDecimal * combinedOddsDecimal;
    const actualPayout = Number(ethers.formatUnits(userPayout, 6));

    let statusStr = 'ACTIVE';
    if (isSettled) {
        statusStr = Number(marketsWon) === markets.length ? 'WON' : 'LOST';
    }

    return {
        address: bundleAddress,
        user,
        status: statusStr,
        capital: capitalDecimal,
        combinedOdds: combinedOddsDecimal,
        potentialPayout,
        actualPayout,
        marketsWon: Number(marketsWon),
        marketsTotal: markets.length,
        isSettled,
        isClaimed,
        userPayout: actualPayout,
        canClaim: isSettled && !isClaimed && actualPayout > 0,
        exitFeePaid: Number(ethers.formatUnits(exitFeePaid, 6)),
        markets: markets.map(m => ({
            marketId: m.marketId.toString(),
            tokenId: m.tokenId.toString(),
            outcome: Number(m.outcome),
            odds: Number(m.oddsPpm) / 1_000_000,
            endTime: Number(m.endTime),
            resolved: m.resolved,
            won: m.won,
            actualGains: Number(ethers.formatUnits(m.actualGains, 6))
        }))
    };
}

// ========================
// EXPORTS
// ========================
module.exports = {
    provider,
    factory,
    vault,
    factoryABI,
    bundleABI,
    vaultABI,
    generateTestnetMarketIds,
    oddsToPpm,
    getBundleDetails,
    buildSignDigest,
    refreshFeeRates,
    SUPPORTED_SOURCES,
    get PROTOCOL_FEE_RATE() { return PROTOCOL_FEE_RATE; },
    get ENTRY_FEE_RATE() { return ENTRY_FEE_RATE; },
    get EXIT_FEE_RATE() { return EXIT_FEE_RATE; },
    EIP712_DOMAIN,
    CREATE_BUNDLE_TYPEHASH
};

// ========================
// ROUTES
// ========================
app.get('/health', async (req, res) => {
    const isSimulation = process.env.SIMULATION_MODE === 'true';
    const network = isSimulation ? 'polygon-amoy' : 'polygon-mainnet';

    res.json({
        status: 'ok',
        version: 'v6',
        simulationMode: isSimulation,
        network,
        factory: process.env.FACTORY_ADDRESS,
        vault: process.env.VAULT_ADDRESS,
        supportedSources: Object.keys(SUPPORTED_SOURCES),
        fees: {
            protocol: `${PROTOCOL_FEE_RATE * 100}%`,
            entry: `${ENTRY_FEE_RATE * 100}%`,
            exit: `${EXIT_FEE_RATE * 100}% (on profit)`
        }
    });
});

// GET /api/sources - List supported market sources
app.get('/api/sources', (req, res) => {
    res.json({
        sources: SUPPORTED_SOURCES,
        note: "Markets from any source can be combined in a single bundle. The settlement bot must support resolution for each source used."
    });
});

const bundleRoutes = require('./routes/bundles');
const userRoutes = require('./routes/users');
const vaultRoutes = require('./routes/vault');
const gelatoRoutes = require('./routes/gelato');

app.use('/api/bundles', bundleRoutes);
app.use('/api/users', userRoutes);
app.use('/api/vault', vaultRoutes);
app.use('/api/gelato', gelatoRoutes);

app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({
        error: {
            code: 'INTERNAL_ERROR',
            message: err.message
        }
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    const isSimulation = process.env.SIMULATION_MODE === 'true';
    const network = isSimulation ? 'Polygon Amoy Testnet' : 'Polygon Mainnet';

    console.log(`\n🚀 PolyCombo API v6 running on port ${PORT}`);
    console.log(`🎯 Mode: ${isSimulation ? 'SIMULATION' : 'PRODUCTION'}`);
    console.log(`📡 Network: ${network}`);
    console.log(`🏭 Factory: ${process.env.FACTORY_ADDRESS}`);
    console.log(`🏦 Vault: ${process.env.VAULT_ADDRESS}`);
    console.log(`🔌 Sources: ${Object.keys(SUPPORTED_SOURCES).join(', ')}`);
    
    await refreshFeeRates();
    console.log('');
});

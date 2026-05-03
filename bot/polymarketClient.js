// polymarketClient_SDK_Fixed_WithProxy.js
const { ClobClient, Side, OrderType } = require('@polymarket/clob-client');
const ethersV5 = require('ethers-v5');
const { HttpsProxyAgent } = require('https-proxy-agent');

class PolymarketClient {
    constructor(walletOrPrivateKey, chainId = 137) {
        this.chainId = chainId;
    
        // ✅ Créer wallet avec ethers v5
        if (typeof walletOrPrivateKey === 'string') {
            this.wallet = new ethersV5.Wallet(walletOrPrivateKey);
        } else {
            // Si c'est un wallet v6, extraire la clé privée
            this.wallet = new ethersV5.Wallet(walletOrPrivateKey.privateKey);
        }
        
        this.host = chainId === 137 
            ? 'https://clob.polymarket.com' 
            : 'https://clob-testnet.polymarket.com';
            
        this.clobApiUrl = this.host;
        this.client = null;
        this.apiCreds = null;
        
        // 🌐 Setup WebShare proxy if configured
        this.proxyAgent = null;
        if (process.env.WEBSHARE_PROXY_HOST) {
            const proxyUrl = `http://${process.env.WEBSHARE_PROXY_USER}:${process.env.WEBSHARE_PROXY_PASS}@${process.env.WEBSHARE_PROXY_HOST}:${process.env.WEBSHARE_PROXY_PORT || '80'}`;
            this.proxyAgent = new HttpsProxyAgent(proxyUrl);
            console.log(`🌐 WebShare proxy configured for CLOB`);
            console.log(`   Host: ${process.env.WEBSHARE_PROXY_HOST}`);
        }
        
        console.log(`🔗 Polymarket Client initialized (SDK)`);
        console.log(`   Wallet: ${this.wallet.address}`);
        console.log(`   CLOB API: ${this.host}`);
    }

    /**
     * Initialize the CLOB client with API credentials
     */
    async initialize() {
        if (this.client) {
            return; // Already initialized
        }

        try {
            console.log('🔓 Deriving API credentials...');
            
            // Create temporary client to derive API key
            // Note: The SDK doesn't support passing agent in constructor, 
            // but it will use global fetch which we can configure
            const tempClient = new ClobClient(this.host, this.chainId, this.wallet);
            
            // Derive API credentials from wallet
            this.apiCreds = await tempClient.createOrDeriveApiKey();
            
            // Validate credentials structure
            if (!this.apiCreds || !this.apiCreds.key || !this.apiCreds.secret || !this.apiCreds.passphrase) {
                console.error('❌ Invalid credentials structure:', this.apiCreds);
                throw new Error('API credentials incomplete');
            }
            
            console.log('✅ API credentials obtained');
            console.log(`   Key: ${this.apiCreds.key.substring(0, 20)}...`);
            console.log(`   Has secret: ${!!this.apiCreds.secret}`);
            console.log(`   Has passphrase: ${!!this.apiCreds.passphrase}`);
            
            // Create authenticated client
            // signatureType: 0 = EOA (Externally Owned Account)
            // funder: address that holds USDC (same as wallet for EOA)
            this.client = new ClobClient(
                this.host,
                this.chainId,
                this.wallet,
                this.apiCreds,
                0,                      // signatureType: 0 = EOA
                this.wallet.address     // funder: our wallet address
            );
            
            // 🌐 If proxy is configured, patch the client's fetch calls
            if (this.proxyAgent) {
                this._patchClientWithProxy();
            }
            
            console.log('✅ CLOB client initialized');
            
            // Test the client with a simple API call
            try {
                const serverTime = await this.client.getServerTime();
                console.log('✅ Client authenticated - server time:', serverTime);
            } catch (testError) {
                console.error('❌ Client authentication test failed:', testError.message);
                throw new Error('API credentials invalid - authentication failed');
            }
            
        } catch (error) {
            console.error('❌ Error initializing client:', error.message);
            throw error;
        }
    }

    /**
     * Patch the CLOB client to use proxy for all requests
     */
_patchClientWithProxy() {
    if (!this.proxyAgent || !this.client) return;
    
    const axios = require('axios');
    
    // Configure axios defaults pour CLOB API
    axios.defaults.proxy = false; // Disable default proxy
    axios.defaults.httpsAgent = this.proxyAgent; // Use existing agent
    
    console.log('🌐 Axios configured with proxy for CLOB');
}

    /**
     * Get orderbook for a token
     */
    async getOrderBook(tokenId) {
        try {
            await this.initialize();
            
            const orderbook = await this.client.getOrderBook(tokenId.toString());
            return orderbook;
        } catch (error) {
            console.error(`❌ Error getOrderBook:`, error.message);
            return null;
        }
    }

    /**
     * Get mid price for a token
     */
    async getMidPrice(tokenId) {
        try {
            await this.initialize();
            
            const result = await this.client.getMidpoint(tokenId.toString());
            if (!result || !result.mid) {
                return null;
            }
            
            return parseFloat(result.mid);
        } catch (error) {
            console.error(`❌ Error getMidPrice:`, error.message);
            return null;
        }
    }

    /**
     * Market buy: create and post a buy order at current ask price
     */
    async marketBuy(tokenId, usdcAmount, negRisk = false) {
        try {
            await this.initialize();
            
            console.log(`💰 Market buy: ${usdcAmount.toFixed(2)} USDC of tokens${negRisk ? ' [NEG-RISK]' : ''}`);
            
            const buyParams = {
                tokenID: tokenId.toString(),
                amount: usdcAmount,
                side: Side.BUY,
                feeRateBps: 0
            };
            if (negRisk) buyParams.negRisk = true;
            
            const marketOrder = await this.client.createMarketOrder(buyParams);
            
            console.log('📝 Market order created, posting...');
            
            const response = await this.client.postOrder(marketOrder, OrderType.FOK);
            
            console.log('✅ Order response:', response);
            
            return {
                success: response.success !== false,
                orderID: response.orderID || response.id,
                errorMsg: response.errorMsg || response.error || ''
            };
            
        } catch (error) {
            console.error('❌ Error marketBuy:', error.message);
            return {
                success: false,
                errorMsg: error.message
            };
        }
    }

    /**
     * BATCH Market buy
     */
    async marketBuyBatch(tokenAmounts) {
        try {
            await this.initialize();
            
            console.log(`💰 Batch market buy: ${tokenAmounts.length} orders`);
            
            const ordersArgs = [];
            for (const { tokenId, usdcAmount } of tokenAmounts) {
                console.log(`   Creating order: ${usdcAmount.toFixed(2)} USDC for token ${tokenId.toString().slice(0, 10)}...`);
                
                const marketOrder = await this.client.createMarketOrder({
                    tokenID: tokenId.toString(),
                    amount: usdcAmount,
                    side: Side.BUY,
                    feeRateBps: 0
                });
                
                ordersArgs.push({
                    order: marketOrder,
                    orderType: OrderType.FOK
                });
            }
            
            console.log('📝 Posting batch orders...');
            
            const responses = await this.client.postOrders(ordersArgs);
            
            console.log('✅ Batch order responses:', responses);
            
            return responses.map((resp, i) => ({
                tokenId: tokenAmounts[i].tokenId.toString(),
                success: resp.success !== false,
                orderID: resp.orderID || resp.id,
                errorMsg: resp.errorMsg || resp.error || ''
            }));
            
        } catch (error) {
            console.error('❌ Error marketBuyBatch:', error.message);
            return tokenAmounts.map(({ tokenId }) => ({
                tokenId: tokenId.toString(),
                success: false,
                errorMsg: error.message
            }));
        }
    }

    /**
     * BATCH Market sell
     */
    async marketSellBatch(tokenAmounts) {
        try {
            await this.initialize();
            
            console.log(`💰 Batch market sell: ${tokenAmounts.length} orders`);
            
            const ordersArgs = [];
            for (const { tokenId, tokenAmount } of tokenAmounts) {
                console.log(`   Creating sell order: ${tokenAmount.toFixed(2)} tokens for ${tokenId.toString().slice(0, 10)}...`);
                
                const marketOrder = await this.client.createMarketOrder({
                    tokenID: tokenId.toString(),
                    amount: tokenAmount,
                    side: Side.SELL,
                    feeRateBps: 0
                });
                
                ordersArgs.push({
                    order: marketOrder,
                    orderType: OrderType.FOK
                });
            }
            
            console.log('📝 Posting batch sell orders...');
            
            const responses = await this.client.postOrders(ordersArgs);
            
            console.log('✅ Batch sell responses:', responses);
            
            return responses.map((resp, i) => ({
                tokenId: tokenAmounts[i].tokenId.toString(),
                success: resp.success !== false,
                orderID: resp.orderID || resp.id,
                errorMsg: resp.errorMsg || resp.error || '',
                usdcReceived: resp.makingAmount ? parseFloat(resp.makingAmount) : 0
            }));
            
        } catch (error) {
            console.error('❌ Error marketSellBatch:', error.message);
            return tokenAmounts.map(({ tokenId }) => ({
                tokenId: tokenId.toString(),
                success: false,
                errorMsg: error.message,
                usdcReceived: 0
            }));
        }
    }

    /**
     * Market sell
     */
    async marketSell(tokenId, tokenAmount, negRisk = false) {
        try {
            await this.initialize();
            
            console.log(`💰 Market sell: ${tokenAmount.toFixed(2)} tokens${negRisk ? ' [NEG-RISK]' : ''}`);
            
            const sellParams = {
                tokenID: tokenId.toString(),
                amount: tokenAmount,
                side: Side.SELL,
                feeRateBps: 0
            };
            if (negRisk) sellParams.negRisk = true;
            
            const marketOrder = await this.client.createMarketOrder(sellParams);
            
            console.log('📝 Market sell order created, posting...');
            
            const response = await this.client.postOrder(marketOrder, OrderType.FOK);
            
            console.log('✅ Sell response:', response);
            
            return {
                success: response.success !== false,
                orderID: response.orderID || response.id,
                errorMsg: response.errorMsg || response.error || ''
            };
            
        } catch (error) {
            console.error('❌ Error marketSell:', error.message);
            return {
                success: false,
                errorMsg: error.message
            };
        }
    }

    /**
     * Get open orders
     */
    async getOpenOrders() {
        try {
            await this.initialize();
            
            const orders = await this.client.getOpenOrders();
            return orders;
        } catch (error) {
            console.error('❌ Error getOpenOrders:', error.message);
            return [];
        }
    }

    /**
     * Cancel an order
     */
    async cancelOrder(orderId) {
        try {
            await this.initialize();
            
            const response = await this.client.cancelOrder({ orderID: orderId });
            console.log(`✅ Order cancelled: ${orderId}`);
            return response;
        } catch (error) {
            console.error('❌ Error cancelOrder:', error.message);
            return null;
        }
    }

    /**
     * Cancel all orders
     */
    async cancelAll() {
        try {
            await this.initialize();
            
            await this.client.cancelAll();
            console.log('✅ All orders cancelled');
        } catch (error) {
            console.error('❌ Error cancelAll:', error.message);
        }
    }
}

module.exports = PolymarketClient;
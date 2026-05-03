/**
 * NonceManager - Centralized nonce management
 * Prevents nonce conflicts when sending multiple transactions sequentially
 */
class NonceManager {
    constructor(wallet) {
        this.wallet = wallet;
        this.currentNonce = null;
        this.initialized = false;
    }

    /**
     * Initialize nonce from network
     */
    async initialize() {
        if (this.initialized) {
            return;
        }
        
        console.log('🔢 Initializing nonce manager...');
        this.currentNonce = await this.wallet.getNonce();
        this.initialized = true;
        console.log(`   Starting nonce: ${this.currentNonce}`);
    }

    /**
     * Get next available nonce
     * Auto-increments for next call
     */
    async getNext() {
        if (!this.initialized) {
            await this.initialize();
        }
        
        const nonce = this.currentNonce;
        this.currentNonce++; // Reserve for next TX
        
        console.log(`   📝 Nonce allocated: ${nonce}`);
        return nonce;
    }

    /**
     * Reset nonce from network
     * Call this after errors or when uncertain about nonce state
     */
    async reset() {
        console.log('🔄 Resetting nonce from network...');
        this.currentNonce = await this.wallet.getNonce();
        this.initialized = true;
        console.log(`   Reset to: ${this.currentNonce}`);
    }

    /**
     * Manually set nonce (for recovery scenarios)
     */
    setNonce(nonce) {
        console.log(`⚙️ Manual nonce set: ${nonce}`);
        this.currentNonce = nonce;
        this.initialized = true;
    }

    /**
     * Get current nonce without incrementing
     */
    peek() {
        return this.currentNonce;
    }
}

module.exports = NonceManager;

/**
 * ResolutionQueue - FIFO queue for bundle resolutions
 * Ensures bundles are processed one at a time without race conditions
 */
class ResolutionQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.stats = {
            processed: 0,
            failed: 0,
            skipped: 0
        };
    }

    /**
     * Add bundle to resolution queue
     */
    add(bundleData) {
        // Check if already in queue
        const exists = this.queue.some(item => item.address === bundleData.address);
        if (exists) {
            console.log(`   ⚠️ Bundle ${bundleData.address.slice(0, 10)}... already in queue`);
            return false;
        }

        this.queue.push({
            ...bundleData,
            addedAt: Date.now()
        });

        console.log(`📥 Added to queue: ${bundleData.address.slice(0, 10)}... (Queue size: ${this.queue.length})`);
        return true;
    }

    /**
     * Get next bundle from queue (FIFO)
     */
    next() {
        if (this.queue.length === 0) {
            return null;
        }
        return this.queue.shift();
    }

    /**
     * Check if queue is empty
     */
    isEmpty() {
        return this.queue.length === 0;
    }

    /**
     * Get queue size
     */
    size() {
        return this.queue.length;
    }

    /**
     * Check if currently processing
     */
    isProcessing() {
        return this.processing;
    }

    /**
     * Set processing status
     */
    setProcessing(status) {
        this.processing = status;
    }

    /**
     * Remove specific bundle from queue
     */
    remove(bundleAddress) {
        const initialLength = this.queue.length;
        this.queue = this.queue.filter(item => item.address !== bundleAddress);
        const removed = initialLength - this.queue.length;
        
        if (removed > 0) {
            console.log(`🗑️ Removed ${bundleAddress.slice(0, 10)}... from queue`);
        }
        
        return removed > 0;
    }

    /**
     * Clear entire queue
     */
    clear() {
        const count = this.queue.length;
        this.queue = [];
        console.log(`🗑️ Cleared queue (${count} items removed)`);
    }

    /**
     * Get queue contents (for monitoring)
     */
    getQueue() {
        return this.queue.map(item => ({
            address: item.address,
            capital: item.capital,
            markets: item.markets.length,
            queuedFor: Math.floor((Date.now() - item.addedAt) / 1000) + 's'
        }));
    }

    /**
     * Update statistics
     */
    recordSuccess() {
        this.stats.processed++;
    }

    recordFailure() {
        this.stats.failed++;
    }

    recordSkip() {
        this.stats.skipped++;
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            queueSize: this.queue.length,
            processing: this.processing
        };
    }

    /**
     * Print queue status
     */
    printStatus() {
        console.log(`\n📊 Queue Status:`);
        console.log(`   Size: ${this.queue.length}`);
        console.log(`   Processing: ${this.processing}`);
        console.log(`   Processed: ${this.stats.processed}`);
        console.log(`   Failed: ${this.stats.failed}`);
        console.log(`   Skipped: ${this.stats.skipped}`);
        
        if (this.queue.length > 0) {
            console.log(`   Next bundles:`);
            this.queue.slice(0, 3).forEach((item, i) => {
                console.log(`      ${i + 1}. ${item.address.slice(0, 10)}... (${item.markets.length} markets)`);
            });
        }
    }
}

module.exports = ResolutionQueue;

/**
 * ⚡ Ultra High-Speed In-Memory Cache Service (Zero Latency < 1ms)
 * Provides lightning-fast responses for bootstrap, invoices, clients, reports, and settings.
 * Automatically handles TTL and selective invalidation on write mutations.
 */

class MemoryCacheService {
  constructor(defaultTtlSeconds = 300) {
    this.store = new Map();
    this.defaultTtl = defaultTtlSeconds * 1000;
  }

  get(key) {
    const item = this.store.get(key);
    if (!item) return null;

    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return item.value;
  }

  set(key, value, ttlSeconds) {
    const ttl = (ttlSeconds !== undefined ? ttlSeconds * 1000 : this.defaultTtl);
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttl
    });
    return value;
  }

  del(key) {
    this.store.delete(key);
  }

  delByPrefix(prefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  clear() {
    this.store.clear();
  }

  size() {
    return this.store.size;
  }
}

export const memoryCache = new MemoryCacheService(300); // 5 minutes default TTL

export const CacheKeys = {
  BOOTSTRAP: 'bootstrap:state',
  BUSINESSES: 'businesses:all',
  CUSTOMERS: 'customers:all',
  INVOICES: 'invoices:all',
  REVERSALS: 'reversals:all',
  SETTINGS: 'settings:current',
  REPORT_PREFIX: 'report:'
};

// Invalidation helpers to ensure instant data synchronization
export function invalidateBootstrap() {
  memoryCache.del(CacheKeys.BOOTSTRAP);
}

export function invalidateInvoiceCaches() {
  memoryCache.del(CacheKeys.BOOTSTRAP);
  memoryCache.del(CacheKeys.INVOICES);
  memoryCache.del(CacheKeys.REVERSALS);
  memoryCache.delByPrefix(CacheKeys.REPORT_PREFIX);
}

export function invalidateClientCaches() {
  memoryCache.del(CacheKeys.BOOTSTRAP);
  memoryCache.del(CacheKeys.BUSINESSES);
  memoryCache.del(CacheKeys.CUSTOMERS);
  memoryCache.delByPrefix(CacheKeys.REPORT_PREFIX);
}

export function invalidateSettingsCaches() {
  memoryCache.del(CacheKeys.BOOTSTRAP);
  memoryCache.del(CacheKeys.SETTINGS);
}

export function invalidateAllCaches() {
  memoryCache.clear();
}

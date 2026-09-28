import { query } from '../config/db.js';
import { memoryCache, CacheKeys } from '../services/cacheService.js';

export const reversalController = {
  getReversals: async (req, res, next) => {
    try {
      const cached = memoryCache.get(CacheKeys.REVERSALS);
      if (cached) return res.json(cached);

      const result = await query('SELECT * FROM reversals ORDER BY created_at DESC');
      const reversals = result.rows.map(r => ({
        id: r.id,
        invoiceId: r.invoice_id,
        invoiceNo: r.invoice_no,
        businessId: r.business_id,
        customerId: r.customer_id,
        amount: Number(r.amount || 0),
        method: r.method,
        paymentDate: r.payment_date,
        reversedAt: r.reversed_at,
        createdAt: r.created_at
      }));
      memoryCache.set(CacheKeys.REVERSALS, reversals, 300);
      res.json(reversals);
    } catch (err) {
      next(err);
    }
  }
};

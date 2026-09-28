import { query } from '../config/db.js';
import { memoryCache, CacheKeys } from '../services/cacheService.js';

export const reportController = {
  getSummary: async (req, res, next) => {
    try {
      const { businessId, month, year } = req.query;

      const cacheKey = `${CacheKeys.REPORT_PREFIX}${businessId || 'all'}:${month || 'all'}:${year || 'all'}`;
      const cached = memoryCache.get(cacheKey);
      if (cached) return res.json(cached);

      let whereClauses = [];
      let params = [];

      if (businessId) {
        params.push(businessId);
        whereClauses.push(`business_id = $${params.length}`);
      }
      if (month) {
        params.push(month);
        whereClauses.push(`month = $${params.length}`);
      }
      if (year) {
        params.push(parseInt(year, 10));
        whereClauses.push(`year = $${params.length}`);
      }

      const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

      const statsQuery = `
        SELECT
          COUNT(*) as total_invoices,
          COALESCE(SUM(total), 0) as total_billed,
          COALESCE(SUM(paid), 0) as total_collected,
          COALESCE(SUM(balance), 0) as total_outstanding,
          COUNT(CASE WHEN status = 'Paid' THEN 1 END) as count_paid,
          COUNT(CASE WHEN status = 'Partial' THEN 1 END) as count_partial,
          COUNT(CASE WHEN status = 'Unpaid' THEN 1 END) as count_unpaid
        FROM invoices
        ${whereSql}
      `;

      const statsRes = await query(statsQuery, params);
      const stats = statsRes.rows[0];

      const reportData = {
        totalInvoices: parseInt(stats.total_invoices, 10),
        totalBilled: Number(stats.total_billed),
        totalCollected: Number(stats.total_collected),
        totalOutstanding: Number(stats.total_outstanding),
        countPaid: parseInt(stats.count_paid, 10),
        countPartial: parseInt(stats.count_partial, 10),
        countUnpaid: parseInt(stats.count_unpaid, 10)
      };

      memoryCache.set(cacheKey, reportData, 300);
      res.json(reportData);
    } catch (err) {
      next(err);
    }
  }
};

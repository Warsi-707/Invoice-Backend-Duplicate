import { query } from '../config/db.js';
import { memoryCache, CacheKeys } from '../services/cacheService.js';

export const bootstrapController = {
  getBootstrapState: async (req, res, next) => {
    try {
      // ⚡ 0-Delay In-Memory Cache Check (< 1ms)
      const cachedState = memoryCache.get(CacheKeys.BOOTSTRAP);
      if (cachedState) {
        return res.json(cachedState);
      }

      const [settingsRes, businessesRes, customersRes, invoicesRes, reversalsRes] = await Promise.all([
        query('SELECT * FROM settings LIMIT 1'),
        query('SELECT * FROM businesses ORDER BY created_at ASC'),
        query('SELECT * FROM customers ORDER BY created_at ASC'),
        query('SELECT * FROM invoices ORDER BY created_at DESC'),
        query('SELECT * FROM reversals ORDER BY created_at DESC')
      ]);

      const settingsRow = settingsRes.rows[0] || {};

      const state = {
        settings: {
          admin: settingsRow.admin || 'Administrator',
          currency: settingsRow.currency || 'PKR',
          dueDays: settingsRow.due_days ?? 0,
          footerNote: settingsRow.footer_note || 'Thank you for your business.',
          proposalData: settingsRow.proposal_data || {},
          whatsappSettings: settingsRow.whatsapp_settings || { initialDelay: 2, messageDelay: 3 }
        },
        businesses: businessesRes.rows.map(b => ({
          id: b.id,
          name: b.name,
          category: b.category,
          phone: b.phone,
          whatsapp: b.whatsapp,
          address: b.address,
          prefix: b.prefix,
          currency: b.currency
        })),
        customers: customersRes.rows.map(c => ({
          id: c.id,
          businessId: c.business_id,
          name: c.name,
          phone: c.phone,
          whatsapp: c.whatsapp,
          address: c.address,
          items: c.items || []
        })),
        invoices: invoicesRes.rows.map(i => ({
          id: i.id,
          invoiceNo: i.invoice_no,
          businessId: i.business_id,
          customerId: i.customer_id,
          month: i.month,
          year: i.year,
          date: i.date,
          dueDate: i.due_date,
          subtotal: Number(i.subtotal || 0),
          previousDues: Number(i.previous_dues || 0),
          previousDuesMonths: i.previous_dues_months || '',
          discount: Number(i.discount || 0),
          lateFee: Number(i.late_fee || 0),
          total: Number(i.total || 0),
          paid: Number(i.paid || 0),
          balance: Number(i.balance || 0),
          status: i.status,
          items: i.items || [],
          payments: i.payments || [],
          createdAt: i.created_at
        })),
        reversals: reversalsRes.rows.map(r => ({
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
        }))
      };

      // Cache state in memory for subsequent instant 0ms responses
      memoryCache.set(CacheKeys.BOOTSTRAP, state, 300);

      res.json(state);
    } catch (err) {
      next(err);
    }
  }
};

import { query } from '../config/db.js';
import { memoryCache, CacheKeys, invalidateSettingsCaches, invalidateAllCaches } from '../services/cacheService.js';

export const settingsController = {
  getSettings: async (req, res, next) => {
    try {
      const cached = memoryCache.get(CacheKeys.SETTINGS);
      if (cached) return res.json(cached);

      const result = await query('SELECT * FROM settings LIMIT 1');
      const row = result.rows[0] || {
        admin: 'Administrator',
        password: 'admin123',
        currency: 'PKR',
        due_days: 0,
        footer_note: 'Thank you for your business.',
        proposal_data: {},
        whatsapp_settings: { initialDelay: 2, messageDelay: 3 }
      };

      const settingsData = {
        admin: row.admin || 'Administrator',
        password: row.password || 'admin123',
        currency: row.currency || 'PKR',
        dueDays: row.due_days ?? 0,
        footerNote: row.footer_note || 'Thank you for your business.',
        proposalData: row.proposal_data || {},
        whatsappSettings: row.whatsapp_settings || { initialDelay: 2, messageDelay: 3 }
      };

      memoryCache.set(CacheKeys.SETTINGS, settingsData, 300);
      res.json(settingsData);
    } catch (err) {
      next(err);
    }
  },

  updateSettings: async (req, res, next) => {
    try {
      const {
        admin = 'Administrator',
        password,
        currency = 'PKR',
        dueDays = 0,
        footerNote = 'Thank you for your business.',
        proposalData = {},
        whatsappSettings = { initialDelay: 2, messageDelay: 3 }
      } = req.body;

      const check = await query('SELECT id, password, proposal_data, whatsapp_settings FROM settings LIMIT 1');
      let result;
      const targetPass = (password && password.trim()) ? password.trim() : (check.rows[0]?.password || 'admin123');
      const targetProposal = typeof proposalData === 'object' && proposalData !== null
        ? JSON.stringify(proposalData)
        : JSON.stringify(check.rows[0]?.proposal_data || {});
      const targetWhatsappSettings = typeof whatsappSettings === 'object' && whatsappSettings !== null
        ? JSON.stringify(whatsappSettings)
        : JSON.stringify(check.rows[0]?.whatsapp_settings || { initialDelay: 2, messageDelay: 3 });

      if (check.rows.length === 0) {
        result = await query(
          `INSERT INTO settings (admin, password, currency, due_days, footer_note, proposal_data, whatsapp_settings)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [admin.trim(), targetPass, currency.trim(), parseInt(dueDays, 10) || 0, footerNote.trim(), targetProposal, targetWhatsappSettings]
        );
      } else {
        result = await query(
          `UPDATE settings
           SET admin = $1, password = $2, currency = $3, due_days = $4, footer_note = $5, proposal_data = $6, whatsapp_settings = $7, updated_at = CURRENT_TIMESTAMP
           WHERE id = $8 RETURNING *`,
          [admin.trim(), targetPass, currency.trim(), parseInt(dueDays, 10) || 0, footerNote.trim(), targetProposal, targetWhatsappSettings, check.rows[0].id]
        );
      }

      const row = result.rows[0];
      invalidateSettingsCaches();

      res.json({
        success: true,
        settings: {
          admin: row.admin,
          password: row.password,
          currency: row.currency,
          dueDays: row.due_days,
          footerNote: row.footer_note,
          proposalData: row.proposal_data || {},
          whatsappSettings: row.whatsapp_settings || { initialDelay: 2, messageDelay: 3 }
        }
      });
    } catch (err) {
      next(err);
    }
  },

  backupData: async (req, res, next) => {
    try {
      const settingsRes = await query('SELECT * FROM settings LIMIT 1');
      const businessesRes = await query('SELECT * FROM businesses ORDER BY created_at ASC');
      const customersRes = await query('SELECT * FROM customers ORDER BY created_at ASC');
      const invoicesRes = await query('SELECT * FROM invoices ORDER BY created_at DESC');
      const reversalsRes = await query('SELECT * FROM reversals ORDER BY created_at DESC');

      const settingsRow = settingsRes.rows[0] || {};

      const backup = {
        session: {
          isAuthenticated: true,
          username: settingsRow.admin || 'Admin'
        },
        settings: {
          admin: settingsRow.admin || 'Admin',
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

      res.json(backup);
    } catch (err) {
      next(err);
    }
  },

  restoreData: async (req, res, next) => {
    try {
      const data = req.body;
      if (!data || !data.settings) {
        return res.status(400).json({ message: 'Invalid backup format.' });
      }

      // Clear existing records
      await query('DELETE FROM reversals');
      await query('DELETE FROM invoices');
      await query('DELETE FROM customers');
      await query('DELETE FROM businesses');

      // Update settings
      const admin = data.settings.admin || 'Admin';
      const currency = data.settings.currency || 'PKR';
      const dueDays = data.settings.dueDays ?? 0;
      const footerNote = data.settings.footerNote || 'Thank you for your business.';
      const proposalData = JSON.stringify(data.settings.proposalData || {});
      const whatsappSettings = JSON.stringify(data.settings.whatsappSettings || { initialDelay: 2, messageDelay: 3 });

      const check = await query('SELECT id FROM settings LIMIT 1');
      if (check.rows.length === 0) {
        await query(
          'INSERT INTO settings (admin, currency, due_days, footer_note, proposal_data, whatsapp_settings) VALUES ($1, $2, $3, $4, $5, $6)',
          [admin, currency, dueDays, footerNote, proposalData, whatsappSettings]
        );
      } else {
        await query(
          'UPDATE settings SET admin = $1, currency = $2, due_days = $3, footer_note = $4, proposal_data = $5, whatsapp_settings = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $7',
          [admin, currency, dueDays, footerNote, proposalData, whatsappSettings, check.rows[0].id]
        );
      }

      // Restore businesses
      if (Array.isArray(data.businesses)) {
        for (const b of data.businesses) {
          await query(
            `INSERT INTO businesses (id, name, category, phone, whatsapp, address, prefix, currency)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO UPDATE SET
               name = EXCLUDED.name,
               category = EXCLUDED.category,
               phone = EXCLUDED.phone,
               whatsapp = EXCLUDED.whatsapp,
               address = EXCLUDED.address,
               prefix = EXCLUDED.prefix,
               currency = EXCLUDED.currency`,
            [b.id, b.name, b.category || '', b.phone || '', b.whatsapp || '', b.address || '', b.prefix || 'INV', b.currency || 'PKR']
          );
        }
      }

      // Restore customers
      if (Array.isArray(data.customers)) {
        for (const c of data.customers) {
          await query(
            `INSERT INTO customers (id, business_id, name, phone, whatsapp, address, items)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO UPDATE SET
               business_id = EXCLUDED.business_id,
               name = EXCLUDED.name,
               phone = EXCLUDED.phone,
               whatsapp = EXCLUDED.whatsapp,
               address = EXCLUDED.address,
               items = EXCLUDED.items`,
            [c.id, c.businessId, c.name, c.phone || '', c.whatsapp || '', c.address || '', JSON.stringify(c.items || [])]
          );
        }
      }

      // Restore invoices
      if (Array.isArray(data.invoices)) {
        for (const inv of data.invoices) {
          await query(
            `INSERT INTO invoices (
              id, invoice_no, business_id, customer_id, month, year, date, due_date,
              subtotal, discount, late_fee, total, paid, balance, status, items, payments
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            ON CONFLICT (id) DO UPDATE SET
              invoice_no = EXCLUDED.invoice_no,
              business_id = EXCLUDED.business_id,
              customer_id = EXCLUDED.customer_id,
              month = EXCLUDED.month,
              year = EXCLUDED.year,
              date = EXCLUDED.date,
              due_date = EXCLUDED.due_date,
              subtotal = EXCLUDED.subtotal,
              discount = EXCLUDED.discount,
              late_fee = EXCLUDED.late_fee,
              total = EXCLUDED.total,
              paid = EXCLUDED.paid,
              balance = EXCLUDED.balance,
              status = EXCLUDED.status,
              items = EXCLUDED.items,
              payments = EXCLUDED.payments`,
            [
              inv.id,
              inv.invoiceNo,
              inv.businessId,
              inv.customerId,
              inv.month,
              parseInt(inv.year, 10),
              inv.date,
              inv.dueDate,
              Number(inv.subtotal || 0),
              Number(inv.discount || 0),
              Number(inv.lateFee || 0),
              Number(inv.total || 0),
              Number(inv.paid || 0),
              Number(inv.balance || 0),
              inv.status || 'Unpaid',
              JSON.stringify(inv.items || []),
              JSON.stringify(inv.payments || [])
            ]
          );
        }
      }

      // Restore reversals
      if (Array.isArray(data.reversals)) {
        for (const r of data.reversals) {
          await query(
            `INSERT INTO reversals (
              id, invoice_id, invoice_no, business_id, customer_id, amount, method, payment_date, reversed_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (id) DO NOTHING`,
            [
              r.id,
              r.invoiceId,
              r.invoiceNo,
              r.businessId,
              r.customerId,
              Number(r.amount || 0),
              r.method || 'Cash',
              r.paymentDate || '',
              r.reversedAt || ''
            ]
          );
        }
      }

      invalidateAllCaches();
      res.json({ success: true, message: 'Data restored successfully.' });
    } catch (err) {
      next(err);
    }
  },

  resetAllData: async (req, res, next) => {
    try {
      await query('DELETE FROM reversals');
      await query('DELETE FROM invoices');
      await query('DELETE FROM customers');
      await query('DELETE FROM businesses');
      await query(`
        UPDATE settings
        SET admin = 'Admin', currency = 'PKR', due_days = 0, footer_note = 'Thank you for your business.', updated_at = CURRENT_TIMESTAMP
      `);
      invalidateAllCaches();
      res.json({ success: true, message: 'All data cleared successfully.' });
    } catch (err) {
      next(err);
    }
  }
};

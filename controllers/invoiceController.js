import { query } from '../config/db.js';
import { memoryCache, CacheKeys, invalidateInvoiceCaches, invalidateClientCaches } from '../services/cacheService.js';

function mapInvoice(row) {
  return {
    id: row.id,
    invoiceNo: row.invoice_no,
    businessId: row.business_id,
    customerId: row.customer_id,
    month: row.month,
    year: row.year,
    date: row.date,
    dueDate: row.due_date,
    subtotal: Number(row.subtotal || 0),
    previousDues: Number(row.previous_dues || 0),
    previousDuesMonths: row.previous_dues_months || '',
    discount: Number(row.discount || 0),
    lateFee: Number(row.late_fee || 0),
    total: Number(row.total || 0),
    paid: Number(row.paid || 0),
    balance: Number(row.balance || 0),
    status: row.status,
    items: row.items || [],
    payments: row.payments || [],
    milestoneId: row.milestone_id || null,
    projectId: row.project_id || null,
    createdAt: row.created_at
  };
}

export const invoiceController = {
  getInvoices: async (req, res, next) => {
    try {
      const cached = memoryCache.get(CacheKeys.INVOICES);
      if (cached) return res.json(cached);

      const result = await query('SELECT * FROM invoices ORDER BY created_at DESC');
      const invoices = result.rows.map(mapInvoice);
      memoryCache.set(CacheKeys.INVOICES, invoices, 300);
      res.json(invoices);
    } catch (err) {
      next(err);
    }
  },

  createInvoice: async (req, res, next) => {
    try {
      const {
        businessId,
        customerId,
        month,
        year,
        date,
        dueDate,
        subtotal = 0,
        previousDues = 0,
        previousDuesMonths = '',
        discount = 0,
        lateFee = 0,
        total,
        items = [],
        milestoneId = null,
        projectId = null
      } = req.body;

      if (!businessId || !customerId || total === undefined) {
        return res.status(400).json({ message: 'businessId, customerId and total are required.' });
      }

      // Check for duplicate invoice
      if (milestoneId) {
        const dupCheck = await query(
          `SELECT id, invoice_no FROM invoices WHERE milestone_id = $1 LIMIT 1`,
          [milestoneId]
        );
        if (dupCheck.rows.length > 0) {
          return res.status(409).json({
            duplicate: true,
            message: `Invoice (${dupCheck.rows[0].invoice_no}) already generated for this milestone.`
          });
        }
      } else {
        // Check for duplicate invoice (same business, customer, month, year)
        const dupCheck = await query(
          `SELECT id FROM invoices
           WHERE business_id = $1 AND customer_id = $2 AND month = $3 AND year = $4 LIMIT 1`,
          [businessId, customerId, month, parseInt(year, 10)]
        );

        if (dupCheck.rows.length > 0) {
          return res.status(409).json({ duplicate: true, message: 'Invoice already exists for this client and month.' });
        }
      }

      // Generate invoice number
      const bizRes = await query('SELECT prefix FROM businesses WHERE id = $1', [businessId]);
      const prefix = bizRes.rows[0]?.prefix || 'INV';
      const countRes = await query('SELECT COUNT(*) FROM invoices WHERE business_id = $1', [businessId]);
      const nextSeq = parseInt(countRes.rows[0].count, 10) + 1;
      const invoiceNo = `${prefix}-${String(nextSeq).padStart(4, '0')}`;

      const id = `inv_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const numTotal = Number(total || 0);

      const insertRes = await query(
        `INSERT INTO invoices (
          id, invoice_no, business_id, customer_id, month, year, date, due_date,
          subtotal, previous_dues, previous_dues_months, discount, late_fee, total, paid, balance, status, items, payments, milestone_id, project_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
        RETURNING *`,
        [
          id,
          invoiceNo,
          businessId,
          customerId,
          month,
          parseInt(year, 10),
          date,
          dueDate,
          Number(subtotal || 0),
          Number(previousDues || 0),
          String(previousDuesMonths || ''),
          Number(discount || 0),
          Number(lateFee || 0),
          numTotal,
          0,
          numTotal,
          'Unpaid',
          JSON.stringify(items || []),
          JSON.stringify([]),
          milestoneId,
          projectId
        ]
      );

      // If this was a milestone invoice, update the milestone reference in customer's items
      if (milestoneId) {
        try {
          const custRes = await query('SELECT items FROM customers WHERE id = $1', [customerId]);
          if (custRes.rows.length > 0) {
            let custItems = custRes.rows[0].items || [];
            let modified = false;
            custItems = custItems.map((it) => {
              if (Array.isArray(it.milestones)) {
                const updatedMs = it.milestones.map((ms) => {
                  if (String(ms.id) === String(milestoneId)) {
                    modified = true;
                    return {
                      ...ms,
                      invoiceId: id,
                      invoiceNo: invoiceNo,
                      status: 'Invoiced'
                    };
                  }
                  return ms;
                });
                return { ...it, milestones: updatedMs };
              }
              return it;
            });

            if (modified) {
              await query(
                'UPDATE customers SET items = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [JSON.stringify(custItems), customerId]
              );
              invalidateClientCaches();
            }
          }
        } catch (mErr) {
          console.error('Error updating customer milestone record:', mErr);
        }
      }

      invalidateInvoiceCaches();

      res.status(201).json({ success: true, invoice: mapInvoice(insertRes.rows[0]) });
    } catch (err) {
      next(err);
    }
  },

  markInvoicePaid: async (req, res, next) => {
    try {
      const { id } = req.params;
      const { receivedBy = 'Admin', method = 'Cash', date } = req.body;

      const invRes = await query('SELECT * FROM invoices WHERE id = $1', [id]);
      if (invRes.rows.length === 0) {
        return res.status(404).json({ message: 'Invoice not found.' });
      }

      const inv = invRes.rows[0];
      const balance = Number(inv.balance || 0);
      const total = Number(inv.total || 0);

      if (balance <= 0) {
        return res.json({ success: true, invoice: mapInvoice(inv) });
      }

      const nowTime = new Date().toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });

      const todayStr = new Date().toISOString().split('T')[0];
      const itemTitle = (inv.items && inv.items[0]?.name) || `Monthly Fee - ${inv.month} ${inv.year}`;

      const payment = {
        id: `p_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        amount: balance,
        method: method || 'Cash',
        date: date || todayStr,
        time: nowTime,
        receivedBy,
        title: itemTitle,
        lateFee: Number(inv.late_fee || 0),
        discount: Number(inv.discount || 0),
        status: 'Paid',
        kind: 'full'
      };

      const existingPayments = inv.payments || [];
      const updatedPayments = [...existingPayments, payment];

      const updateRes = await query(
        `UPDATE invoices
         SET paid = $1, balance = 0, status = 'Paid', payments = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 RETURNING *`,
        [total, JSON.stringify(updatedPayments), id]
      );

      invalidateInvoiceCaches();

      res.json({ success: true, invoice: mapInvoice(updateRes.rows[0]) });
    } catch (err) {
      next(err);
    }
  },

  takePartialPayment: async (req, res, next) => {
    try {
      const { id } = req.params;
      const { amount, method = 'Cash', date, receivedBy = 'Admin' } = req.body;

      const pAmount = Number(amount || 0);
      if (pAmount <= 0) {
        return res.status(400).json({ message: 'Payment amount must be greater than zero.' });
      }

      const invRes = await query('SELECT * FROM invoices WHERE id = $1', [id]);
      if (invRes.rows.length === 0) {
        return res.status(404).json({ message: 'Invoice not found.' });
      }

      const inv = invRes.rows[0];
      const currentBalance = Number(inv.balance || 0);
      const total = Number(inv.total || 0);

      if (pAmount > currentBalance) {
        return res.status(400).json({ message: 'Payment amount cannot exceed outstanding balance.' });
      }

      const nowTime = new Date().toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });

      const paymentDate = date || new Date().toISOString().split('T')[0];
      const itemTitle = (inv.items && inv.items[0]?.name) || `Monthly Fee - ${inv.month} ${inv.year}`;

      const payment = {
        id: `p_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        amount: pAmount,
        method: method || 'Cash',
        date: paymentDate,
        time: nowTime,
        receivedBy,
        title: itemTitle,
        lateFee: 0,
        discount: 0,
        status: 'Partial',
        kind: 'partial'
      };

      const existingPayments = inv.payments || [];
      const updatedPayments = [...existingPayments, payment];
      const newPaid = updatedPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
      const newBalance = Math.max(0, total - newPaid);
      const newStatus = newBalance <= 0 ? 'Paid' : newPaid > 0 ? 'Partial' : 'Unpaid';

      const updateRes = await query(
        `UPDATE invoices
         SET paid = $1, balance = $2, status = $3, payments = $4, updated_at = CURRENT_TIMESTAMP
         WHERE id = $5 RETURNING *`,
        [newPaid, newBalance, newStatus, JSON.stringify(updatedPayments), id]
      );

      invalidateInvoiceCaches();

      res.json({ success: true, invoice: mapInvoice(updateRes.rows[0]) });
    } catch (err) {
      next(err);
    }
  },

  reversePayment: async (req, res, next) => {
    try {
      const { id } = req.params;

      const invRes = await query('SELECT * FROM invoices WHERE id = $1', [id]);
      if (invRes.rows.length === 0) {
        return res.status(404).json({ message: 'Invoice not found.' });
      }

      const inv = invRes.rows[0];
      const payments = inv.payments || [];

      if (payments.length === 0) {
        return res.status(400).json({ message: 'No payments found on this invoice to reverse.' });
      }

      const paymentsCopy = [...payments];
      const reversedPayment = paymentsCopy.pop();

      const total = Number(inv.total || 0);
      const newPaid = paymentsCopy.reduce((sum, p) => sum + Number(p.amount || 0), 0);
      const newBalance = Math.max(0, total - newPaid);
      const newStatus = newPaid <= 0 ? 'Unpaid' : newBalance <= 0 ? 'Paid' : 'Partial';

      const reversalId = `rev_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const reversedAtStr = new Date().toLocaleString();

      // Insert reversal record
      const revInsert = await query(
        `INSERT INTO reversals (
          id, invoice_id, invoice_no, business_id, customer_id, amount, method, payment_date, reversed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          reversalId,
          inv.id,
          inv.invoice_no,
          inv.business_id,
          inv.customer_id,
          Number(reversedPayment.amount || 0),
          reversedPayment.method || 'Cash',
          reversedPayment.date || '',
          reversedAtStr
        ]
      );

      // Update invoice
      const updateRes = await query(
        `UPDATE invoices
         SET paid = $1, balance = $2, status = $3, payments = $4, updated_at = CURRENT_TIMESTAMP
         WHERE id = $5 RETURNING *`,
        [newPaid, newBalance, newStatus, JSON.stringify(paymentsCopy), id]
      );

      const revRow = revInsert.rows[0];
      const reversalRecord = {
        id: revRow.id,
        invoiceId: revRow.invoice_id,
        invoiceNo: revRow.invoice_no,
        businessId: revRow.business_id,
        customerId: revRow.customer_id,
        amount: Number(revRow.amount || 0),
        method: revRow.method,
        paymentDate: revRow.payment_date,
        reversedAt: revRow.reversed_at
      };

      invalidateInvoiceCaches();

      res.json({
        success: true,
        invoice: mapInvoice(updateRes.rows[0]),
        reversal: reversalRecord
      });
    } catch (err) {
      next(err);
    }
  },

  deleteInvoice: async (req, res, next) => {
    try {
      const { id } = req.params;
      const invRes = await query('SELECT customer_id, milestone_id FROM invoices WHERE id = $1', [id]);
      if (invRes.rows.length > 0 && invRes.rows[0].milestone_id) {
        const { customer_id: customerId, milestone_id: milestoneId } = invRes.rows[0];
        try {
          const custRes = await query('SELECT items FROM customers WHERE id = $1', [customerId]);
          if (custRes.rows.length > 0) {
            let custItems = custRes.rows[0].items || [];
            let modified = false;
            custItems = custItems.map((it) => {
              if (Array.isArray(it.milestones)) {
                const updatedMs = it.milestones.map((ms) => {
                  if (String(ms.id) === String(milestoneId)) {
                    modified = true;
                    return {
                      ...ms,
                      invoiceId: null,
                      invoiceNo: null,
                      status: 'Ready to Invoice'
                    };
                  }
                  return ms;
                });
                return { ...it, milestones: updatedMs };
              }
              return it;
            });
            if (modified) {
              await query(
                'UPDATE customers SET items = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [JSON.stringify(custItems), customerId]
              );
              invalidateClientCaches();
            }
          }
        } catch (e) {
          console.error('Error resetting milestone on invoice delete:', e);
        }
      }

      await query('DELETE FROM invoices WHERE id = $1', [id]);
      invalidateInvoiceCaches();
      res.json({ success: true, id });
    } catch (err) {
      next(err);
    }
  }
};

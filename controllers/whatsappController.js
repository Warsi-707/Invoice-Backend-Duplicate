import {
  getWhatsAppStatus,
  initWhatsApp,
  logoutWhatsApp,
  requestWhatsAppPairingCode,
  sendWhatsAppMessage,
  sendInvoiceWhatsApp,
  sendDocumentWhatsApp
} from '../services/whatsappService.js';
import { query } from '../config/db.js';

export const whatsappController = {
  getStatus: async (req, res, next) => {
    try {
      const status = getWhatsAppStatus();
      res.json(status);
    } catch (err) {
      next(err);
    }
  },

  connect: async (req, res, next) => {
    try {
      const { force = false } = req.body || {};
      const status = await initWhatsApp(Boolean(force));
      res.json(status);
    } catch (err) {
      next(err);
    }
  },

  requestPairingCode: async (req, res, next) => {
    try {
      const { phone } = req.body || {};
      const result = await requestWhatsAppPairingCode(phone);
      res.json(result);
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  },

  logout: async (req, res, next) => {
    try {
      const result = await logoutWhatsApp();
      res.json(result);
    } catch (err) {
      next(err);
    }
  },

  sendInvoice: async (req, res, next) => {
    try {
      const { invoiceId, toPhone, invoiceData, businessData, customerData, htmlContent } = req.body;

      let invoice = invoiceData;
      let business = businessData;
      let customer = customerData;

      // If invoiceId is provided and full objects aren't passed, fetch from DB
      if (invoiceId && (!invoice || !business || !customer)) {
        const invRes = await query('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
        if (invRes.rows.length === 0) {
          return res.status(404).json({ message: 'Invoice not found' });
        }
        const row = invRes.rows[0];
        invoice = {
          id: row.id,
          invoiceNo: row.invoice_no,
          businessId: row.business_id,
          customerId: row.customer_id,
          month: row.month,
          year: row.year,
          date: row.date,
          dueDate: row.due_date,
          subtotal: Number(row.subtotal),
          previousDues: Number(row.previous_dues || 0),
          previousDuesMonths: row.previous_dues_months || '',
          discount: Number(row.discount),
          lateFee: Number(row.late_fee),
          total: Number(row.total),
          paid: Number(row.paid),
          balance: Number(row.balance),
          status: row.status,
          items: row.items || []
        };

        const bizRes = await query('SELECT * FROM businesses WHERE id = $1', [invoice.businessId]);
        business = bizRes.rows[0] || {};

        const custRes = await query('SELECT * FROM customers WHERE id = $1', [invoice.customerId]);
        customer = custRes.rows[0] || {};
      }

      const sendResult = await sendInvoiceWhatsApp({
        toPhone,
        invoice,
        business,
        customer,
        htmlContent
      });

      res.json({
        success: true,
        message: 'Invoice PDF successfully sent via WhatsApp!',
        details: sendResult
      });
    } catch (err) {
      console.error('WhatsApp send invoice error:', err.message);
      res.status(400).json({ error: err.message });
    }
  },

  sendText: async (req, res, next) => {
    try {
      const { phone, message } = req.body;
      if (!phone || !message) {
        return res.status(400).json({ message: 'Phone number and message are required.' });
      }

      const result = await sendWhatsAppMessage(phone, message);
      res.json({ success: true, message: 'Message sent successfully!', result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  },

  sendDocument: async (req, res, next) => {
    try {
      const { phone, base64Data, fileName, mimeType, caption } = req.body;
      if (!phone || !base64Data || !fileName) {
        return res.status(400).json({ message: 'phone, base64Data, and fileName are required.' });
      }
      const result = await sendDocumentWhatsApp(phone, base64Data, fileName, mimeType || 'application/pdf', caption || '');
      res.json({ success: true, message: 'Document sent via WhatsApp!', result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
};

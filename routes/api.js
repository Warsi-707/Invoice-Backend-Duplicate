import express from 'express';
import { authController } from '../controllers/authController.js';
import { businessCustomerController } from '../controllers/businessCustomerController.js';
import { invoiceController } from '../controllers/invoiceController.js';
import { reversalController } from '../controllers/reversalController.js';
import { reportController } from '../controllers/reportController.js';
import { settingsController } from '../controllers/settingsController.js';
import { bootstrapController } from '../controllers/bootstrapController.js';
import { whatsappController } from '../controllers/whatsappController.js';
import { pdfController } from '../controllers/pdfController.js';
import { authenticateToken } from '../middleware/authMiddleware.js';

const router = express.Router();

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Bootstrap full application state
router.get('/bootstrap', bootstrapController.getBootstrapState);

// Auth
router.post('/auth/login', authController.login);

// PDF generation (backend, uses system Chrome via puppeteer)
router.post('/pdf/generate', pdfController.generate);

// WhatsApp Status, Connect, Pairing, Sending & Logout
router.get('/whatsapp/status', whatsappController.getStatus);
router.post('/whatsapp/connect', whatsappController.connect);
router.post('/whatsapp/pairing-code', whatsappController.requestPairingCode);
router.post('/whatsapp/logout', whatsappController.logout);
router.post('/whatsapp/send-invoice', whatsappController.sendInvoice);
router.post('/whatsapp/send-text', whatsappController.sendText);
router.post('/whatsapp/send-document', whatsappController.sendDocument);

// All application data and account routes require a valid JWT.
router.use(authenticateToken);

router.post('/auth/logout', authController.logout);
router.get('/auth/me', authController.getMe);

// Businesses & Customers
router.get('/businesses', businessCustomerController.getBusinesses);
router.get('/customers', businessCustomerController.getCustomers);
router.post('/businesses-and-customers', businessCustomerController.addBusinessAndCustomer);
router.put('/businesses-and-customers', businessCustomerController.updateBusinessAndCustomer);
router.delete('/customers/:id', businessCustomerController.deleteCustomer);

// Invoices
router.get('/invoices', invoiceController.getInvoices);
router.post('/invoices', invoiceController.createInvoice);
router.post('/invoices/:id/pay', invoiceController.markInvoicePaid);
router.post('/invoices/:id/partial-payment', invoiceController.takePartialPayment);
router.post('/invoices/:id/reverse', invoiceController.reversePayment);
router.delete('/invoices/:id', invoiceController.deleteInvoice);

// Reversals
router.get('/reversals', reversalController.getReversals);

// Reports
router.get('/reports/summary', reportController.getSummary);

// Settings & Maintenance
router.get('/settings', settingsController.getSettings);
router.put('/settings', settingsController.updateSettings);
router.get('/settings/backup', settingsController.backupData);
router.post('/settings/restore', settingsController.restoreData);
router.post('/settings/reset', settingsController.resetAllData);

export default router;

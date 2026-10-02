import { processDueSubscriptions } from '../services/subscriptionService.js';
import { query } from '../config/db.js';

export const subscriptionController = {
  processSubscriptions: async (req, res, next) => {
    try {
      const result = await processDueSubscriptions();
      res.json({
        success: true,
        message: `Processed ${result.activeSubscriptions} active subscriptions. Generated ${result.generatedInvoices.length} invoices.`,
        ...result
      });
    } catch (err) {
      next(err);
    }
  },

  getSubscriptionsSummary: async (req, res, next) => {
    try {
      const customersRes = await query('SELECT * FROM customers ORDER BY created_at DESC');
      const businessesRes = await query('SELECT * FROM businesses');
      const businessesMap = new Map(businessesRes.rows.map(b => [b.id, b]));

      const subscriptions = [];

      for (const cust of customersRes.rows) {
        const items = Array.isArray(cust.items) ? cust.items : [];
        const business = businessesMap.get(cust.business_id) || {};

        for (const item of items) {
          if (item.billingType === 'subscription') {
            subscriptions.push({
              itemId: item.id,
              customerId: cust.id,
              customerName: cust.name,
              customerPhone: cust.phone || cust.whatsapp,
              businessId: business.id || cust.business_id,
              businessName: business.name,
              currency: business.currency || 'PKR',
              name: item.name,
              price: Number(item.price || 0),
              qty: Number(item.qty || 1),
              billingType: item.billingType,
              startDate: item.startDate,
              billingCycle: item.billingCycle || 'monthly',
              nextDueDate: item.nextDueDate,
              autoRenewal: item.autoRenewal !== false,
              autoGenerateInvoice: item.autoGenerateInvoice !== false,
              reminderDays: Number(item.reminderDays ?? 7),
              deliveryMethod: item.deliveryMethod || 'whatsapp',
              status: item.status || 'active',
              lastGeneratedCycle: item.lastGeneratedCycle
            });
          }
        }
      }

      res.json(subscriptions);
    } catch (err) {
      next(err);
    }
  }
};

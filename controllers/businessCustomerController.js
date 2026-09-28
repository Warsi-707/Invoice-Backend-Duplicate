import { query } from '../config/db.js';
import { memoryCache, CacheKeys, invalidateClientCaches } from '../services/cacheService.js';

export const businessCustomerController = {
  getBusinesses: async (req, res, next) => {
    try {
      const cached = memoryCache.get(CacheKeys.BUSINESSES);
      if (cached) return res.json(cached);

      const result = await query('SELECT * FROM businesses ORDER BY created_at ASC');
      const businesses = result.rows.map(b => ({
        id: b.id,
        name: b.name,
        category: b.category,
        phone: b.phone,
        whatsapp: b.whatsapp,
        address: b.address,
        prefix: b.prefix,
        currency: b.currency
      }));
      memoryCache.set(CacheKeys.BUSINESSES, businesses, 300);
      res.json(businesses);
    } catch (err) {
      next(err);
    }
  },

  getCustomers: async (req, res, next) => {
    try {
      const cached = memoryCache.get(CacheKeys.CUSTOMERS);
      if (cached) return res.json(cached);

      const result = await query('SELECT * FROM customers ORDER BY created_at ASC');
      const customers = result.rows.map(c => ({
        id: c.id,
        businessId: c.business_id,
        name: c.name,
        phone: c.phone,
        whatsapp: c.whatsapp,
        address: c.address,
        items: c.items || []
      }));
      memoryCache.set(CacheKeys.CUSTOMERS, customers, 300);
      res.json(customers);
    } catch (err) {
      next(err);
    }
  },

  addBusinessAndCustomer: async (req, res, next) => {
    try {
      const {
        businessName,
        category = '',
        phone = '',
        whatsapp = '',
        businessAddress = '',
        customerName,
        items = []
      } = req.body;

      if (!businessName || !customerName) {
        return res.status(400).json({ message: 'Business name and customer name are required.' });
      }

      const bName = businessName.trim();
      const cName = customerName.trim();
      const cleanPhone = (val) => String(val || '').replace(/\D/g, '').slice(0, 11);
      const bPhone = cleanPhone(phone);
      const bWhatsapp = cleanPhone(whatsapp) || bPhone;
      const bAddress = (businessAddress || '').trim();

      // Check if business exists by name (case-insensitive)
      let businessResult = await query(
        'SELECT * FROM businesses WHERE LOWER(name) = LOWER($1) LIMIT 1',
        [bName]
      );

      let business;
      if (businessResult.rows.length === 0) {
        const businessId = `b_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const insertBusiness = await query(
          `INSERT INTO businesses (id, name, category, phone, whatsapp, address, prefix, currency)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [businessId, bName, (category || '').trim(), bPhone, bWhatsapp, bAddress, 'INV', 'PKR']
        );
        business = insertBusiness.rows[0];
      } else {
        // Update existing business details
        const updateBiz = await query(
          `UPDATE businesses
           SET category = $1, phone = $2, whatsapp = $3, address = $4, updated_at = CURRENT_TIMESTAMP
           WHERE id = $5 RETURNING *`,
          [(category || '').trim(), bPhone, bWhatsapp, bAddress, businessResult.rows[0].id]
        );
        business = updateBiz.rows[0];
      }

      // Create new customer
      const customerId = `c_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const insertCustomer = await query(
        `INSERT INTO customers (id, business_id, name, phone, whatsapp, address, items)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [customerId, business.id, cName, bPhone, bWhatsapp, bAddress, JSON.stringify(items || [])]
      );
      const customer = insertCustomer.rows[0];

      res.status(201).json({
        business: {
          id: business.id,
          name: business.name,
          category: business.category,
          phone: business.phone,
          whatsapp: business.whatsapp,
          address: business.address,
          prefix: business.prefix,
          currency: business.currency
        },
        customer: {
          id: customer.id,
          businessId: customer.business_id,
          name: customer.name,
          phone: customer.phone,
          whatsapp: customer.whatsapp,
          address: customer.address,
          items: customer.items || []
        }
      });

      invalidateClientCaches();
    } catch (err) {
      next(err);
    }
  },

  updateBusinessAndCustomer: async (req, res, next) => {
    try {
      const {
        customerId,
        businessId,
        businessName,
        category = '',
        phone = '',
        whatsapp = '',
        businessAddress = '',
        customerName,
        items = []
      } = req.body;

      if (!customerId || !businessId) {
        return res.status(400).json({ message: 'Customer ID and Business ID are required.' });
      }

      const cleanPhone = (val) => String(val || '').replace(/\D/g, '').slice(0, 11);
      const bPhone = cleanPhone(phone);
      const bWhatsapp = cleanPhone(whatsapp) || bPhone;
      const bAddress = (businessAddress || '').trim();

      // Update business
      const updateBiz = await query(
        `UPDATE businesses
         SET name = $1, category = $2, phone = $3, whatsapp = $4, address = $5, updated_at = CURRENT_TIMESTAMP
         WHERE id = $6 RETURNING *`,
        [businessName.trim(), (category || '').trim(), bPhone, bWhatsapp, bAddress, businessId]
      );

      // Update customer
      const updateCust = await query(
        `UPDATE customers
         SET name = $1, phone = $2, whatsapp = $3, address = $4, items = $5, updated_at = CURRENT_TIMESTAMP
         WHERE id = $6 RETURNING *`,
        [customerName.trim(), bPhone, bWhatsapp, bAddress, JSON.stringify(items || []), customerId]
      );

      res.json({
        business: updateBiz.rows[0] ? {
          id: updateBiz.rows[0].id,
          name: updateBiz.rows[0].name,
          category: updateBiz.rows[0].category,
          phone: updateBiz.rows[0].phone,
          whatsapp: updateBiz.rows[0].whatsapp,
          address: updateBiz.rows[0].address,
          prefix: updateBiz.rows[0].prefix,
          currency: updateBiz.rows[0].currency
        } : null,
        customer: updateCust.rows[0] ? {
          id: updateCust.rows[0].id,
          businessId: updateCust.rows[0].business_id,
          name: updateCust.rows[0].name,
          phone: updateCust.rows[0].phone,
          whatsapp: updateCust.rows[0].whatsapp,
          address: updateCust.rows[0].address,
          items: updateCust.rows[0].items || []
        } : null
      });

      invalidateClientCaches();
    } catch (err) {
      next(err);
    }
  },

  deleteCustomer: async (req, res, next) => {
    try {
      const { id } = req.params;

      // Check if invoices exist for this customer
      const invoiceCheck = await query('SELECT COUNT(*) FROM invoices WHERE customer_id = $1', [id]);
      if (parseInt(invoiceCheck.rows[0].count, 10) > 0) {
        return res.status(400).json({ message: 'This customer has invoice history and cannot be deleted.' });
      }

      const custResult = await query('SELECT * FROM customers WHERE id = $1', [id]);
      if (custResult.rows.length === 0) {
        return res.status(404).json({ message: 'Customer not found.' });
      }

      const businessId = custResult.rows[0].business_id;

      // Delete customer
      await query('DELETE FROM customers WHERE id = $1', [id]);

      // If business has no other customers and no invoices, delete the business as well
      const otherCustCheck = await query('SELECT COUNT(*) FROM customers WHERE business_id = $1', [businessId]);
      const otherInvCheck = await query('SELECT COUNT(*) FROM invoices WHERE business_id = $1', [businessId]);

      let businessDeleted = false;
      if (
        parseInt(otherCustCheck.rows[0].count, 10) === 0 &&
        parseInt(otherInvCheck.rows[0].count, 10) === 0
      ) {
        await query('DELETE FROM businesses WHERE id = $1', [businessId]);
        businessDeleted = true;
      }

      invalidateClientCaches();

      res.json({
        success: true,
        customerId: id,
        businessId: businessDeleted ? businessId : null
      });
    } catch (err) {
      next(err);
    }
  }
};

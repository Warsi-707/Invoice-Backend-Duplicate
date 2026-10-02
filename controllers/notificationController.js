import { query } from '../config/db.js';

export const notificationController = {
  getNotifications: async (req, res, next) => {
    try {
      const [notifsRes, unreadRes] = await Promise.all([
        query(`
          SELECT id, type, title, message, customer_id, customer_name,
                 business_id, item_id, item_name, amount, due_date,
                 cycle_key, is_read, created_at
          FROM notifications
          ORDER BY created_at DESC
          LIMIT 100
        `),
        query(`SELECT COUNT(*) FROM notifications WHERE is_read = FALSE`)
      ]);

      const notifications = notifsRes.rows.map(n => ({
        id: n.id,
        type: n.type,
        title: n.title,
        message: n.message,
        customerId: n.customer_id,
        customerName: n.customer_name,
        businessId: n.business_id,
        itemId: n.item_id,
        itemName: n.item_name,
        amount: Number(n.amount || 0),
        dueDate: n.due_date,
        cycleKey: n.cycle_key,
        isRead: Boolean(n.is_read),
        createdAt: n.created_at
      }));

      const unreadCount = parseInt(unreadRes.rows[0]?.count || 0, 10);

      res.json({
        notifications,
        unreadCount
      });
    } catch (err) {
      next(err);
    }
  },

  markAsRead: async (req, res, next) => {
    try {
      const { id } = req.params;
      await query(`UPDATE notifications SET is_read = TRUE WHERE id = $1`, [id]);
      res.json({ success: true, id });
    } catch (err) {
      next(err);
    }
  },

  markAllAsRead: async (req, res, next) => {
    try {
      await query(`UPDATE notifications SET is_read = TRUE WHERE is_read = FALSE`);
      res.json({ success: true, message: 'All notifications marked as read' });
    } catch (err) {
      next(err);
    }
  },

  deleteNotification: async (req, res, next) => {
    try {
      const { id } = req.params;
      await query(`DELETE FROM notifications WHERE id = $1`, [id]);
      res.json({ success: true, id });
    } catch (err) {
      next(err);
    }
  },

  clearAll: async (req, res, next) => {
    try {
      await query(`DELETE FROM notifications`);
      res.json({ success: true, message: 'All notifications cleared' });
    } catch (err) {
      next(err);
    }
  }
};

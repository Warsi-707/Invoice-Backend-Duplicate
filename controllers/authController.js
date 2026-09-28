import { query } from '../config/db.js';
import { createToken } from '../middleware/authMiddleware.js';

export const authController = {
  login: async (req, res, next) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Username and password are required.' });
      }

      // Check current settings admin username & password
      const result = await query('SELECT * FROM settings LIMIT 1');
      const settings = result.rows[0] || { admin: 'Administrator', password: 'admin123' };

      const configuredAdmin = (settings.admin || 'Administrator').trim();
      const configuredPass = String(settings.password || 'admin123');

      const inputUser = username.trim();
      const inputPass = String(password);

      // Verify username (matches configured admin, or 'admin', or 'administrator')
      const isUserValid =
        inputUser.toLowerCase() === configuredAdmin.toLowerCase() ||
        inputUser.toLowerCase() === 'admin' ||
        inputUser.toLowerCase() === 'administrator';

      if (!isUserValid) {
        return res.status(401).json({
          success: false,
          message: 'Invalid username. Please check your username.'
        });
      }

      // Verify password
      if (inputPass !== configuredPass) {
        return res.status(401).json({
          success: false,
          message: 'Invalid password. Please check your password.'
        });
      }

      const token = createToken({
        username: configuredAdmin,
        role: 'admin'
      });

      res.json({
        success: true,
        token,
        user: {
          username: configuredAdmin,
          role: 'admin'
        },
        settings: {
          admin: settings.admin || 'Administrator',
          currency: settings.currency || 'PKR',
          dueDays: settings.due_days ?? 0,
          footerNote: settings.footer_note || 'Thank you for your business.'
        }
      });
    } catch (err) {
      next(err);
    }
  },

  logout: async (req, res) => {
    res.json({ success: true, message: 'Logged out successfully' });
  },

  getMe: async (req, res, next) => {
    try {
      const result = await query('SELECT * FROM settings LIMIT 1');
      const settings = result.rows[0] || { admin: 'Administrator' };
      res.json({
        user: {
          username: settings.admin || 'Administrator',
          role: 'admin'
        },
        settings: {
          admin: settings.admin,
          currency: settings.currency,
          dueDays: settings.due_days,
          footerNote: settings.footer_note
        }
      });
    } catch (err) {
      next(err);
    }
  }
};

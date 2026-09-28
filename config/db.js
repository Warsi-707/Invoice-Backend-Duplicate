import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn('⚠️ WARNING: DATABASE_URL is not set in backend/.env');
}

export const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  console.warn('⚠️ Neon DB Pool idle client notice:', err.message);
});

export const query = (text, params) => pool.query(text, params);

export async function initDb() {
  const client = await pool.connect();
  try {
    console.log('🔄 Connecting to PostgreSQL / Neon DB...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        admin VARCHAR(100) DEFAULT 'Administrator',
        password VARCHAR(255) DEFAULT 'admin123',
        currency VARCHAR(10) DEFAULT 'PKR',
        due_days INT DEFAULT 0,
        footer_note TEXT DEFAULT 'Thank you for your business.',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE settings ADD COLUMN IF NOT EXISTS password VARCHAR(255) DEFAULT 'admin123';
      ALTER TABLE settings ADD COLUMN IF NOT EXISTS proposal_data JSONB DEFAULT '{}'::jsonb;
      ALTER TABLE settings ADD COLUMN IF NOT EXISTS whatsapp_settings JSONB DEFAULT '{"initialDelay":2,"messageDelay":3}'::jsonb;
      UPDATE settings SET password = 'admin123' WHERE password IS NULL OR password = '';

      CREATE TABLE IF NOT EXISTS businesses (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(255) DEFAULT '',
        phone VARCHAR(50) DEFAULT '',
        whatsapp VARCHAR(50) DEFAULT '',
        address TEXT DEFAULT '',
        prefix VARCHAR(20) DEFAULT 'INV',
        currency VARCHAR(10) DEFAULT 'PKR',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS customers (
        id VARCHAR(50) PRIMARY KEY,
        business_id VARCHAR(50) REFERENCES businesses(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(50) DEFAULT '',
        whatsapp VARCHAR(50) DEFAULT '',
        address TEXT DEFAULT '',
        items JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS invoices (
        id VARCHAR(50) PRIMARY KEY,
        invoice_no VARCHAR(50) NOT NULL,
        business_id VARCHAR(50) REFERENCES businesses(id) ON DELETE CASCADE,
        customer_id VARCHAR(50) REFERENCES customers(id) ON DELETE CASCADE,
        month VARCHAR(30),
        year INT,
        date VARCHAR(30),
        due_date VARCHAR(30),
        subtotal NUMERIC(14, 2) DEFAULT 0,
        previous_dues NUMERIC(14, 2) DEFAULT 0,
        discount NUMERIC(14, 2) DEFAULT 0,
        late_fee NUMERIC(14, 2) DEFAULT 0,
        total NUMERIC(14, 2) NOT NULL DEFAULT 0,
        paid NUMERIC(14, 2) DEFAULT 0,
        balance NUMERIC(14, 2) DEFAULT 0,
        status VARCHAR(30) DEFAULT 'Unpaid',
        items JSONB DEFAULT '[]'::jsonb,
        payments JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS previous_dues NUMERIC(14, 2) DEFAULT 0;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS previous_dues_months VARCHAR(255) DEFAULT '';

      CREATE TABLE IF NOT EXISTS reversals (
        id VARCHAR(50) PRIMARY KEY,
        invoice_id VARCHAR(50),
        invoice_no VARCHAR(50),
        business_id VARCHAR(50),
        customer_id VARCHAR(50),
        amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
        method VARCHAR(50) DEFAULT 'Cash',
        payment_date VARCHAR(50) DEFAULT '',
        reversed_at VARCHAR(50) DEFAULT '',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS whatsapp_auth_store (
        id VARCHAR(255) PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- High Performance Indexes for Instant Queries
      CREATE INDEX IF NOT EXISTS idx_invoices_biz ON invoices (business_id);
      CREATE INDEX IF NOT EXISTS idx_invoices_cust ON invoices (customer_id);
      CREATE INDEX IF NOT EXISTS idx_invoices_biz_cust ON invoices (business_id, customer_id);
      CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON invoices (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);
      CREATE INDEX IF NOT EXISTS idx_customers_biz ON customers (business_id);
      CREATE INDEX IF NOT EXISTS idx_reversals_created ON reversals (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_reversals_invoice_id ON reversals (invoice_id);
    `);

    // Ensure default settings row exists
    const checkSettings = await client.query('SELECT COUNT(*) FROM settings');
    if (parseInt(checkSettings.rows[0].count, 10) === 0) {
      await client.query(`
        INSERT INTO settings (admin, currency, due_days, footer_note)
        VALUES ('Admin', 'PKR', 0, 'Thank you for your business.')
      `);
      console.log('✅ Default settings initialized.');
    }

    console.log('✅ PostgreSQL / Neon DB connected and schema verified.');
  } catch (err) {
    console.error('❌ Database initialization error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

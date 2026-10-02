import { query } from '../config/db.js';
import { invalidateClientCaches, invalidateInvoiceCaches } from './cacheService.js';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function getTodayString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function money(amt, currency = 'PKR') {
  return `${currency} ${Number(amt || 0).toLocaleString()}`;
}

/**
 * Automatically process project-based billing when a client is added or updated.
 * Generates initial invoice, records notification, and links to customer records.
 */
export async function autoProcessProjectBilling(customer, business = null) {
  if (!customer || !customer.id) return { generated: 0 };

  const todayStr = getTodayString();
  const [currY, currM] = todayStr.split('-');
  const monthIndex = parseInt(currM, 10) - 1;
  const monthName = MONTH_NAMES[monthIndex] || 'October';
  const yearNum = parseInt(currY, 10) || new Date().getFullYear();

  let biz = business;
  if (!biz && customer.business_id) {
    const bizRes = await query('SELECT * FROM businesses WHERE id = $1', [customer.business_id]);
    biz = bizRes.rows[0];
  }
  const businessId = biz?.id || customer.business_id;
  const prefix = biz?.prefix || 'INV';
  const currency = biz?.currency || 'PKR';

  let items = Array.isArray(customer.items) ? [...customer.items] : [];
  let modifiedCustomerItems = false;
  let generatedCount = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    // Only process project-based services
    if (item.billingType === 'subscription') continue;

    const isMilestoneMode = item.projectBillingMode === 'milestone';
    const isAutoGenerate = item.autoGenerateInvoice !== false && item.billingTrigger !== 'manual';

    if (!isAutoGenerate) continue;

    // =========================================================================
    // CASE 1: MILESTONE BASED PROJECT BILLING
    // =========================================================================
    if (isMilestoneMode && Array.isArray(item.milestones) && item.milestones.length > 0) {
      // Find the first milestone that is ready or pending and NOT yet invoiced
      const targetMilestone = item.milestones.find((m) => !m.invoiceId && m.status !== 'Invoiced' && m.status !== 'Paid');

      if (targetMilestone) {
        // Prevent duplicate invoice generation for this milestone ID
        const dupCheck = await query(
          'SELECT id, invoice_no FROM invoices WHERE milestone_id = $1 LIMIT 1',
          [targetMilestone.id]
        );

        if (dupCheck.rows.length === 0) {
          const invCountRes = await query('SELECT COUNT(*) FROM invoices WHERE business_id = $1', [businessId]);
          const nextSeq = parseInt(invCountRes.rows[0].count, 10) + 1;
          const invoiceNo = `${prefix}-${yearNum}-${String(nextSeq).padStart(4, '0')}`;
          const invoiceId = `inv_ms_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
          const msAmount = Number(targetMilestone.amount || 0);
          const msDueDate = targetMilestone.dueDate || todayStr;

          const invoiceItems = [
            {
              id: targetMilestone.id || `ms-item-${Date.now()}`,
              name: `${item.name || 'Deliverable'} - ${targetMilestone.name || 'Milestone'}`,
              desc: `Milestone Billing (${targetMilestone.name})`,
              qty: 1,
              price: msAmount,
              amount: msAmount,
              milestoneId: targetMilestone.id,
              projectId: item.id
            }
          ];

          // Insert Invoice into PostgreSQL Neon DB
          await query(
            `INSERT INTO invoices (
              id, invoice_no, business_id, customer_id, month, year, date, due_date,
              subtotal, total, paid, balance, status, items, payments, milestone_id, project_id, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, CURRENT_TIMESTAMP)`,
            [
              invoiceId,
              invoiceNo,
              businessId,
              customer.id,
              monthName,
              yearNum,
              todayStr,
              msDueDate,
              msAmount,
              msAmount,
              0,
              msAmount,
              'Unpaid',
              JSON.stringify(invoiceItems),
              JSON.stringify([]),
              targetMilestone.id,
              item.id || null
            ]
          );

          // Update milestone in customer items
          targetMilestone.status = 'Invoiced';
          targetMilestone.invoiceId = invoiceId;
          targetMilestone.invoiceNo = invoiceNo;
          modifiedCustomerItems = true;
          generatedCount++;

          // In-App Notification
          const notifId = `notif_ms_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
          const notifMsg = `Milestone invoice generated — Client: ${customer.name} — ${targetMilestone.name} — Amount: ${money(msAmount, currency)} — Due: ${msDueDate}`;

          await query(
            `INSERT INTO notifications (
              id, type, title, message, customer_id, customer_name,
              business_id, item_id, item_name, amount, due_date, cycle_key, is_read, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, FALSE, CURRENT_TIMESTAMP)`,
            [
              notifId,
              'milestone_invoice',
              'Project Milestone Invoice',
              notifMsg,
              customer.id,
              customer.name,
              businessId,
              targetMilestone.id,
              targetMilestone.name,
              msAmount,
              msDueDate,
              targetMilestone.id
            ]
          );

          console.log(`[Project Billing] 🎯 Generated Milestone Invoice #${invoiceNo} for "${customer.name}" (${targetMilestone.name} - ${money(msAmount, currency)})`);
        } else {
          // Link if already in DB
          targetMilestone.status = 'Invoiced';
          targetMilestone.invoiceId = dupCheck.rows[0].id;
          targetMilestone.invoiceNo = dupCheck.rows[0].invoice_no;
          modifiedCustomerItems = true;
        }
      }
    }

    // =========================================================================
    // CASE 2: ONE-TIME PROJECT BILLING
    // =========================================================================
    else if (!isMilestoneMode) {
      const projAmount = Number(item.amount || item.price || 0);
      const projDueDate = item.dueDate || todayStr;

      // Check if invoice already generated for this project
      const dupCheck = await query(
        `SELECT id, invoice_no FROM invoices 
         WHERE customer_id = $1 AND business_id = $2 
         AND (project_id = $3 OR items::text LIKE $4) 
         LIMIT 1`,
        [
          customer.id,
          businessId,
          item.id || 'none',
          `%"id":"${item.id}"%`
        ]
      );

      if (dupCheck.rows.length === 0 && projAmount > 0) {
        const invCountRes = await query('SELECT COUNT(*) FROM invoices WHERE business_id = $1', [businessId]);
        const nextSeq = parseInt(invCountRes.rows[0].count, 10) + 1;
        const invoiceNo = `${prefix}-${yearNum}-${String(nextSeq).padStart(4, '0')}`;
        const invoiceId = `inv_ot_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

        const invoiceItems = [
          {
            id: item.id || `ot-item-${Date.now()}`,
            name: item.name || 'Custom Project Delivery',
            desc: item.desc || 'One-time project delivery',
            qty: Math.max(1, Number(item.qty || 1)),
            price: projAmount,
            amount: projAmount,
            billingType: 'project',
            projectBillingMode: 'one_time',
            projectId: item.id
          }
        ];

        // Insert Invoice into PostgreSQL Neon DB
        await query(
          `INSERT INTO invoices (
            id, invoice_no, business_id, customer_id, month, year, date, due_date,
            subtotal, total, paid, balance, status, items, payments, project_id, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, CURRENT_TIMESTAMP)`,
          [
            invoiceId,
            invoiceNo,
            businessId,
            customer.id,
            monthName,
            yearNum,
            todayStr,
            projDueDate,
            projAmount,
            projAmount,
            0,
            projAmount,
            'Unpaid',
            JSON.stringify(invoiceItems),
            JSON.stringify([]),
            item.id || null
          ]
        );

        item.lastInvoiceId = invoiceId;
        item.lastInvoiceNo = invoiceNo;
        modifiedCustomerItems = true;
        generatedCount++;

        // In-App Notification
        const notifId = `notif_ot_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const notifMsg = `Project invoice generated — Client: ${customer.name} — ${item.name || 'Project'} — Amount: ${money(projAmount, currency)} — Due: ${projDueDate}`;

        await query(
          `INSERT INTO notifications (
            id, type, title, message, customer_id, customer_name,
            business_id, item_id, item_name, amount, due_date, cycle_key, is_read, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, FALSE, CURRENT_TIMESTAMP)`,
          [
            notifId,
            'project_invoice',
            'Project Invoice Created',
            notifMsg,
            customer.id,
            customer.name,
            businessId,
            item.id || '',
            item.name || '',
            projAmount,
            projDueDate,
            item.id || invoiceNo
          ]
        );

        console.log(`[Project Billing] 📦 Generated One-Time Invoice #${invoiceNo} for "${customer.name}" (${money(projAmount, currency)})`);
      }
    }
  }

  // Update customer's items JSONB if milestone/invoice IDs were linked
  if (modifiedCustomerItems) {
    await query(
      'UPDATE customers SET items = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [JSON.stringify(items), customer.id]
    );
  }

  if (generatedCount > 0) {
    invalidateInvoiceCaches();
    invalidateClientCaches();
  }

  return { generated: generatedCount };
}

import { query } from '../config/db.js';
import { memoryCache, CacheKeys, invalidateClientCaches, invalidateInvoiceCaches } from './cacheService.js';
import { getWhatsAppStatus, sendWhatsAppMessage } from './whatsappService.js';

// Month names helper
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/**
 * Get current date string (YYYY-MM-DD) in local time
 */
export function getTodayString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Subtract days from a date string (YYYY-MM-DD)
 */
export function subtractDays(dateStr, days = 0) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() - Number(days || 0));
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Add months to date string while preserving day of month as close as possible
 */
export function addMonthsToDate(dateStr, monthsToAdd = 1) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  
  const targetMonth = date.getMonth() + monthsToAdd;
  date.setMonth(targetMonth);
  
  // If day overflowed into next month (e.g. 31 Jan + 1 month -> 3 March in leap/non-leap)
  if (date.getMonth() !== ((targetMonth % 12) + 12) % 12) {
    date.setDate(0); // set to last day of previous month
  }
  
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Calculate next due date given start date and billing cycle
 */
export function calculateNextDueDate(startDate, billingCycle = 'monthly', referenceDate = null) {
  if (!startDate) return '';
  
  const monthsMap = {
    monthly: 1,
    quarterly: 3,
    yearly: 12
  };
  const addCount = monthsMap[billingCycle] || 1;
  
  // First next due date after startDate
  let nextDue = addMonthsToDate(startDate, addCount);
  
  const refStr = referenceDate || getTodayString();
  
  // If nextDue is already in the past, advance until it's >= refStr
  while (nextDue < refStr) {
    nextDue = addMonthsToDate(nextDue, addCount);
  }
  
  return nextDue;
}

/**
 * Format cycle identifier (e.g. "2026-10-06" or "2026-10" or "2026-Q4")
 */
export function getCycleKey(dateStr, billingCycle = 'monthly') {
  if (!dateStr) return '';
  return dateStr; // Exact due date cycle identifier
}

/**
 * Format currency helper
 */
function money(amt, currency = 'PKR') {
  return `${currency} ${Number(amt || 0).toLocaleString()}`;
}

/**
 * Process all due subscriptions across database
 */
export async function processDueSubscriptions() {
  const todayStr = getTodayString();
  const results = {
    checkedCustomers: 0,
    activeSubscriptions: 0,
    generatedInvoices: [],
    remindersSent: 0,
    errors: []
  };

  console.log(`\n======================================================`);
  console.log(`[Subscription Scheduler] 🔍 Running subscription cycle check... (Today: ${todayStr})`);
  console.log(`======================================================`);

  try {
    const customersRes = await query('SELECT * FROM customers ORDER BY created_at DESC');
    const businessesRes = await query('SELECT * FROM businesses');
    const settingsRes = await query('SELECT * FROM settings LIMIT 1');
    
    const businessesMap = new Map(businessesRes.rows.map(b => [b.id, b]));
    const settingsRow = settingsRes.rows[0] || {};
    const defaultCurrency = settingsRow.currency || 'PKR';
    const proposalData = settingsRow.proposal_data || {};

    for (const cust of customersRes.rows) {
      results.checkedCustomers++;
      let items = Array.isArray(cust.items) ? cust.items : [];
      let customerItemsModified = false;
      const business = businessesMap.get(cust.business_id) || {};
      const cur = business.currency || defaultCurrency;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.billingType !== 'subscription' || item.status === 'paused' || item.status === 'cancelled') {
          continue;
        }

        results.activeSubscriptions++;

        const startDate = item.startDate || cust.created_at?.toISOString()?.split('T')[0] || todayStr;
        const billingCycle = item.billingCycle || 'monthly';
        const reminderDays = Number(item.reminderDays ?? 7);
        const autoGen = item.autoGenerateInvoice !== false;
        
        let nextDueDate = item.nextDueDate;
        if (!nextDueDate) {
          nextDueDate = calculateNextDueDate(startDate, billingCycle);
          item.nextDueDate = nextDueDate;
          customerItemsModified = true;
        }

        // Calculate reminder trigger date (e.g. 7 days before nextDueDate: 2026-10-06 - 7 days = 2026-09-29)
        const triggerStr = subtractDays(nextDueDate, reminderDays);
        const cycleKey = getCycleKey(nextDueDate, billingCycle);

        console.log(`\n[Subscription Scheduler] 📋 Evaluating: "${item.name}" | Client: "${cust.name}"`);
        console.log(`  - Billing Cycle: ${billingCycle.toUpperCase()} | Start Date: ${startDate}`);
        console.log(`  - Next Due Date: ${nextDueDate} | Reminder Days: ${reminderDays}d before`);
        console.log(`  - Reminder Trigger Date: ${triggerStr} (Today is: ${todayStr})`);
        console.log(`  - Auto-Generate Invoice: ${autoGen ? 'ON' : 'OFF'} | Auto-Renewal: ${item.autoRenewal !== false ? 'ON' : 'OFF'}`);

        // Check if today is on or after reminder trigger date
        if (todayStr >= triggerStr) {
          console.log(`  - ⚡ Trigger Condition: MET (Today "${todayStr}" >= Reminder Date "${triggerStr}")`);

          const [dueY, dueM] = nextDueDate.split('-');
          const monthIndex = parseInt(dueM, 10) - 1;
          const monthName = MONTH_NAMES[monthIndex] || 'Monthly';
          const yearNum = parseInt(dueY, 10) || new Date().getFullYear();
          const qty = Math.max(1, Number(item.qty || 1));
          const unitPrice = Number(item.price || 0);
          const lineTotal = qty * unitPrice;

          // 1. Create In-App Notification for Admin (Prevent duplicate for the same cycle)
          const checkNotif = await query(
            `SELECT id FROM notifications 
             WHERE customer_id = $1 AND cycle_key = $2 AND type = 'subscription_reminder'
             LIMIT 1`,
            [cust.id, cycleKey]
          );

          if (checkNotif.rows.length === 0) {
            const notifId = `notif_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
            const notifMsg = `Subscription payment due in ${reminderDays} days — Client: ${cust.name} — Amount: ${money(lineTotal, cur)} — Due Date: ${nextDueDate}`;

            await query(
              `INSERT INTO notifications (
                id, type, title, message, customer_id, customer_name,
                business_id, item_id, item_name, amount, due_date, cycle_key, is_read, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, FALSE, CURRENT_TIMESTAMP)`,
              [
                notifId,
                'subscription_reminder',
                'Subscription Payment Reminder',
                notifMsg,
                cust.id,
                cust.name,
                business.id || cust.business_id,
                item.id || '',
                item.name || '',
                lineTotal,
                nextDueDate,
                cycleKey
              ]
            );
            results.notificationsCreated = (results.notificationsCreated || 0) + 1;
            console.log(`  - 🔔 Created In-App Notification: "${notifMsg}"`);
          } else {
            console.log(`  - ℹ️ In-App Notification already exists for cycle "${cycleKey}".`);
          }

          // 2. Automated Invoice Generation (if Auto-Generate is ON)
          if (autoGen) {
            // Check duplicate invoice for this customer and cycle
            const checkInvoice = await query(
              `SELECT id, invoice_no, month, year FROM invoices 
               WHERE customer_id = $1 AND business_id = $2 
               AND (
                 items::text LIKE $3 OR 
                 items::text LIKE $4
               )
               LIMIT 1`,
              [
                cust.id,
                business.id || cust.business_id,
                `%"subscriptionCycle":"${cycleKey}"%`,
                `%"nextDueDate":"${nextDueDate}"%`
              ]
            );

            if (checkInvoice.rows.length > 0 || item.lastGeneratedCycle === cycleKey) {
              const existingInvNo = checkInvoice.rows[0]?.invoice_no || item.lastInvoiceNo || 'EXISTING';
              console.log(`  - ⏭️ SKIPPED (Duplicate Invoice Prevention): Cycle "${cycleKey}" already generated as Invoice #${existingInvNo}.`);
              
              // Advance nextDueDate if already fulfilled and auto-renewal is enabled
              if (item.autoRenewal !== false && item.nextDueDate === nextDueDate && checkInvoice.rows.length > 0) {
                const monthsToAdd = billingCycle === 'quarterly' ? 3 : billingCycle === 'yearly' ? 12 : 1;
                item.nextDueDate = addMonthsToDate(nextDueDate, monthsToAdd);
                item.lastGeneratedCycle = cycleKey;
                customerItemsModified = true;
                console.log(`  - 🔄 Advanced next due date to next cycle: ${item.nextDueDate}`);
              }
              continue;
            }

            // Generate unique invoice number
            const invCountRes = await query('SELECT COUNT(*) FROM invoices WHERE business_id = $1', [business.id || cust.business_id]);
            const nextSeq = parseInt(invCountRes.rows[0].count, 10) + 1;
            const prefix = business.prefix || 'INV';
            const invoiceNo = `${prefix}-${yearNum}-${String(nextSeq).padStart(4, '0')}`;
            const invoiceId = `inv_sub_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

            const invoiceItems = [
              {
                id: item.id || `sub-item-${Date.now()}`,
                name: `${item.name} (${billingCycle.toUpperCase()} Subscription: Due ${nextDueDate})`,
                desc: item.desc || `Recurring ${billingCycle} subscription service`,
                qty,
                price: unitPrice,
                amount: lineTotal,
                billingType: 'subscription',
                subscriptionCycle: cycleKey,
                startDate,
                billingCycle,
                nextDueDate
              }
            ];

            // Insert generated invoice into database
            const insertInv = await query(
              `INSERT INTO invoices (
                id, invoice_no, business_id, customer_id, month, year, date, due_date,
                subtotal, discount, late_fee, total, paid, balance, status, items, payments
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
              RETURNING *`,
              [
                invoiceId,
                invoiceNo,
                business.id || cust.business_id,
                cust.id,
                monthName,
                yearNum,
                todayStr,
                nextDueDate,
                lineTotal,
                0,
                0,
                lineTotal,
                0,
                lineTotal,
                'Unpaid',
                JSON.stringify(invoiceItems),
                JSON.stringify([])
              ]
            );

            const generatedInvoice = insertInv.rows[0];
            results.generatedInvoices.push({
              invoiceNo,
              customerName: cust.name,
              businessName: business.name,
              amount: lineTotal,
              dueDate: nextDueDate,
              cycle: cycleKey
            });

            console.log(`  - ✅ PROCESSED: Created Invoice #${invoiceNo} for "${cust.name}" (Amount: ${money(lineTotal, cur)}, Due: ${nextDueDate})`);

            // 3. Automated WhatsApp / Email Delivery ONLY IF configured for digital delivery
            const deliveryMethod = String(item.deliveryMethod || '').toLowerCase();
            const recipientPhone = cust.whatsapp || cust.phone;

            if ((deliveryMethod === 'whatsapp' || deliveryMethod === 'both') && recipientPhone && getWhatsAppStatus().status === 'CONNECTED') {
              try {
                const orgBrand = proposalData.companyName || business.name || 'Commercial Billing';
                const caption = `🔔 *Payment Reminder & Subscription Invoice*\n\n` +
                  `📄 *Invoice No:* ${invoiceNo}\n` +
                  `🏢 *Business:* ${business.name || orgBrand}\n` +
                  `👤 *Client:* ${cust.name}\n` +
                  `📦 *Service:* ${item.name} (${billingCycle})\n` +
                  `💰 *Amount Due:* ${money(lineTotal, cur)}\n` +
                  `📅 *Due Date:* ${nextDueDate}\n\n` +
                  `_This is an automated payment reminder. Kindly arrange payment on or before the due date. Thank you!_`;

                // Send payment reminder via WhatsApp
                await sendWhatsAppMessage(recipientPhone, caption);
                results.remindersSent++;
                console.log(`  - 📱 WhatsApp payment reminder dispatched to ${recipientPhone}`);
              } catch (waErr) {
                console.warn(`  - ⚠️ WhatsApp delivery notice: ${waErr.message}`);
              }
            } else if (deliveryMethod === 'none' || !deliveryMethod) {
              console.log(`  - ℹ️ Digital Delivery is set to None. No customer message sent.`);
            } else {
              console.log(`  - 📄 Delivery method: ${deliveryMethod} (WhatsApp reminder ${getWhatsAppStatus().status === 'CONNECTED' ? 'ready' : 'offline/skipped'})`);
            }

            // 4. Update subscription item tracking & advance next due date
            item.lastGeneratedCycle = cycleKey;
            item.lastInvoiceId = invoiceId;
            item.lastInvoiceNo = invoiceNo;

            if (item.autoRenewal !== false) {
              const monthsToAdd = billingCycle === 'quarterly' ? 3 : billingCycle === 'yearly' ? 12 : 1;
              const advancedDue = addMonthsToDate(nextDueDate, monthsToAdd);
              item.nextDueDate = advancedDue;
              console.log(`  - 🔄 Auto-renewal active: Advanced next due date to ${advancedDue}`);
            }

            customerItemsModified = true;
          } else {
            console.log(`  - ℹ️ Auto-generate invoice is disabled for this subscription (In-App notification recorded for Admin).`);
          }
        } else {
          console.log(`  - ⏳ NOT YET DUE: Next trigger is on ${triggerStr} (Today: ${todayStr}).`);
        }
      }

      // Save updated items back to customer record in Neon DB
      if (customerItemsModified) {
        await query(
          'UPDATE customers SET items = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [JSON.stringify(items), cust.id]
        );
      }
    }

    if (results.generatedInvoices.length > 0) {
      invalidateClientCaches();
      invalidateInvoiceCaches();
    }

    console.log(`\n======================================================`);
    console.log(`[Subscription Scheduler] 🏁 Finished. Generated ${results.generatedInvoices.length} invoices, sent ${results.remindersSent} reminders.`);
    console.log(`======================================================\n`);

    return results;
  } catch (err) {
    console.error('❌ Error processing due subscriptions:', err);
    results.errors.push(err.message);
    return results;
  }
}


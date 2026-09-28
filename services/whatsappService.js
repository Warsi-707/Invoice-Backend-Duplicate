import makeWASocketPkg, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestWaWebVersion,
  fetchLatestBaileysVersion,
  Browsers
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { query } from '../config/db.js';

const makeWASocket = makeWASocketPkg.default || makeWASocketPkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SESSION_DIR = path.resolve(__dirname, '../whatsapp_session');
const SESSION_DIR = process.env.WHATSAPP_SESSION_PATH || (
  (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT)
    ? path.join(os.tmpdir(), 'whatsapp_session')
    : DEFAULT_SESSION_DIR
);

// In-memory status state
let sock = null;
let connectionStatus = 'DISCONNECTED'; // 'DISCONNECTED' | 'CONNECTING' | 'SCAN_QR' | 'CONNECTED'
let currentQrDataUrl = null;
let connectedUser = null;
let isInitializing = false;
let cachedVersion = [2, 3000, 1048361770];
let reconnectAttempts = 0;
let syncDbTimer = null;

const logger = pino({ level: 'silent' });

/**
 * Restore WhatsApp Session files from PostgreSQL Neon Database if local directory is missing
 */
async function restoreSessionFromDb() {
  try {
    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    const credsPath = path.join(SESSION_DIR, 'creds.json');
    if (fs.existsSync(credsPath)) {
      return; // local files already present
    }

    const res = await query('SELECT id, data FROM whatsapp_auth_store');
    if (res.rows.length > 0) {
      console.log(`📥 Restoring ${res.rows.length} WhatsApp session files from PostgreSQL database...`);
      for (const row of res.rows) {
        const filePath = path.join(SESSION_DIR, row.id);
        fs.writeFileSync(filePath, row.data, 'utf8');
      }
      console.log('✅ WhatsApp session successfully restored from PostgreSQL DB.');
    }
  } catch (err) {
    console.warn('Notice restoring WhatsApp session from DB:', err.message);
  }
}

/**
 * Backup / Sync all WhatsApp session files to PostgreSQL Neon Database
 */
async function syncSessionToDb() {
  if (syncDbTimer) clearTimeout(syncDbTimer);
  syncDbTimer = setTimeout(async () => {
    try {
      if (!fs.existsSync(SESSION_DIR)) return;
      const files = fs.readdirSync(SESSION_DIR);
      if (files.length === 0) return;

      for (const file of files) {
        const filePath = path.join(SESSION_DIR, file);
        if (fs.statSync(filePath).isFile()) {
          const content = fs.readFileSync(filePath, 'utf8');
          await query(
            `INSERT INTO whatsapp_auth_store (id, data, updated_at)
             VALUES ($1, $2, CURRENT_TIMESTAMP)
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = CURRENT_TIMESTAMP`,
            [file, content]
          );
        }
      }
    } catch (err) {
      console.warn('Notice syncing WhatsApp session to DB:', err.message);
    }
  }, 1000);
}

/**
 * Clear WhatsApp Session from PostgreSQL Neon Database
 */
async function clearSessionFromDb() {
  try {
    await query('DELETE FROM whatsapp_auth_store');
    console.log('🗑️ WhatsApp auth store cleared from PostgreSQL DB.');
  } catch (err) {
    console.warn('Notice clearing WhatsApp session from DB:', err.message);
  }
}

export function getWhatsAppStatus() {
  return {
    status: connectionStatus,
    isConnected: connectionStatus === 'CONNECTED',
    qrCode: currentQrDataUrl,
    user: connectedUser
  };
}

export function formatToWhatsAppJid(phone) {
  if (!phone) return null;
  let clean = String(phone).replace(/\D/g, '');

  if (clean.startsWith('03') && clean.length === 11) {
    clean = '92' + clean.slice(1);
  } else if (clean.startsWith('3') && clean.length === 10) {
    clean = '92' + clean;
  }

  if (!clean || clean.length < 7) {
    return null;
  }

  return `${clean}@s.whatsapp.net`;
}

export async function initWhatsApp(forceRestart = false) {
  // If already connected, return status
  if (sock && sock.ws?.isOpen && connectionStatus === 'CONNECTED' && !forceRestart) {
    return getWhatsAppStatus();
  }

  // If QR code is already generated and socket is actively listening, return it
  if (sock && sock.ws?.isOpen && connectionStatus === 'SCAN_QR' && currentQrDataUrl && !forceRestart) {
    return getWhatsAppStatus();
  }

  // If already currently in the middle of initializing, return status
  if (isInitializing && !forceRestart) {
    return getWhatsAppStatus();
  }

  isInitializing = true;
  connectionStatus = 'CONNECTING';

  try {
    if (forceRestart) {
      try {
        if (fs.existsSync(SESSION_DIR)) {
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        }
        await clearSessionFromDb();
      } catch (e) {
        console.warn('Notice clearing old session on force restart:', e.message);
      }
    } else {
      // Restore from persistent PostgreSQL cloud database if local files were wiped
      await restoreSessionFromDb();
    }

    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    // Try to fetch latest live WhatsApp Web version directly from server
    try {
      const waVersion = await fetchLatestWaWebVersion();
      if (waVersion?.version) {
        cachedVersion = waVersion.version;
        console.log(`📱 Fetched latest live WhatsApp Web version: v${cachedVersion.join('.')}`);
      }
    } catch (e) {
      try {
        const vObj = await fetchLatestBaileysVersion();
        if (vObj?.version) cachedVersion = vObj.version;
      } catch (e2) {
        cachedVersion = [2, 3000, 1048361770];
      }
    }

    console.log(`📱 Initializing Baileys WhatsApp Web (v${cachedVersion.join('.')})...`);

    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.end(new Error('Reinitializing'));
      } catch (e) {
        // ignore
      }
    }

    sock = makeWASocket({
      version: cachedVersion,
      logger,
      printQRInTerminal: false,
      auth: state,
      browser: Browsers.macOS('Chrome'),
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      linkPreviewImageThumbnailWidth: 0,
      keepAliveIntervalMs: 25000,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      markOnlineOnConnect: true,
      retryRequestDelayMs: 300,
      maxMsgRetryCount: 5
    });

    // Save creds to disk and trigger background sync to PostgreSQL database
    sock.ev.on('creds.update', async () => {
      await saveCreds();
      syncSessionToDb().catch(() => {});
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionStatus = 'SCAN_QR';
        isInitializing = false;
        try {
          currentQrDataUrl = await QRCode.toDataURL(qr, {
            margin: 2,
            scale: 8,
            color: {
              dark: '#0f172a',
              light: '#ffffff'
            }
          });
          console.log('📷 New WhatsApp QR Code generated for scanning.');
        } catch (err) {
          console.error('Failed to generate QR Data URL:', err);
        }
      }

      if (connection === 'connecting') {
        if (connectionStatus !== 'SCAN_QR') {
          connectionStatus = 'CONNECTING';
        }
      } else if (connection === 'open') {
        connectionStatus = 'CONNECTED';
        currentQrDataUrl = null;
        isInitializing = false;
        reconnectAttempts = 0;

        const rawUser = sock.user?.id || '';
        const userPhone = rawUser.split(':')[0] || rawUser.split('@')[0] || '';
        connectedUser = {
          id: sock.user?.id,
          name: sock.user?.name || 'WhatsApp User',
          phone: userPhone ? `+${userPhone}` : 'Connected'
        };

        console.log(`✅ WhatsApp Connected successfully as ${connectedUser.phone}!`);
        // Immediately sync complete session to PostgreSQL database
        syncSessionToDb().catch(() => {});
      } else if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
        const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;

        console.log(`⚠️ WhatsApp connection closed (Status: ${statusCode}). LoggedOut: ${isLoggedOut}, RestartRequired: ${isRestartRequired}`);

        if (sock) {
          try {
            sock.ev.removeAllListeners();
          } catch (e) {}
        }
        sock = null;

        if (isLoggedOut) {
          console.log('🔴 WhatsApp explicitly logged out. Clearing credentials...');
          connectionStatus = 'DISCONNECTED';
          currentQrDataUrl = null;
          connectedUser = null;
          isInitializing = false;
          try {
            if (fs.existsSync(SESSION_DIR)) {
              fs.rmSync(SESSION_DIR, { recursive: true, force: true });
            }
            await clearSessionFromDb();
          } catch (err) {
            console.error('Error clearing session dir:', err);
          }
          // Auto-reinitialize fresh QR code
          setTimeout(() => {
            initWhatsApp(true).catch(console.error);
          }, 1500);
        } else {
          // 🛡️ CRITICAL FIX: NEVER wipe saved credentials on temporary network/stream disconnects!
          // Reconnect smoothly with existing credentials from disk/PostgreSQL
          connectionStatus = 'CONNECTING';
          isInitializing = false;
          reconnectAttempts += 1;
          const delayMs = Math.min(1000 * reconnectAttempts, 5000);
          console.log(`🔄 Reconnecting WhatsApp in ${delayMs}ms (Attempt ${reconnectAttempts}). Keeping saved credentials intact...`);

          setTimeout(() => {
            initWhatsApp(false).catch(console.error);
          }, delayMs);
        }
      }
    });

    // Wait briefly (up to 3s) for QR code or initial connection so first API response has QR immediately
    if (!currentQrDataUrl && connectionStatus !== 'CONNECTED') {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 3000);
        const check = setInterval(() => {
          if (currentQrDataUrl || connectionStatus === 'CONNECTED') {
            clearTimeout(timeout);
            clearInterval(check);
            resolve();
          }
        }, 50);
      });
    }

    return getWhatsAppStatus();
  } catch (err) {
    console.error('❌ Error initializing WhatsApp socket:', err);
    connectionStatus = 'DISCONNECTED';
    isInitializing = false;
    throw err;
  }
}

export async function logoutWhatsApp() {
  connectionStatus = 'DISCONNECTED';
  currentQrDataUrl = null;
  connectedUser = null;
  isInitializing = false;

  if (sock) {
    try {
      await sock.logout();
    } catch (e) {
      try {
        sock.end(new Error('Manual logout'));
      } catch (e2) {
        // ignore
      }
    }
    sock = null;
  }

  try {
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    }
    await clearSessionFromDb();
  } catch (err) {
    console.error('Error removing session directory:', err);
  }

  return { success: true, message: 'WhatsApp logged out successfully.' };
}

export async function sendWhatsAppMessage(toPhone, messageText) {
  if (!sock || connectionStatus !== 'CONNECTED') {
    throw new Error('WhatsApp is not connected. Please scan the QR code first in Settings.');
  }

  const jid = formatToWhatsAppJid(toPhone);
  if (!jid) {
    throw new Error(`Invalid recipient phone number: ${toPhone}`);
  }

  // ⚡ Bullet speed non-blocking message dispatch
  const sendPromise = sock.sendMessage(jid, { text: messageText }).catch((err) => {
    console.warn('⚠️ WhatsApp text send notice:', err.message);
    throw err;
  });

  const raceResult = await Promise.race([
    sendPromise,
    new Promise((resolve) => setTimeout(() => resolve({ fastQueued: true }), 200))
  ]);

  return {
    success: true,
    recipient: jid,
    messageId: raceResult?.key?.id || 'bullet_sent'
  };
}

export async function sendInvoiceWhatsApp({
  toPhone,
  invoice,
  business,
  customer,
  htmlContent
}) {
  if (!sock || connectionStatus !== 'CONNECTED') {
    throw new Error('WhatsApp is not connected. Please scan the QR code first in Settings.');
  }

  const recipientPhone = toPhone || customer?.whatsapp || customer?.phone;
  const jid = formatToWhatsAppJid(recipientPhone);
  if (!jid) {
    throw new Error('Customer has no valid WhatsApp or phone number.');
  }

  const bizName = business?.name || 'Company';
  const custName = customer?.name || 'Valued Customer';
  const invNo = invoice?.invoiceNo || 'INV-0000';
  const cur = business?.currency || 'PKR';
  const fmt = (num) => `${cur} ${Number(num || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

  // Clean, professional, short caption as requested
  const cleanCaption = `📄 *Invoice ${invNo}*\n🏢 ${bizName}\n👤 ${custName}\n💰 Total: ${fmt(invoice?.total || 0)}`;

  try {
    const { generatePdfFromHtml } = await import('./pdfService.js');
    const { generateBackendInvoiceHtml } = await import('./templateService.js');

    const html = htmlContent || generateBackendInvoiceHtml(invoice, business, customer);
    const pdfBuffer = await generatePdfFromHtml(html);
    const fileName = `${invNo}_${custName.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;

    return await sendDirectBufferWhatsApp(recipientPhone, pdfBuffer, fileName, 'application/pdf', cleanCaption);
  } catch (err) {
    console.warn('Sending invoice PDF failed, sending text fallback:', err.message);
    const sendResult = await sock.sendMessage(jid, { text: cleanCaption }).catch(() => {});
    return {
      success: true,
      recipient: jid,
      messageId: sendResult?.key?.id,
      fallback: true
    };
  }
}

export async function sendDirectBufferWhatsApp(toPhone, buffer, fileName, mimeType = 'application/pdf', caption = '') {
  if (!sock || connectionStatus !== 'CONNECTED') {
    throw new Error('WhatsApp is not connected. Please scan the QR code first in Settings.');
  }

  const jid = formatToWhatsAppJid(toPhone);
  if (!jid) {
    throw new Error(`Invalid recipient phone number: ${toPhone}`);
  }

  // ⚡ Bullet speed non-blocking PDF transmission
  const sendPromise = sock.sendMessage(jid, {
    document: buffer,
    fileName: fileName,
    mimetype: mimeType,
    caption: caption
  }).catch((err) => {
    console.warn('⚠️ WhatsApp document send notice:', err.message);
    if (caption) {
      sock.sendMessage(jid, { text: caption }).catch(() => {});
    }
  });

  const raceResult = await Promise.race([
    sendPromise,
    new Promise((resolve) => setTimeout(() => resolve({ fastQueued: true }), 250))
  ]);

  return {
    success: true,
    recipient: jid,
    messageId: raceResult?.key?.id || 'bullet_sent',
    dispatched: true
  };
}

export async function sendDocumentWhatsApp(toPhone, base64Data, fileName, mimeType = 'application/pdf', caption = '') {
  if (!sock || connectionStatus !== 'CONNECTED') {
    throw new Error('WhatsApp is not connected. Please scan the QR code first in Settings.');
  }

  const jid = formatToWhatsAppJid(toPhone);
  if (!jid) {
    throw new Error(`Invalid recipient phone number: ${toPhone}`);
  }

  // Convert base64 to Buffer
  const buffer = Buffer.from(base64Data, 'base64');
  return sendDirectBufferWhatsApp(toPhone, buffer, fileName, mimeType, caption);
}

export async function requestWhatsAppPairingCode(phone) {
  if (!phone) {
    throw new Error('Phone number is required.');
  }

  let clean = String(phone).replace(/\D/g, '');
  if (clean.startsWith('03') && clean.length === 11) {
    clean = '92' + clean.slice(1);
  } else if (clean.startsWith('3') && clean.length === 10) {
    clean = '92' + clean;
  }

  if (clean.length < 10) {
    throw new Error('Please enter a valid phone number (e.g. 03218246707 or 923218246707).');
  }

  // Ensure socket is active and ready
  if (!sock || connectionStatus === 'DISCONNECTED') {
    await initWhatsApp(true);
  }

  // If socket is still initializing or waiting for QR, wait briefly
  let attempts = 0;
  while (!sock && attempts < 10) {
    await new Promise((r) => setTimeout(r, 400));
    attempts++;
  }

  if (!sock) {
    throw new Error('Could not establish WhatsApp socket. Please try again.');
  }

  if (sock.authState?.creds?.registered) {
    throw new Error('WhatsApp is already linked and connected.');
  }

  const rawCode = await sock.requestPairingCode(clean);
  const code = (rawCode?.match(/.{1,4}/g)?.join('-') || rawCode).toUpperCase();
  return { success: true, code, phone: clean };
}

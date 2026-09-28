import { generatePdfFromHtml } from '../services/pdfService.js';
import { sendDirectBufferWhatsApp } from '../services/whatsappService.js';

export const pdfController = {
  /**
   * POST /api/pdf/generate
   * Body: { html: "<full html string>", phone?: string, fileName?: string, caption?: string }
   * Returns: PDF file as binary stream while firing WhatsApp concurrently
   */
  generate: async (req, res, next) => {
    try {
      const { html, phone, fileName, caption } = req.body;
      if (!html || typeof html !== 'string') {
        return res.status(400).json({ error: 'html field is required.' });
      }

      const pdfData = await generatePdfFromHtml(html);
      const buffer = Buffer.from(pdfData);

      // Concurrent background WhatsApp dispatch directly from in-memory buffer (zero delay, zero base64)
      if (phone) {
        setImmediate(() => {
          sendDirectBufferWhatsApp(phone, buffer, fileName || 'document.pdf', 'application/pdf', caption || '')
            .catch((err) => console.warn('Background WhatsApp direct send:', err.message));
        });
      }

      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${fileName || 'document.pdf'}"`,
        'Content-Length': buffer.length
      });

      res.end(buffer);
    } catch (err) {
      console.error('PDF generation error:', err.message);
      res.status(500).json({ error: err.message });
    }
  }
};

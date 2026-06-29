import express from 'express';
import { config } from './config.js';
import { logger } from './logger.js';

/** Map internal Baileys-ish status to the panel contract value. */
function contractStatus(status) {
  switch (status) {
    case 'qr_pending':
      return 'qr';
    case 'open':
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'connecting';
    default:
      // disconnected / logged_out / replaced / close → disconnected
      return 'disconnected';
  }
}

/**
 * Build the control API the Laravel panel uses to drive the single-session gateway.
 * `gateway` exposes getState(), isConnected() and send(to, text).
 */
export function buildServer(gateway) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  // Health is open; everything else needs the shared token.
  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use((req, res, next) => {
    if (req.get('x-gateway-token') !== config.token) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });

  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    logger.error({ path: req.path, err: err.message }, 'request failed');
    res.status(400).json({ error: err.message });
  });

  // GET /qr → connection status + QR PNG data url + connected jid. If the session has given up /
  // disconnected (an unscanned QR expired), revive it so opening the connect page regenerates a QR.
  app.get('/qr', wrap((_req, res) => {
    let s = gateway.getState();
    if (contractStatus(s.status) === 'disconnected' && typeof gateway.revive === 'function') {
      gateway.revive();
      s = gateway.getState();
    }
    res.json({
      status: contractStatus(s.status),
      qrDataUrl: s.qrDataUrl ?? null,
      me: s.me ?? null,
    });
  }));

  // POST /send { to, text } → send a text message.
  app.post('/send', wrap(async (req, res) => {
    const { to, text } = req.body ?? {};
    if (!to || typeof text !== 'string') {
      return res.status(400).json({ error: 'to and text are required' });
    }
    if (!gateway.isConnected()) {
      return res.status(503).json({ error: 'not connected' });
    }
    const waMessageId = await gateway.send(to, text);
    res.json({ ok: true, wa_message_id: waMessageId });
  }));

  return app;
}

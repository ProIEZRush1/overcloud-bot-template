import fs from 'node:fs/promises';
import axios from 'axios';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { config } from './config.js';
import { logger } from './logger.js';
import { toJid, describeMessage } from './util.js';
import { buildServer } from './server.js';

/**
 * Single-session WhatsApp gateway.
 *
 * One fixed Baileys socket, persisted under config.authDir (storage/wa). Holds
 * module-level state the HTTP server reads, and forwards inbound client messages
 * to the Laravel panel webhook. Proven QR/reconnect logic is ported from the old
 * multi-session session.js, collapsed to a single connection.
 */

// ---- module state -----------------------------------------------------------
// status ∈ qr_pending | connecting | connected | disconnected | logged_out
const state = {
  status: 'connecting',
  qrDataUrl: null,
  me: null, // normalized jid string
};

let sock = null;
let reconnectAttempts = 0;
let reconnectTimer = null;

// ---- inbound webhook (gateway → panel) --------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const webhook = axios.create({
  timeout: 20_000,
  headers: { 'x-gateway-token': config.token, 'Content-Type': 'application/json' },
});

/** POST one inbound message to the panel with 3 retries (1s/2s/3s backoff). */
async function postInbound(body) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await webhook.post(config.panelWebhookUrl, body);
      return true;
    } catch (err) {
      logger.warn(
        { attempt, err: err?.response?.status ?? err.message },
        'inbound webhook failed',
      );
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  logger.error({ wa_message_id: body.wa_message_id }, 'inbound webhook giving up');
  return false;
}

/** Strip a JID down to the bare phone digits. */
function jidToDigits(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

/** Decide whether a raw Baileys message should be forwarded, then forward it. */
async function forwardMessage(msg) {
  const remoteJid = msg.key?.remoteJid;
  if (!remoteJid) return;
  if (msg.key?.fromMe) return;
  if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) return;
  if (msg.message?.protocolMessage || msg.message?.senderKeyDistributionMessage) return;
  // Reactions, poll updates and edits are not messages — never forward them.
  if (msg.message?.reactionMessage || msg.message?.pollUpdateMessage || msg.message?.editedMessage) return;

  const described = describeMessage(msg.message);
  // Nothing meaningful (empty system event) → not a client message.
  if (described.type === 'system' && !described.text) return;

  const isGroup = remoteJid.endsWith('@g.us');
  const senderJid = isGroup ? (msg.key.participant ?? remoteJid) : remoteJid;

  const body = {
    from: jidToDigits(senderJid),
    fromName: msg.pushName ?? null,
    text: described.text ?? described.caption ?? '',
    type: described.type,
    isGroup,
    wa_message_id: msg.key.id,
  };

  await postInbound(body);
}

// ---- connection -------------------------------------------------------------
async function connect() {
  clearTimeout(reconnectTimer);

  // Ensure only ONE live socket — a second triggers a WA "conflict" that loops.
  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.end(undefined);
    } catch {
      // already closed
    }
    sock = null;
  }

  await fs.mkdir(config.authDir, { recursive: true });
  const { state: authState, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: authState,
    browser: Browsers.macOS('Overcloud'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    logger,
  });

  state.status = 'connecting';

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', onConnectionUpdate);
  sock.ev.on('messages.upsert', onMessagesUpsert);
}

async function onConnectionUpdate(update) {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    state.qrDataUrl = await QRCode.toDataURL(qr);
    state.status = 'qr_pending';
    logger.info('QR generated, waiting for scan');
  }

  if (connection === 'connecting') {
    state.status = 'connecting';
  }

  if (connection === 'open') {
    state.qrDataUrl = null;
    state.status = 'connected';
    reconnectAttempts = 0;
    state.me = sock.user ? jidNormalizedUser(sock.user.id) : null;
    logger.info({ me: state.me }, 'connection open');
  }

  if (connection === 'close') {
    const statusCode = (lastDisconnect?.error instanceof Boom)
      ? lastDisconnect.error.output?.statusCode
      : undefined;

    if (statusCode === DisconnectReason.loggedOut) {
      logger.warn('logged out — clearing auth');
      await fs.rm(config.authDir, { recursive: true, force: true }).catch(() => {});
      state.me = null;
      state.qrDataUrl = null;
      state.status = 'disconnected';
      return;
    }

    if (reconnectAttempts >= config.maxReconnectAttempts) {
      logger.error({ attempts: reconnectAttempts }, 'giving up reconnect after too many attempts');
      state.status = 'disconnected';
      return;
    }
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  reconnectAttempts += 1;
  const delay = Math.min(1000 * 2 ** reconnectAttempts, config.maxReconnectDelay);
  state.status = 'connecting';
  logger.info({ attempt: reconnectAttempts, delay }, 'scheduling reconnect');
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connect().catch((e) => logger.error({ err: e.message }, 'reconnect failed'));
  }, delay);
}

async function onMessagesUpsert({ messages, type }) {
  // 'notify' = live; 'append' = backlog synced on reconnect. Process both so a
  // restart never loses inbound messages (the panel dedupes by wa_message_id).
  if (type !== 'notify' && type !== 'append') return;
  for (const msg of messages) {
    try {
      await forwardMessage(msg);
    } catch (err) {
      logger.error({ err: err.message }, 'failed to forward message');
    }
  }
}

// ---- gateway surface for the HTTP server ------------------------------------
const gateway = {
  getState: () => ({ status: state.status, qrDataUrl: state.qrDataUrl, me: state.me }),
  isConnected: () => state.status === 'connected' && !!sock,
  // Revive a session that gave up / logged out so opening the connect page ALWAYS regenerates a fresh
  // QR on demand (an unscanned QR expires after a few refreshes and Baileys stops — without this the
  // page would show "Desconectado" forever until a redeploy). No-op while connected or already trying.
  revive() {
    if (state.status === 'connected' || state.status === 'connecting' || state.status === 'qr_pending') {
      return;
    }
    reconnectAttempts = 0;
    clearTimeout(reconnectTimer);
    state.status = 'connecting';
    logger.info('revive: regenerating QR on demand');
    connect().catch((e) => logger.error({ err: e.message }, 'revive failed'));
  },
  async send(to, text) {
    if (!gateway.isConnected()) throw new Error('not connected');
    const result = await sock.sendMessage(toJid(to), { text });
    return result?.key?.id ?? null;
  },
};

// ---- bootstrap --------------------------------------------------------------
function main() {
  // Start the HTTP server FIRST so /qr answers immediately while WA connects.
  const app = buildServer(gateway);
  app.listen(config.port, () => {
    logger.info({ port: config.port, webhook: config.panelWebhookUrl }, 'Overcloud WhatsApp gateway listening');
  });

  // Never process.exit on a connection error — Baileys reconnect handles drops.
  connect().catch((err) => {
    logger.error({ err: err.message }, 'initial connect failed');
    scheduleReconnect();
  });
}

main();

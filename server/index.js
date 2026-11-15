import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInitialSeedState } from './seed.js';
import {
  applySubtleMarketPulse,
  buildPublicSnapshot,
  cancelGuestBooking,
  computeBundleQuote,
  confirmGuestBooking,
  createBundleLock,
  createInventoryLock,
  purgeExpiredLocks,
  releaseInventoryLock,
  runMarketSimulation,
  updateMarkupConfig,
} from './engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const STORE_PATH = path.join(__dirname, 'data', 'store.json');

function loadOrCreateState(storePath) {
  try {
    if (fs.existsSync(storePath)) {
      const raw = fs.readFileSync(storePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 2 && parsed.hotels && parsed.flights && parsed.markupConfig) {
        return parsed;
      }
    }
  } catch {
    // Fallback cleanly to fresh v2 seed
  }
  const initial = createInitialSeedState();
  saveState(storePath, initial);
  return initial;
}

function saveState(storePath, state) {
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tmp = `${storePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, storePath);
  } catch {
    // Non-fatal in read-only or ephemeral test environments
  }
}

export function createApp({ storePath = STORE_PATH } = {}) {
  const app = express();
  const state = loadOrCreateState(storePath);
  const sseClients = new Set();

  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  function broadcast(eventName = 'snapshot') {
    const payload = JSON.stringify(buildPublicSnapshot(state));
    const frame = `event: ${eventName}\ndata: ${payload}\n\n`;
    for (const res of sseClients) {
      res.write(frame);
    }
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'Al-Fayed Tourism / Global EIS Engine', version: 2, serverTime: Date.now() });
  });

  app.get('/api/bootstrap', (_req, res) => {
    res.json(buildPublicSnapshot(state));
  });

  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    res.write(`event: snapshot\ndata: ${JSON.stringify(buildPublicSnapshot(state))}\n\n`);
    sseClients.add(res);

    const heartbeat = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  });

  app.post('/api/bundle/quote', (req, res) => {
    const quote = computeBundleQuote(state, req.body || {});
    if (!quote) {
      return res.status(404).json({ code: 'NOT_FOUND', messageEn: 'Selected hotel or flight not found' });
    }
    res.json({ quote });
  });

  app.post('/api/locks/bundle', (req, res) => {
    const result = createBundleLock(state, req.body || {});
    if (!result.ok) {
      return res.status(result.status).json(result);
    }
    saveState(storePath, state);
    broadcast('snapshot');
    res.status(result.status).json(result);
  });

  app.post('/api/locks', (req, res) => {
    const result = createInventoryLock(state, req.body || {});
    if (!result.ok) {
      return res.status(result.status).json(result);
    }
    saveState(storePath, state);
    broadcast('snapshot');
    res.status(result.status).json(result);
  });

  app.delete('/api/locks/:id', (req, res) => {
    const removed = releaseInventoryLock(state, req.params.id);
    if (removed) {
      saveState(storePath, state);
      broadcast('snapshot');
    }
    res.json({ ok: true, released: removed, snapshot: buildPublicSnapshot(state) });
  });

  app.post('/api/locks/:id/release', (req, res) => {
    const removed = releaseInventoryLock(state, req.params.id);
    if (removed) {
      saveState(storePath, state);
      broadcast('snapshot');
    }
    res.json({ ok: true, released: removed, snapshot: buildPublicSnapshot(state) });
  });

  app.post('/api/bookings', (req, res) => {
    const result = confirmGuestBooking(state, req.body || {});
    if (!result.ok) {
      return res.status(result.status).json(result);
    }
    saveState(storePath, state);
    broadcast('snapshot');
    res.status(result.status).json(result);
  });

  app.post('/api/bookings/bundle', (req, res) => {
    const result = confirmGuestBooking(state, req.body || {});
    if (!result.ok) {
      return res.status(result.status).json(result);
    }
    saveState(storePath, state);
    broadcast('snapshot');
    res.status(result.status).json(result);
  });

  app.get('/api/bookings/:ref', (req, res) => {
    const q = String(req.params.ref || '').trim().toUpperCase();
    const booking = state.bookings.find((b) => b.reference === q || b.id === req.params.ref);
    if (!booking) {
      return res.status(404).json({
        ok: false,
        code: 'NOT_FOUND',
        messageAr: 'لم يتم العثور على حجز بهذا الرقم المرجعي.',
        messageEn: 'No booking found for that reference.',
      });
    }
    res.json({ ok: true, booking });
  });

  app.post('/api/bookings/:id/cancel', (req, res) => {
    const result = cancelGuestBooking(state, req.params.id);
    if (!result.ok) {
      return res.status(result.status).json(result);
    }
    saveState(storePath, state);
    broadcast('snapshot');
    res.status(result.status).json(result);
  });

  app.put('/api/admin/markup', (req, res) => {
    const markupConfig = updateMarkupConfig(state, req.body || {});
    saveState(storePath, state);
    broadcast('snapshot');
    res.json({ ok: true, markupConfig, snapshot: buildPublicSnapshot(state) });
  });

  app.post('/api/admin/simulate', (req, res) => {
    const result = runMarketSimulation(state, req.body || {});
    if (!result.ok) {
      return res.status(result.status || 400).json(result);
    }
    saveState(storePath, state);
    broadcast('snapshot');
    res.json(result);
  });

  app.post('/api/admin/auto-pulse', (req, res) => {
    state.autoPulseEnabled = Boolean(req.body?.enabled);
    saveState(storePath, state);
    broadcast('snapshot');
    res.json({ ok: true, autoPulseEnabled: state.autoPulseEnabled, snapshot: buildPublicSnapshot(state) });
  });

  app.get('/favicon.svg', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'favicon.svg'));
  });

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  return { app, state, broadcast, sseClients };
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMainModule) {
  const PORT = Number(process.env.PORT) || 3000;
  const { app, state, broadcast } = createApp();

  setInterval(() => {
    const expiredChanged = purgeExpiredLocks(state);
    const pulseSnap = applySubtleMarketPulse(state);
    if (expiredChanged || pulseSnap) {
      saveState(STORE_PATH, state);
      broadcast('snapshot');
    }
  }, 16000);

  app.listen(PORT, () => {
    console.log(`[Al-Fayed Tourism / Global EIS] Live booking server v2 running on http://localhost:${PORT}`);
  });
}

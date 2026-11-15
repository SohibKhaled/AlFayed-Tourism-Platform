import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../server/index.js';

function startTestServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alfayed-v2-test-'));
  const storePath = path.join(tmpDir, 'store.json');
  const { app } = createApp({ storePath });

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => {
              fs.rmSync(tmpDir, { recursive: true, force: true });
              done();
            });
          }),
      });
    });
  });
}

test('HTTP + SSE lifecycle: bootstrap v2, favicon, simultaneous bundle lock & booking, markup update', async () => {
  const srv = await startTestServer();
  try {
    // 1. Bootstrap returns expanded hotels/flights + visa rules
    const bootRes = await fetch(`${srv.baseUrl}/api/bootstrap`);
    assert.equal(bootRes.status, 200);
    const snap = await bootRes.json();
    assert.ok(snap.hotels.length >= 14);
    assert.ok(snap.flights.length >= 14);
    assert.ok(Array.isArray(snap.hotels[0].tiers) && snap.hotels[0].tiers.length === 3);
    assert.ok(Array.isArray(snap.flights[0].tiers) && snap.flights[0].tiers.length === 3);
    assert.ok(snap.visaRules.EG.AE);
    assert.equal(snap.cityVibes?.dubai?.vibe, 'luxury');

    // 2. Favicon route works cleanly
    const favRes = await fetch(`${srv.baseUrl}/favicon.svg`);
    assert.equal(favRes.status, 200);
    const favSvg = await favRes.text();
    assert.ok(favSvg.includes('<svg'));

    // 3. Bundle quote + atomic lock + confirm booking
    const hotel = snap.hotels.find((h) => h.cityKey === 'dubai');
    const flight = snap.flights.find((f) => f.destKey === 'dubai');

    const quoteRes = await fetch(`${srv.baseUrl}/api/bundle/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hotelId: hotel.id,
        hotelTierId: hotel.tiers[1].id,
        flightId: flight.id,
        flightTierId: flight.tiers[1].id,
        nights: 3,
        guests: 2,
        rooms: 1,
        nationality: 'EG',
        includeVisaAssist: true,
      }),
    });
    assert.equal(quoteRes.status, 200);
    const { quote } = await quoteRes.json();
    assert.ok(quote.bundleTotalUsd < quote.separateTotalUsd + quote.visaAssistUsd);

    const lockRes = await fetch(`${srv.baseUrl}/api/locks/bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hotelId: hotel.id,
        hotelTierId: hotel.tiers[1].id,
        flightId: flight.id,
        flightTierId: flight.tiers[1].id,
        nights: 3,
        guests: 2,
        rooms: 1,
        nationality: 'EG',
        includeVisaAssist: true,
        expectedBundleTotalUsd: quote.bundleTotalUsd,
      }),
    });
    assert.equal(lockRes.status, 201);
    const locked = await lockRes.json();

    const bookRes = await fetch(`${srv.baseUrl}/api/bookings/bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lockId: locked.lock.id,
        guestName: 'Mariam Hassan',
        guestPhone: '+201022334455',
        nationality: 'EG',
        includeVisaAssist: true,
        paymentMethod: 'pay_later',
        tripMeta: { companion: 'couple', seatPref: 'window', hospitality: ['high_floor'] },
      }),
    });
    assert.equal(bookRes.status, 201);
    const booked = await bookRes.json();
    assert.ok(booked.booking.reference.startsWith('AFY-PKG-'));
    assert.equal(booked.booking.bookingType, 'bundle');
    assert.equal(booked.booking.tripMeta?.companion, 'couple');
    assert.equal(booked.booking.tripMeta?.seatPref, 'window');

    // 4. Admin markup update including packageDiscountPercent
    const markupRes = await fetch(`${srv.baseUrl}/api/admin/markup`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packageDiscountPercent: 9,
        global: { type: 'percent', value: 15 },
      }),
    });
    assert.equal(markupRes.status, 200);
    const markupData = await markupRes.json();
    assert.equal(markupData.markupConfig.packageDiscountPercent, 9);
  } finally {
    await srv.close();
  }
});

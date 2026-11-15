import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialSeedState } from '../server/seed.js';
import {
  buildPublicSnapshot,
  cancelGuestBooking,
  computeFinalPricing,
  confirmGuestBooking,
  createBundleLock,
  createInventoryLock,
  purgeExpiredLocks,
  runMarketSimulation,
  updateMarkupConfig,
} from '../server/engine.js';

test('computeFinalPricing applies provider -> category -> global priority cleanly', () => {
  const state = createInitialSeedState();
  const hotel = state.hotels[0]; // Booking.com

  // Category hotels rule is enabled (14%) by default
  const catPricing = computeFinalPricing(hotel, 'hotel', state.markupConfig);
  assert.equal(catPricing.ruleSource, 'category:hotels');
  assert.equal(catPricing.marginPercent > 0, true);
  assert.equal(catPricing.finalPriceUsd > hotel.supplierPriceUsd, true);

  // Enable provider override -> takes precedence
  updateMarkupConfig(state, {
    providers: {
      'Booking.com': { enabled: true, type: 'fixed', value: 50 },
    },
  });
  const provPricing = computeFinalPricing(hotel, 'hotel', state.markupConfig);
  assert.equal(provPricing.ruleSource, 'provider:Booking.com');
  assert.equal(provPricing.markupUsd, 50);
  assert.equal(provPricing.finalPriceUsd, hotel.supplierPriceUsd + 50);
});

test('atomic tier lock, price change conflict, sold out hiding, and cancellation restore', () => {
  const state = createInitialSeedState();
  const hotel = state.hotels[0];
  const stdTier = hotel.roomTiers[0];
  const snap = buildPublicSnapshot(state);
  const stdPricing = snap.hotels[0].tiers[0].pricing;

  // Stale expected price rejected with 409 PRICE_CHANGED
  const staleRes = createInventoryLock(state, {
    itemType: 'hotel',
    itemId: hotel.id,
    tierId: stdTier.id,
    quantity: 1,
    nights: 2,
    expectedUnitPriceUsd: stdPricing.finalPriceUsd - 15,
  });
  assert.equal(staleRes.ok, false);
  assert.equal(staleRes.status, 409);
  assert.equal(staleRes.code, 'PRICE_CHANGED');

  // Drain stock of stdTier down to 0
  const initialTierStock = stdTier.availableCount;
  const lockAll = createInventoryLock(state, {
    itemType: 'hotel',
    itemId: hotel.id,
    tierId: stdTier.id,
    quantity: Math.min(4, initialTierStock),
    nights: 1,
    expectedUnitPriceUsd: stdPricing.finalPriceUsd,
  });
  assert.equal(lockAll.ok, true);

  // Simulate confirming booking for partial quantity
  const bkg = confirmGuestBooking(state, {
    lockId: lockAll.lock.id,
    guestName: 'Test Guest',
    guestPhone: '+201000000001',
    nationality: 'EG',
    includeVisaAssist: true,
  });
  assert.equal(bkg.ok, true);
  assert.equal(bkg.booking.status, 'confirmed');
  assert.equal(stdTier.availableCount, initialTierStock - Math.min(4, initialTierStock));

  // Cancel restores tier stock back to initialTierStock
  const cancelled = cancelGuestBooking(state, bkg.booking.id);
  assert.equal(cancelled.ok, true);
  assert.equal(stdTier.availableCount, initialTierStock);
});

test('simultaneous Flight + Hotel dual-lock atomic package booking & full rollback on partial sellout', () => {
  const state = createInitialSeedState();
  const hotel = state.hotels[2]; // Dubai Marina
  const flight = state.flights[0]; // CAI -> DXB EK
  const hTier = hotel.roomTiers[1]; // Deluxe
  const fTier = flight.fareTiers[1]; // Flex

  const hBefore = hTier.availableCount;
  const fBefore = fTier.availableCount;

  // 1) Atomic lock of BOTH legs simultaneously
  const lockRes = createBundleLock(state, {
    hotelId: hotel.id,
    hotelTierId: hTier.id,
    flightId: flight.id,
    flightTierId: fTier.id,
    nights: 3,
    guests: 2,
    rooms: 1,
    nationality: 'EG',
    includeVisaAssist: true,
  });
  assert.equal(lockRes.ok, true);
  assert.equal(lockRes.status, 201);
  assert.equal(lockRes.lock.lockType, 'bundle');
  assert.equal(lockRes.quote.bundleDiscountUsd > 0, true);
  assert.equal(lockRes.quote.visaAssistUsd > 0, true);

  // Confirm BOTH in the exact same millisecond
  const pkgRes = confirmGuestBooking(state, {
    lockId: lockRes.lock.id,
    guestName: 'Youssef Al-Fayed',
    guestPhone: '+201112223334',
    nationality: 'EG',
    includeVisaAssist: true,
  });
  assert.equal(pkgRes.ok, true);
  assert.equal(pkgRes.booking.bookingType, 'bundle');
  assert.ok(pkgRes.booking.reference.startsWith('AFY-PKG-'));
  assert.equal(hTier.availableCount, hBefore - 1);
  assert.equal(fTier.availableCount, fBefore - 2);

  // Cancel package restores BOTH legs
  const cancelRes = cancelGuestBooking(state, pkgRes.booking.reference);
  assert.equal(cancelRes.ok, true);
  assert.equal(hTier.availableCount, hBefore);
  assert.equal(fTier.availableCount, fBefore);

  // 2) Partial leg sellout must fail atomically with ZERO partial lock leak
  const soldOutFlight = runMarketSimulation(state, { action: 'sellout', itemType: 'flight', itemId: flight.id });
  assert.equal(soldOutFlight.ok, true);
  const failBundle = createBundleLock(state, {
    hotelId: hotel.id,
    hotelTierId: hTier.id,
    flightId: flight.id,
    flightTierId: fTier.id,
    nights: 2,
    guests: 1,
    rooms: 1,
  });
  assert.equal(failBundle.ok, false);
  assert.equal(failBundle.status, 409);
  assert.equal(failBundle.code, 'SOLD_OUT');
  assert.equal(failBundle.failedLeg, 'flight');
  assert.equal(state.activeLocks.length, 0);
});

test('purgeExpiredLocks releases expired single and bundle reservations cleanly', () => {
  const state = createInitialSeedState();
  const res = createBundleLock(state, {
    hotelId: state.hotels[0].id,
    flightId: state.flights[0].id,
    nights: 2,
    guests: 1,
  }, 1000);
  assert.equal(res.ok, true);
  assert.equal(state.activeLocks.length, 1);

  const changed = purgeExpiredLocks(state, res.lock.expiresAt + 5);
  assert.equal(changed, true);
  assert.equal(state.activeLocks.length, 0);
});

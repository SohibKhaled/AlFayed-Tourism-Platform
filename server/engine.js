import { CITY_VIBES, CURRENCY_RATES, LOCK_TTL_MS, VISA_RULES } from './seed.js';

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function getCollection(state, itemType) {
  return itemType === 'hotel' ? state.hotels : state.flights;
}

function getTiersArray(item) {
  if (Array.isArray(item.roomTiers) && item.roomTiers.length > 0) return item.roomTiers;
  if (Array.isArray(item.fareTiers) && item.fareTiers.length > 0) return item.fareTiers;
  return null;
}

export function syncParentTotals(item) {
  const tiers = getTiersArray(item);
  if (!tiers) return;

  const activeTiers = tiers.filter((t) => t.availableCount > 0);
  const referenceTier = activeTiers[0] || tiers[0];

  item.availableCount = tiers.reduce((sum, t) => sum + Math.max(0, Number(t.availableCount) || 0), 0);
  item.supplierPriceUsd = Number(referenceTier.supplierPriceUsd);

  if (item.roomTiers) {
    item.roomTypeAr = referenceTier.nameAr;
    item.roomTypeEn = referenceTier.nameEn;
    item.boardKey = referenceTier.boardKey;
    item.boardAr = referenceTier.boardAr;
    item.boardEn = referenceTier.boardEn;
    item.freeCancellation = tiers.some((t) => t.availableCount > 0 && t.freeCancellation);
  } else if (item.fareTiers) {
    item.cabinAr = referenceTier.cabinAr;
    item.cabinEn = referenceTier.cabinEn;
    item.baggageAr = referenceTier.baggageAr;
    item.baggageEn = referenceTier.baggageEn;
    item.refundable = tiers.some((t) => t.availableCount > 0 && t.refundable);
  }
}

export function resolveActiveMarkupRule(item, itemType, markupConfig) {
  const providerRule = markupConfig.providers?.[item.provider];
  if (providerRule && providerRule.enabled) {
    return { source: `provider:${item.provider}`, ...providerRule };
  }
  const categoryKey = itemType === 'hotel' ? 'hotels' : 'flights';
  const categoryRule = markupConfig[categoryKey];
  if (categoryRule && categoryRule.enabled) {
    return { source: `category:${categoryKey}`, ...categoryRule };
  }
  return { source: 'global', ...markupConfig.global };
}

function computePricingFromSupplierUsd(supplierPriceUsd, rule) {
  const base = Number(supplierPriceUsd);
  const val = Number(rule.value) || 0;
  const rawMarkup = rule.type === 'percent' ? (base * val) / 100 : val;
  const markupUsd = round2(Math.max(0, rawMarkup));
  const finalPriceUsd = round2(base + markupUsd);
  const marginPercent = finalPriceUsd > 0 ? round2((markupUsd / finalPriceUsd) * 100) : 0;

  return {
    supplierPriceUsd: round2(base),
    markupUsd,
    finalPriceUsd,
    marginPercent,
    ruleSource: rule.source,
    ruleType: rule.type,
    ruleValue: val,
  };
}

export function computeFinalPricing(item, itemType, markupConfig) {
  const rule = resolveActiveMarkupRule(item, itemType, markupConfig);
  return computePricingFromSupplierUsd(item.supplierPriceUsd, rule);
}

/**
 * Computes locked count for a specific (itemType, itemId, optional tierId).
 * Handles both single locks and composite bundle locks.
 */
function getLockedQuantityForItem(activeLocks, itemType, itemId, tierId = null, defaultTierId = null) {
  let sum = 0;
  for (const lock of activeLocks) {
    if (lock.lockType === 'bundle') {
      const leg = itemType === 'hotel' ? lock.hotelLock : lock.flightLock;
      if (!leg || leg.itemId !== itemId) continue;
      if (tierId === null) {
        sum += leg.quantity || 1;
      } else {
        const legTier = leg.tierId || defaultTierId;
        if (legTier === tierId) sum += leg.quantity || 1;
      }
      continue;
    }

    if (lock.itemType === itemType && lock.itemId === itemId) {
      if (tierId === null) {
        sum += lock.quantity || 1;
      } else {
        const lockTier = lock.tierId || defaultTierId;
        if (lockTier === tierId) sum += lock.quantity || 1;
      }
    }
  }
  return sum;
}

export function purgeExpiredLocks(state, now = Date.now()) {
  const before = state.activeLocks.length;
  state.activeLocks = state.activeLocks.filter((l) => l.expiresAt > now);
  return before !== state.activeLocks.length;
}

export function hydrateInventoryItem(state, item, itemType) {
  const rule = resolveActiveMarkupRule(item, itemType, state.markupConfig);
  const rawTiers = getTiersArray(item);
  const defaultTierId = rawTiers?.[0]?.id || null;

  let hydratedTiers = null;
  if (rawTiers) {
    hydratedTiers = rawTiers.map((t) => {
      const lockedCount = getLockedQuantityForItem(state.activeLocks, itemType, item.id, t.id, defaultTierId);
      const effectiveAvailable = Math.max(0, t.availableCount - lockedCount);
      const pricing = computePricingFromSupplierUsd(t.supplierPriceUsd, rule);
      const status =
        t.availableCount <= 0
          ? 'sold_out'
          : effectiveAvailable <= 0
            ? 'all_locked'
            : effectiveAvailable <= 2
              ? 'low_stock'
              : 'available';
      return {
        ...t,
        pricing,
        lockedCount,
        effectiveAvailable,
        status,
      };
    });
  }

  const lockedCount = getLockedQuantityForItem(state.activeLocks, itemType, item.id, null, defaultTierId);
  const effectiveAvailable = hydratedTiers
    ? hydratedTiers.reduce((sum, t) => sum + t.effectiveAvailable, 0)
    : Math.max(0, item.availableCount - lockedCount);

  const primaryTier = hydratedTiers?.find((t) => t.effectiveAvailable > 0)
    || hydratedTiers?.find((t) => t.availableCount > 0)
    || hydratedTiers?.[0]
    || null;

  const pricing = primaryTier
    ? primaryTier.pricing
    : computePricingFromSupplierUsd(item.supplierPriceUsd, rule);

  const status =
    item.availableCount <= 0
      ? 'sold_out'
      : effectiveAvailable <= 0
        ? 'all_locked'
        : effectiveAvailable <= 2
          ? 'low_stock'
          : 'available';

  return {
    ...item,
    itemType,
    pricing,
    tiers: hydratedTiers,
    selectedTierId: primaryTier?.id || null,
    lockedCount,
    effectiveAvailable,
    status,
  };
}

export function lookupVisaRule(nationality = 'EG', countryCode = 'EG') {
  const table = VISA_RULES[nationality] || VISA_RULES.EG;
  return (
    table[countryCode] || {
      status: 'embassy',
      labelAr: 'تأكيد شروط الدخول عبر قسم التأشيرات',
      labelEn: 'Visa check via Al-Fayed Visa Desk',
      noteAr: 'فريق التأشيرات يراجع متطلبات الجواز مع الحجز مجاناً',
      noteEn: 'Visa team verifies passport rules alongside booking',
      assistFeeUsd: 55,
    }
  );
}

export function buildPublicSnapshot(state, now = Date.now()) {
  purgeExpiredLocks(state, now);

  const hotels = state.hotels.map((h) => hydrateInventoryItem(state, h, 'hotel'));
  const flights = state.flights.map((f) => hydrateInventoryItem(state, f, 'flight'));
  const activeHotels = hotels.filter((h) => h.status !== 'sold_out');
  const activeFlights = flights.filter((f) => f.status !== 'sold_out');

  const estimatedProfitUsd = round2(
    state.bookings
      .filter((b) => b.status === 'confirmed')
      .reduce((acc, b) => acc + (b.pricingSummary?.markupTotalUsd || 0), 0),
  );

  return {
    serverTime: now,
    rates: CURRENCY_RATES,
    cityVibes: CITY_VIBES,
    visaRules: VISA_RULES,
    markupConfig: state.markupConfig,
    autoPulseEnabled: state.autoPulseEnabled,
    hotels,
    flights,
    bookings: state.bookings.slice(0, 40),
    feedEvents: state.feedEvents.slice(0, 20),
    metrics: {
      activeHotelCount: activeHotels.length,
      soldOutHotelCount: hotels.length - activeHotels.length,
      activeFlightCount: activeFlights.length,
      soldOutFlightCount: flights.length - activeFlights.length,
      confirmedBookingsCount: state.bookings.filter((b) => b.status === 'confirmed').length,
      activeLocksCount: state.activeLocks.length,
      estimatedProfitUsd,
    },
  };
}

export function appendFeedEvent(state, event) {
  const entry = {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ts: Date.now(),
    severity: 'info',
    ...event,
  };
  state.feedEvents.unshift(entry);
  if (state.feedEvents.length > 35) {
    state.feedEvents.length = 35;
  }
  return entry;
}

function findTierOrDefault(hydratedItem, item, tierId = null) {
  const rawTiers = getTiersArray(item);
  if (!rawTiers) {
    return { rawTier: null, hydratedTier: null, effectiveTierId: null };
  }
  let targetId = tierId;
  if (!targetId) {
    const firstAvail = hydratedItem.tiers.find((t) => t.effectiveAvailable > 0) || hydratedItem.tiers[0];
    targetId = firstAvail.id;
  }
  const rawTier = rawTiers.find((t) => t.id === targetId);
  const hydratedTier = hydratedItem.tiers.find((t) => t.id === targetId);
  return { rawTier, hydratedTier, effectiveTierId: targetId };
}

export function createInventoryLock(
  state,
  { itemType, itemId, tierId = null, quantity = 1, nights = 1, expectedUnitPriceUsd = null },
  now = Date.now(),
) {
  purgeExpiredLocks(state, now);

  const qty = Math.max(1, Math.min(4, Number(quantity) || 1));
  const stayNights = itemType === 'hotel' ? Math.max(1, Math.min(30, Number(nights) || 1)) : 1;

  const list = getCollection(state, itemType);
  const item = list.find((entry) => entry.id === itemId);
  if (!item) {
    return {
      ok: false,
      status: 404,
      code: 'NOT_FOUND',
      messageAr: 'العرض المطلوب غير موجود.',
      messageEn: 'Requested offer was not found.',
    };
  }

  const hydrated = hydrateInventoryItem(state, item, itemType);
  const { rawTier, hydratedTier, effectiveTierId } = findTierOrDefault(hydrated, item, tierId);

  if (tierId && !rawTier) {
    return {
      ok: false,
      status: 404,
      code: 'TIER_NOT_FOUND',
      messageAr: 'الفئة أو نوع الغرفة المحدد غير متاح.',
      messageEn: 'Selected room or fare tier was not found.',
    };
  }

  const targetRawCount = rawTier ? rawTier.availableCount : item.availableCount;
  const targetEffectiveAvail = hydratedTier ? hydratedTier.effectiveAvailable : hydrated.effectiveAvailable;
  const targetPricing = hydratedTier ? hydratedTier.pricing : hydrated.pricing;

  if (targetRawCount <= 0) {
    return {
      ok: false,
      status: 409,
      code: 'SOLD_OUT',
      messageAr: 'عذراً! تم حجز آخر وحدة متاحة من المزود الآن.',
      messageEn: 'Sorry! The last unit just sold out with the supplier.',
      snapshot: buildPublicSnapshot(state, now),
    };
  }

  if (targetEffectiveAvail < qty) {
    return {
      ok: false,
      status: 409,
      code: 'TEMPORARILY_LOCKED',
      messageAr: 'عذراً، آخر وحدات هذه الفئة قيد الحجز الآن من مسافر آخر.',
      messageEn: 'Sorry, this tier is currently locked by another guest.',
      snapshot: buildPublicSnapshot(state, now),
    };
  }

  if (
    expectedUnitPriceUsd !== null &&
    expectedUnitPriceUsd !== undefined &&
    Math.abs(Number(expectedUnitPriceUsd) - targetPricing.finalPriceUsd) > 0.01
  ) {
    return {
      ok: false,
      status: 409,
      code: 'PRICE_CHANGED',
      messageAr: 'تم تحديث السعر لحظياً من المزود قبل تأكيد الطلب.',
      messageEn: 'Supplier rate updated right before locking your reservation.',
      latestUnitPriceUsd: targetPricing.finalPriceUsd,
      snapshot: buildPublicSnapshot(state, now),
    };
  }

  const unitCount = itemType === 'hotel' ? qty * stayNights : qty;
  const totalUsd = round2(targetPricing.finalPriceUsd * unitCount);
  const markupTotalUsd = round2(targetPricing.markupUsd * unitCount);

  const lock = {
    id: `lck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    lockType: 'single',
    itemType,
    itemId,
    tierId: effectiveTierId,
    tierLabelAr: rawTier ? (rawTier.nameAr || rawTier.cabinAr) : (item.roomTypeAr || item.cabinAr),
    tierLabelEn: rawTier ? (rawTier.nameEn || rawTier.cabinEn) : (item.roomTypeEn || item.cabinEn),
    quantity: qty,
    nights: stayNights,
    unitPriceUsd: targetPricing.finalPriceUsd,
    supplierUnitPriceUsd: targetPricing.supplierPriceUsd,
    markupUnitUsd: targetPricing.markupUsd,
    totalUsd,
    markupTotalUsd,
    createdAt: now,
    expiresAt: now + LOCK_TTL_MS,
  };

  state.activeLocks.push(lock);

  const afterHydrated = hydrateInventoryItem(state, item, itemType);
  return {
    ok: true,
    status: 201,
    lock,
    item: afterHydrated,
    snapshot: buildPublicSnapshot(state, now),
  };
}

/**
 * Calculates live pricing & availability for a combined Flight + Hotel package.
 */
export function computeBundleQuote(
  state,
  {
    hotelId,
    hotelTierId = null,
    flightId,
    flightTierId = null,
    nights = 2,
    guests = 1,
    rooms = 1,
    nationality = 'EG',
    includeVisaAssist = false,
  },
) {
  const hotel = state.hotels.find((h) => h.id === hotelId);
  const flight = state.flights.find((f) => f.id === flightId);
  if (!hotel || !flight) return null;

  const hHydrated = hydrateInventoryItem(state, hotel, 'hotel');
  const fHydrated = hydrateInventoryItem(state, flight, 'flight');
  const hPick = findTierOrDefault(hHydrated, hotel, hotelTierId);
  const fPick = findTierOrDefault(fHydrated, flight, flightTierId);
  if (!hPick.hydratedTier || !fPick.hydratedTier) return null;

  const stayNights = Math.max(1, Math.min(30, Number(nights) || 2));
  const paxCount = Math.max(1, Math.min(6, Number(guests) || 1));
  const roomCount = Math.max(1, Math.min(4, Number(rooms) || 1));

  const hotelUnitUsd = hPick.hydratedTier.pricing.finalPriceUsd;
  const flightUnitUsd = fPick.hydratedTier.pricing.finalPriceUsd;

  const hotelSubtotalUsd = round2(hotelUnitUsd * stayNights * roomCount);
  const flightSubtotalUsd = round2(flightUnitUsd * paxCount);
  const separateTotalUsd = round2(hotelSubtotalUsd + flightSubtotalUsd);

  const discountPct = Number(state.markupConfig.packageDiscountPercent ?? 6);
  const bundleDiscountUsd = round2((separateTotalUsd * Math.max(0, discountPct)) / 100);

  const visaRule = lookupVisaRule(nationality, hotel.countryCode || flight.countryCode || 'AE');
  const visaAssistUsd = includeVisaAssist ? round2((visaRule.assistFeeUsd || 0) * paxCount) : 0;

  const netMarkupTotalUsd = round2(
    Math.max(
      0,
      hPick.hydratedTier.pricing.markupUsd * stayNights * roomCount
        + fPick.hydratedTier.pricing.markupUsd * paxCount
        - bundleDiscountUsd,
    ),
  );

  const bundleTotalUsd = round2(separateTotalUsd - bundleDiscountUsd + visaAssistUsd);

  return {
    hotel: hHydrated,
    hotelTier: hPick.hydratedTier,
    flight: fHydrated,
    flightTier: fPick.hydratedTier,
    nights: stayNights,
    guests: paxCount,
    rooms: roomCount,
    nationality,
    visaRule,
    includeVisaAssist: Boolean(includeVisaAssist),
    visaAssistUsd,
    hotelUnitUsd,
    flightUnitUsd,
    hotelSubtotalUsd,
    flightSubtotalUsd,
    separateTotalUsd,
    packageDiscountPercent: discountPct,
    bundleDiscountUsd,
    bundleTotalUsd,
    netMarkupTotalUsd,
  };
}

/**
 * Atomically locks BOTH a hotel room tier AND a flight fare tier in a single transaction.
 * If either leg is sold out, locked, or changed price, zero locks are created.
 */
export function createBundleLock(
  state,
  {
    hotelId,
    hotelTierId = null,
    flightId,
    flightTierId = null,
    nights = 2,
    guests = 1,
    rooms = 1,
    nationality = 'EG',
    includeVisaAssist = false,
    expectedBundleTotalUsd = null,
  },
  now = Date.now(),
) {
  purgeExpiredLocks(state, now);

  const quote = computeBundleQuote(state, {
    hotelId,
    hotelTierId,
    flightId,
    flightTierId,
    nights,
    guests,
    rooms,
    nationality,
    includeVisaAssist,
  });

  if (!quote) {
    return {
      ok: false,
      status: 404,
      code: 'NOT_FOUND',
      messageAr: 'الفندق أو رحلة الطيران المختارة غير موجودة.',
      messageEn: 'Selected hotel or flight offer was not found.',
    };
  }

  if (quote.hotelTier.availableCount <= 0) {
    return {
      ok: false,
      status: 409,
      code: 'SOLD_OUT',
      failedLeg: 'hotel',
      messageAr: `نأسف! الغرف المحددة في ${quote.hotel.nameAr} نفدت للتو.`,
      messageEn: `Sorry! Selected rooms at ${quote.hotel.nameEn} just sold out.`,
      snapshot: buildPublicSnapshot(state, now),
    };
  }

  if (quote.hotelTier.effectiveAvailable < quote.rooms) {
    return {
      ok: false,
      status: 409,
      code: 'TEMPORARILY_LOCKED',
      failedLeg: 'hotel',
      messageAr: `عدد الغرف المتاحة في ${quote.hotel.nameAr} لم يعد كافياً الآن.`,
      messageEn: `Rooms at ${quote.hotel.nameEn} are temporarily held by another traveler.`,
      snapshot: buildPublicSnapshot(state, now),
    };
  }

  if (quote.flightTier.availableCount <= 0) {
    return {
      ok: false,
      status: 409,
      code: 'SOLD_OUT',
      failedLeg: 'flight',
      messageAr: `نأسف! المقاعد على رحلة ${quote.flight.flightNumber} نفدت للتو.`,
      messageEn: `Sorry! Seats on flight ${quote.flight.flightNumber} just sold out.`,
      snapshot: buildPublicSnapshot(state, now),
    };
  }

  if (quote.flightTier.effectiveAvailable < quote.guests) {
    return {
      ok: false,
      status: 409,
      code: 'TEMPORARILY_LOCKED',
      failedLeg: 'flight',
      messageAr: `المقاعد المتبقية على رحلة ${quote.flight.flightNumber} محجوزة مؤقتاً الآن.`,
      messageEn: `Seats on flight ${quote.flight.flightNumber} are temporarily held.`,
      snapshot: buildPublicSnapshot(state, now),
    };
  }

  if (
    expectedBundleTotalUsd !== null &&
    expectedBundleTotalUsd !== undefined &&
    Math.abs(Number(expectedBundleTotalUsd) - quote.bundleTotalUsd) > 0.05
  ) {
    return {
      ok: false,
      status: 409,
      code: 'PRICE_CHANGED',
      latestBundleTotalUsd: quote.bundleTotalUsd,
      messageAr: 'تغير سعر أحد طرفي الباكيدج لحظياً من المزود.',
      messageEn: 'One leg of your package updated its live rate before locking.',
      snapshot: buildPublicSnapshot(state, now),
    };
  }

  const lock = {
    id: `lck-pkg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    lockType: 'bundle',
    hotelLock: {
      itemType: 'hotel',
      itemId: quote.hotel.id,
      tierId: quote.hotelTier.id,
      tierLabelAr: quote.hotelTier.nameAr,
      tierLabelEn: quote.hotelTier.nameEn,
      quantity: quote.rooms,
      nights: quote.nights,
      unitPriceUsd: quote.hotelUnitUsd,
      supplierUnitPriceUsd: quote.hotelTier.pricing.supplierPriceUsd,
      markupUnitUsd: quote.hotelTier.pricing.markupUsd,
      subtotalUsd: quote.hotelSubtotalUsd,
    },
    flightLock: {
      itemType: 'flight',
      itemId: quote.flight.id,
      tierId: quote.flightTier.id,
      tierLabelAr: quote.flightTier.cabinAr,
      tierLabelEn: quote.flightTier.cabinEn,
      quantity: quote.guests,
      unitPriceUsd: quote.flightUnitUsd,
      supplierUnitPriceUsd: quote.flightTier.pricing.supplierPriceUsd,
      markupUnitUsd: quote.flightTier.pricing.markupUsd,
      subtotalUsd: quote.flightSubtotalUsd,
    },
    packageDiscountPercent: quote.packageDiscountPercent,
    bundleDiscountUsd: quote.bundleDiscountUsd,
    nationality: quote.nationality,
    includeVisaAssist: quote.includeVisaAssist,
    visaAssistUsd: quote.visaAssistUsd,
    visaRule: quote.visaRule,
    totalUsd: quote.bundleTotalUsd,
    markupTotalUsd: quote.netMarkupTotalUsd,
    createdAt: now,
    expiresAt: now + LOCK_TTL_MS,
  };

  state.activeLocks.push(lock);

  return {
    ok: true,
    status: 201,
    lock,
    quote,
    snapshot: buildPublicSnapshot(state, now),
  };
}

export function releaseInventoryLock(state, lockId) {
  const before = state.activeLocks.length;
  state.activeLocks = state.activeLocks.filter((l) => l.id !== lockId);
  return before !== state.activeLocks.length;
}

export function confirmGuestBooking(
  state,
  {
    lockId,
    guestName,
    guestEmail,
    guestPhone,
    checkInDate = null,
    checkOutDate = null,
    nationality = 'EG',
    includeVisaAssist = false,
    paymentMethod = 'pay_later',
    notes = '',
    tripMeta = null,
  },
  now = Date.now(),
) {
  purgeExpiredLocks(state, now);

  if (!guestName || !String(guestName).trim() || !guestPhone || !String(guestPhone).trim()) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      messageAr: 'يرجى إدخال اسم المسافر ورقم الهاتف للتأكيد بدون حساب.',
      messageEn: 'Traveler name and phone are required for zero-login confirmation.',
    };
  }

  const lockIdx = state.activeLocks.findIndex((l) => l.id === lockId);
  if (lockIdx === -1) {
    return {
      ok: false,
      status: 409,
      code: 'LOCK_EXPIRED',
      messageAr: 'انتهت مهلة تثبيت السعر اللحظي، يرجى إعادة التثبيت للحصول على أحدث سعر.',
      messageEn: 'Price hold expired. Please re-lock the latest real-time offer.',
      snapshot: buildPublicSnapshot(state, now),
    };
  }

  const lock = state.activeLocks[lockIdx];
  if (lock.lockType === 'bundle') {
    return confirmBundleLockInternal(
      state,
      lockIdx,
      lock,
      {
        guestName,
        guestEmail,
        guestPhone,
        checkInDate,
        checkOutDate,
        nationality,
        includeVisaAssist,
        paymentMethod,
        notes,
        tripMeta,
      },
      now,
    );
  }

  const list = getCollection(state, lock.itemType);
  const item = list.find((entry) => entry.id === lock.itemId);
  const tiers = item ? getTiersArray(item) : null;
  const targetTier = tiers ? tiers.find((t) => t.id === (lock.tierId || tiers[0].id)) : null;

  const availNow = targetTier ? targetTier.availableCount : (item ? item.availableCount : 0);
  if (!item || availNow < lock.quantity) {
    state.activeLocks.splice(lockIdx, 1);
    return {
      ok: false,
      status: 409,
      code: 'SOLD_OUT',
      messageAr: 'نفدت الكمية من المزود قبل لحظة التأكيد النهائي.',
      messageEn: 'Supplier inventory ran out right before final confirmation.',
      snapshot: buildPublicSnapshot(state, now),
    };
  }

  // Atomic deduction on the selected tier & parent sync
  if (targetTier) {
    targetTier.availableCount = Math.max(0, targetTier.availableCount - lock.quantity);
    syncParentTotals(item);
  } else {
    item.availableCount = Math.max(0, item.availableCount - lock.quantity);
  }
  item.lastUpdatedAt = now;
  state.activeLocks.splice(lockIdx, 1);

  const visaRule = lookupVisaRule(nationality, item.countryCode || 'EG');
  const paxCount = lock.quantity;
  const visaFeeUsd = includeVisaAssist ? round2((visaRule.assistFeeUsd || 0) * paxCount) : 0;
  const finalTotalUsd = round2(lock.totalUsd + visaFeeUsd);

  const ref = `AFY-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const booking = {
    id: `bkg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    bookingType: 'single',
    reference: ref,
    status: 'confirmed',
    itemType: lock.itemType,
    itemId: item.id,
    tierId: lock.tierId || null,
    tierLabelAr: lock.tierLabelAr || '',
    tierLabelEn: lock.tierLabelEn || '',
    provider: item.provider,
    titleAr:
      lock.itemType === 'hotel'
        ? `${item.nameAr} (${lock.tierLabelAr || item.roomTypeAr})`
        : `${item.airlineAr} (${item.originCode} → ${item.destCode} • ${lock.tierLabelAr || item.cabinAr})`,
    titleEn:
      lock.itemType === 'hotel'
        ? `${item.nameEn} (${lock.tierLabelEn || item.roomTypeEn})`
        : `${item.airlineEn} (${item.originCode} → ${item.destCode} • ${lock.tierLabelEn || item.cabinEn})`,
    guestName: String(guestName).trim(),
    guestEmail: String(guestEmail || '').trim(),
    guestPhone: String(guestPhone).trim(),
    nationality,
    includeVisaAssist: Boolean(includeVisaAssist && visaFeeUsd > 0),
    visaRule,
    checkInDate: checkInDate || new Date(now + 86400000 * 3).toISOString().slice(0, 10),
    checkOutDate: checkOutDate || null,
    quantity: lock.quantity,
    nights: lock.nights,
    paymentMethod,
    notes: String(notes || '').trim(),
    tripMeta: tripMeta && typeof tripMeta === 'object' ? tripMeta : null,
    pricingSummary: {
      unitPriceUsd: lock.unitPriceUsd,
      supplierUnitPriceUsd: lock.supplierUnitPriceUsd,
      markupUnitUsd: lock.markupUnitUsd,
      visaAssistUsd: visaFeeUsd,
      totalUsd: finalTotalUsd,
      markupTotalUsd: lock.markupTotalUsd,
    },
    createdAt: now,
  };

  state.bookings.unshift(booking);

  appendFeedEvent(state, {
    severity: availNow - lock.quantity <= 0 ? 'warning' : 'success',
    provider: item.provider,
    messageAr:
      item.availableCount <= 0
        ? `تم حجز آخر وحدة في «${item.nameAr || item.airlineAr}» — تم الإخفاء تلقائياً (${ref})`
        : `تأكيد حجز فوري بدون حساب عبر ${item.provider} — مرجع ${ref}`,
    messageEn:
      item.availableCount <= 0
        ? `Last unit booked on ${item.nameEn || item.airlineEn} — auto-hidden (${ref})`
        : `Instant zero-login booking via ${item.provider} — Ref ${ref}`,
  });

  return {
    ok: true,
    status: 201,
    booking,
    snapshot: buildPublicSnapshot(state, now),
  };
}

function confirmBundleLockInternal(
  state,
  lockIdx,
  lock,
  { guestName, guestEmail, guestPhone, checkInDate, checkOutDate, nationality, includeVisaAssist, paymentMethod, notes, tripMeta = null },
  now,
) {
  const hotel = state.hotels.find((h) => h.id === lock.hotelLock.itemId);
  const flight = state.flights.find((f) => f.id === lock.flightLock.itemId);
  const hotelTier = hotel?.roomTiers?.find((t) => t.id === lock.hotelLock.tierId) || hotel?.roomTiers?.[0];
  const flightTier = flight?.fareTiers?.find((t) => t.id === lock.flightLock.tierId) || flight?.fareTiers?.[0];

  if (!hotel || !hotelTier || hotelTier.availableCount < lock.hotelLock.quantity) {
    state.activeLocks.splice(lockIdx, 1);
    return {
      ok: false,
      status: 409,
      code: 'SOLD_OUT',
      failedLeg: 'hotel',
      messageAr: 'نأسف! نفدت الغرف المختارة في الفندق قبل اللحظة النهائية للتأكيد.',
      messageEn: 'Sorry! The selected hotel tier ran out right before bundle confirmation.',
      snapshot: buildPublicSnapshot(state, now),
    };
  }

  if (!flight || !flightTier || flightTier.availableCount < lock.flightLock.quantity) {
    state.activeLocks.splice(lockIdx, 1);
    return {
      ok: false,
      status: 409,
      code: 'SOLD_OUT',
      failedLeg: 'flight',
      messageAr: 'نأسف! نفدت مقاعد الرحلة الجوية قبل اللحظة النهائية للتأكيد.',
      messageEn: 'Sorry! Flight seats ran out right before bundle confirmation.',
      snapshot: buildPublicSnapshot(state, now),
    };
  }

  // Simultaneous same-millisecond atomic deduction across BOTH legs
  hotelTier.availableCount = Math.max(0, hotelTier.availableCount - lock.hotelLock.quantity);
  flightTier.availableCount = Math.max(0, flightTier.availableCount - lock.flightLock.quantity);
  syncParentTotals(hotel);
  syncParentTotals(flight);
  hotel.lastUpdatedAt = now;
  flight.lastUpdatedAt = now;
  state.activeLocks.splice(lockIdx, 1);

  const chosenNat = nationality || lock.nationality || 'EG';
  const visaRule = lock.visaRule || lookupVisaRule(chosenNat, hotel.countryCode || flight.countryCode || 'AE');
  const wantVisa = typeof includeVisaAssist === 'boolean' ? includeVisaAssist : Boolean(lock.includeVisaAssist);
  const visaFeeUsd = wantVisa ? round2((visaRule.assistFeeUsd || 0) * lock.flightLock.quantity) : 0;

  const basePreDiscount = round2(lock.hotelLock.subtotalUsd + lock.flightLock.subtotalUsd);
  const totalUsd = round2(basePreDiscount - lock.bundleDiscountUsd + visaFeeUsd);

  const ref = `AFY-PKG-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const booking = {
    id: `bkg-pkg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    bookingType: 'bundle',
    reference: ref,
    status: 'confirmed',
    itemType: 'bundle',
    provider: `${hotel.provider} + ${flight.provider}`,
    titleAr: `باكيدج: ${hotel.nameAr} + ${flight.airlineAr} (${flight.originCode}→${flight.destCode})`,
    titleEn: `Bundle: ${hotel.nameEn} + ${flight.airlineEn} (${flight.originCode}→${flight.destCode})`,
    hotelLeg: {
      itemId: hotel.id,
      tierId: hotelTier.id,
      nameAr: hotel.nameAr,
      nameEn: hotel.nameEn,
      tierLabelAr: lock.hotelLock.tierLabelAr,
      tierLabelEn: lock.hotelLock.tierLabelEn,
      provider: hotel.provider,
      rooms: lock.hotelLock.quantity,
      nights: lock.hotelLock.nights,
      subtotalUsd: lock.hotelLock.subtotalUsd,
    },
    flightLeg: {
      itemId: flight.id,
      tierId: flightTier.id,
      airlineAr: flight.airlineAr,
      airlineEn: flight.airlineEn,
      flightNumber: flight.flightNumber,
      originCode: flight.originCode,
      destCode: flight.destCode,
      tierLabelAr: lock.flightLock.tierLabelAr,
      tierLabelEn: lock.flightLock.tierLabelEn,
      provider: flight.provider,
      guests: lock.flightLock.quantity,
      subtotalUsd: lock.flightLock.subtotalUsd,
    },
    guestName: String(guestName).trim(),
    guestEmail: String(guestEmail || '').trim(),
    guestPhone: String(guestPhone).trim(),
    nationality: chosenNat,
    includeVisaAssist: Boolean(wantVisa && visaFeeUsd > 0),
    visaRule,
    checkInDate: checkInDate || new Date(now + 86400000 * 3).toISOString().slice(0, 10),
    checkOutDate: checkOutDate || null,
    quantity: lock.flightLock.quantity,
    nights: lock.hotelLock.nights,
    paymentMethod,
    notes: String(notes || '').trim(),
    tripMeta: tripMeta && typeof tripMeta === 'object' ? tripMeta : null,
    pricingSummary: {
      hotelSubtotalUsd: lock.hotelLock.subtotalUsd,
      flightSubtotalUsd: lock.flightLock.subtotalUsd,
      bundleDiscountUsd: lock.bundleDiscountUsd,
      packageDiscountPercent: lock.packageDiscountPercent,
      visaAssistUsd: visaFeeUsd,
      totalUsd,
      markupTotalUsd: lock.markupTotalUsd,
    },
    createdAt: now,
  };

  state.bookings.unshift(booking);

  appendFeedEvent(state, {
    severity: 'success',
    provider: 'Al-Fayed Package Engine',
    messageAr: `حجز باكيدج مزدوج في نفس الثانية (فندق + طيران) — توفير $${lock.bundleDiscountUsd} — مرجع ${ref}`,
    messageEn: `Atomic Flight+Hotel bundle booked in one millisecond (Saved $${lock.bundleDiscountUsd}) — Ref ${ref}`,
  });

  return {
    ok: true,
    status: 201,
    booking,
    snapshot: buildPublicSnapshot(state, now),
  };
}

export function cancelGuestBooking(state, bookingIdOrRef, now = Date.now()) {
  const booking = state.bookings.find((b) => b.id === bookingIdOrRef || b.reference === bookingIdOrRef);
  if (!booking) {
    return {
      ok: false,
      status: 404,
      code: 'NOT_FOUND',
      messageAr: 'لم يتم العثور على هذا الحجز.',
      messageEn: 'Booking was not found.',
    };
  }
  if (booking.status === 'cancelled') {
    return {
      ok: false,
      status: 409,
      code: 'ALREADY_CANCELLED',
      messageAr: 'هذا الحجز ملغى بالفعل.',
      messageEn: 'This booking is already cancelled.',
    };
  }

  booking.status = 'cancelled';
  booking.cancelledAt = now;

  if (booking.bookingType === 'bundle' && booking.hotelLeg && booking.flightLeg) {
    const hotel = state.hotels.find((h) => h.id === booking.hotelLeg.itemId);
    const flight = state.flights.find((f) => f.id === booking.flightLeg.itemId);
    if (hotel) {
      const hTier = hotel.roomTiers?.find((t) => t.id === booking.hotelLeg.tierId) || hotel.roomTiers?.[0];
      if (hTier) hTier.availableCount += booking.hotelLeg.rooms;
      syncParentTotals(hotel);
      hotel.lastUpdatedAt = now;
    }
    if (flight) {
      const fTier = flight.fareTiers?.find((t) => t.id === booking.flightLeg.tierId) || flight.fareTiers?.[0];
      if (fTier) fTier.availableCount += booking.flightLeg.guests;
      syncParentTotals(flight);
      flight.lastUpdatedAt = now;
    }
  } else {
    const list = getCollection(state, booking.itemType);
    const item = list.find((entry) => entry.id === booking.itemId);
    if (item) {
      const tiers = getTiersArray(item);
      const targetTier = tiers
        ? tiers.find((t) => t.id === booking.tierId) || tiers[0]
        : null;
      if (targetTier) {
        targetTier.availableCount += booking.quantity;
        syncParentTotals(item);
      } else {
        item.availableCount += booking.quantity;
      }
      item.lastUpdatedAt = now;
    }
  }

  appendFeedEvent(state, {
    severity: 'info',
    provider: booking.provider,
    messageAr: `إلغاء الحجز ${booking.reference} وإعادة الوحدات فوراً للمتوفر اللحظي`,
    messageEn: `Booking ${booking.reference} cancelled — inventory restored to live availability`,
  });

  return {
    ok: true,
    status: 200,
    booking,
    snapshot: buildPublicSnapshot(state, now),
  };
}

export function updateMarkupConfig(state, patch) {
  if (patch.global) {
    state.markupConfig.global = {
      type: patch.global.type === 'fixed' ? 'fixed' : 'percent',
      value: Math.max(0, Number(patch.global.value) || 0),
    };
  }
  if (patch.hotels) {
    state.markupConfig.hotels = {
      enabled: Boolean(patch.hotels.enabled),
      type: patch.hotels.type === 'fixed' ? 'fixed' : 'percent',
      value: Math.max(0, Number(patch.hotels.value) || 0),
    };
  }
  if (patch.flights) {
    state.markupConfig.flights = {
      enabled: Boolean(patch.flights.enabled),
      type: patch.flights.type === 'fixed' ? 'fixed' : 'percent',
      value: Math.max(0, Number(patch.flights.value) || 0),
    };
  }
  if (patch.packageDiscountPercent !== undefined) {
    state.markupConfig.packageDiscountPercent = Math.max(0, Math.min(30, Number(patch.packageDiscountPercent) || 0));
  }
  if (patch.providers && typeof patch.providers === 'object') {
    for (const [providerName, rule] of Object.entries(patch.providers)) {
      if (state.markupConfig.providers[providerName]) {
        state.markupConfig.providers[providerName] = {
          enabled: Boolean(rule.enabled),
          type: rule.type === 'fixed' ? 'fixed' : 'percent',
          value: Math.max(0, Number(rule.value) || 0),
        };
      }
    }
  }

  appendFeedEvent(state, {
    severity: 'info',
    provider: 'Al-Fayed Margin Engine',
    messageAr: 'تم تحديث قواعد هامش الربح وخصم الباكيدج وبث الأسعار الجديدة فوراً للعملاء',
    messageEn: 'Margin & package discount rules updated and pushed live to all connected visitors',
  });

  return state.markupConfig;
}

export function runMarketSimulation(state, { action, itemType = 'hotel', itemId = null, tierId = null }, now = Date.now()) {
  if (action === 'reset_all') {
    for (const hotel of state.hotels) {
      if (hotel.roomTiers) {
        for (const t of hotel.roomTiers) {
          t.supplierPriceUsd = t.initialSupplierPriceUsd;
          t.availableCount = t.initialAvailableCount;
        }
        syncParentTotals(hotel);
      } else {
        hotel.supplierPriceUsd = hotel.initialSupplierPriceUsd;
        hotel.availableCount = hotel.initialAvailableCount;
      }
      hotel.priceTrend = 'stable';
      hotel.lastUpdatedAt = now;
    }
    for (const flight of state.flights) {
      if (flight.fareTiers) {
        for (const t of flight.fareTiers) {
          t.supplierPriceUsd = t.initialSupplierPriceUsd;
          t.availableCount = t.initialAvailableCount;
        }
        syncParentTotals(flight);
      } else {
        flight.supplierPriceUsd = flight.initialSupplierPriceUsd;
        flight.availableCount = flight.initialAvailableCount;
      }
      flight.priceTrend = 'stable';
      flight.lastUpdatedAt = now;
    }
    state.activeLocks = [];

    appendFeedEvent(state, {
      severity: 'info',
      provider: 'Global EIS',
      messageAr: 'تمت إعادة ضبط المخزون والأسعار اللحظية لجميع الفنادق والطيران',
      messageEn: 'All hotel and flight inventories & supplier rates reset to initial live feed',
    });

    return { ok: true, action, snapshot: buildPublicSnapshot(state, now) };
  }

  const collection = getCollection(state, itemType);
  const candidates = itemId ? collection.filter((x) => x.id === itemId) : collection.filter((x) => x.availableCount > 0);
  const target = candidates[0] || collection[0];

  if (!target) {
    return { ok: false, status: 404, code: 'NOT_FOUND' };
  }

  const tiers = getTiersArray(target);
  const nameAr = itemType === 'hotel' ? target.nameAr : `${target.airlineAr} ${target.flightNumber}`;
  const nameEn = itemType === 'hotel' ? target.nameEn : `${target.airlineEn} ${target.flightNumber}`;

  if (action === 'sellout') {
    if (tierId && tiers) {
      const t = tiers.find((x) => x.id === tierId);
      if (t) t.availableCount = 0;
      syncParentTotals(target);
    } else {
      if (tiers) {
        for (const t of tiers) t.availableCount = 0;
      }
      target.availableCount = 0;
    }
    target.lastUpdatedAt = now;
    appendFeedEvent(state, {
      severity: 'warning',
      provider: target.provider,
      messageAr: `نفاد لحظي: انتهت الوحدات المتاحة في «${nameAr}» وتم إخفاؤه فوراً`,
      messageEn: `Real-time sellout: ${nameEn} reached 0 units and was hidden immediately`,
    });
  } else if (action === 'restock') {
    if (tiers) {
      for (const t of tiers) {
        t.availableCount = Math.max(t.initialAvailableCount, 3);
      }
      syncParentTotals(target);
    } else {
      target.availableCount = Math.max(target.initialAvailableCount, 3);
    }
    target.lastUpdatedAt = now;
    appendFeedEvent(state, {
      severity: 'success',
      provider: target.provider,
      messageAr: `إعادة إتاحة لحظية: عادت وحدات «${nameAr}» عبر ${target.provider}`,
      messageEn: `Instant restock: ${nameEn} is available again via ${target.provider}`,
    });
  } else if (action === 'price_hike' || action === 'price_drop') {
    const multiplier = action === 'price_hike' ? 1.09 : 0.92;
    if (tiers) {
      for (const t of tiers) {
        t.supplierPriceUsd = Math.max(25, round2(t.supplierPriceUsd * multiplier));
      }
      syncParentTotals(target);
    } else {
      target.supplierPriceUsd = Math.max(25, round2(target.supplierPriceUsd * multiplier));
    }
    target.priceTrend = action === 'price_hike' ? 'up' : 'down';
    target.lastUpdatedAt = now;
    appendFeedEvent(state, {
      severity: 'info',
      provider: target.provider,
      messageAr:
        action === 'price_hike'
          ? `تحديث سعر (+9%) من ${target.provider} على «${nameAr}»`
          : `انخفاض فوري (-8%) من ${target.provider} على «${nameAr}»`,
      messageEn:
        action === 'price_hike'
          ? `Live supplier +9% update from ${target.provider} on ${nameEn}`
          : `Instant -8% drop from ${target.provider} on ${nameEn}`,
    });
  }

  return { ok: true, action, item: target, snapshot: buildPublicSnapshot(state, now) };
}

export function applySubtleMarketPulse(state, now = Date.now()) {
  if (!state.autoPulseEnabled) return null;

  const activeItems = [
    ...state.hotels.filter((h) => h.availableCount > 0).map((h) => ({ type: 'hotel', item: h })),
    ...state.flights.filter((f) => f.availableCount > 0).map((f) => ({ type: 'flight', item: f })),
  ];
  if (activeItems.length === 0) return null;

  const pick = activeItems[Math.floor(Math.random() * activeItems.length)];
  const deltaRatio = (Math.random() - 0.48) * 0.032; // subtle -1.5% .. +1.6%
  const factor = 1 + deltaRatio;

  const tiers = getTiersArray(pick.item);
  if (tiers) {
    for (const t of tiers) {
      const floor = t.initialSupplierPriceUsd * 0.85;
      const ceil = t.initialSupplierPriceUsd * 1.25;
      const candidate = round2(t.supplierPriceUsd * factor);
      t.supplierPriceUsd = Math.min(ceil, Math.max(floor, candidate));
    }
    syncParentTotals(pick.item);
  } else {
    const floor = pick.item.initialSupplierPriceUsd * 0.85;
    const ceil = pick.item.initialSupplierPriceUsd * 1.25;
    const candidate = round2(pick.item.supplierPriceUsd * factor);
    pick.item.supplierPriceUsd = Math.min(ceil, Math.max(floor, candidate));
  }

  pick.item.priceTrend = deltaRatio > 0.002 ? 'up' : deltaRatio < -0.002 ? 'down' : 'stable';
  pick.item.lastUpdatedAt = now;

  const titleAr = pick.type === 'hotel' ? pick.item.nameAr : `${pick.item.airlineAr} ${pick.item.flightNumber}`;
  const titleEn = pick.type === 'hotel' ? pick.item.nameEn : `${pick.item.airlineEn} ${pick.item.flightNumber}`;

  appendFeedEvent(state, {
    severity: 'info',
    provider: pick.item.provider,
    messageAr: `مزامنة لحظية (${pick.item.provider}): تحديث السعر المباشر في «${titleAr}»`,
    messageEn: `Live sync (${pick.item.provider}): updated live rate for ${titleEn}`,
  });

  return buildPublicSnapshot(state, now);
}

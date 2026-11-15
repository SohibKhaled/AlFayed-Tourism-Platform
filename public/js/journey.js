import { confirmBooking, confirmBundleBooking, lockBundle, lockInventory } from './api.js';
import { brandCrestSvg, iconSvg } from './icons.js';
import { diffDays, formatCurrency, t } from './i18n.js';

const SUPPORTS_USER_INVALID =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('selector(:user-invalid)');
const touchedFields = new WeakMap();

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function addDaysIso(baseIso, deltaDays) {
  const baseMs = new Date(`${baseIso}T00:00:00Z`).getTime();
  if (!Number.isFinite(baseMs)) {
    return new Date(Date.now() + 86400000 * deltaDays).toISOString().slice(0, 10);
  }
  return new Date(baseMs + deltaDays * 86400000).toISOString().slice(0, 10);
}

function getVisaRule(snapshot, nationality, countryCode) {
  const table = snapshot?.visaRules?.[nationality] || snapshot?.visaRules?.EG || {};
  return (
    table[countryCode] || {
      status: 'embassy',
      labelAr: 'تأشيرة / مراجعة مستندات عبر الفايد',
      labelEn: 'Visa check via Al-Fayed Desk',
      noteAr: 'إصدار حجوزات فندق وطيران صالحة للسفارات',
      noteEn: 'Embassy-ready confirmed bookings',
      assistFeeUsd: 55,
    }
  );
}

function visaChipClass(status) {
  if (status === 'free' || status === 'domestic') return 'visa-free';
  if (status === 'embassy') return 'visa-embassy';
  return '';
}

function getSelectedCityKey(state) {
  const dest = state.filters.destination;
  if (dest && dest !== 'all') return dest;
  const hotels = state.snapshot?.hotels || [];
  if (state.bundle.hotelId) {
    const h = hotels.find((item) => item.id === state.bundle.hotelId);
    if (h) return h.cityKey;
  }
  return hotels.find((h) => h.cityKey === 'dubai')?.cityKey || hotels[0]?.cityKey || 'dubai';
}

function getCityCatalog(snapshot) {
  if (!snapshot) return [];
  const byCity = new Map();

  for (const h of snapshot.hotels || []) {
    if (!byCity.has(h.cityKey)) {
      const vibeInfo = snapshot.cityVibes?.[h.cityKey] || {
        vibe: 'luxury',
        tagAr: 'وجهة مميزة',
        tagEn: 'Featured',
      };
      byCity.set(h.cityKey, {
        cityKey: h.cityKey,
        cityAr: h.cityAr,
        cityEn: h.cityEn,
        countryCode: h.countryCode,
        countryAr: h.countryAr,
        countryEn: h.countryEn,
        vibe: vibeInfo.vibe,
        tagAr: vibeInfo.tagAr,
        tagEn: vibeInfo.tagEn,
        image: h.image,
        destCode: null,
        minHotelUsd: Infinity,
        hotels: [],
        flights: [],
        availableUnits: 0,
      });
    }
    const entry = byCity.get(h.cityKey);
    entry.hotels.push(h);
    entry.availableUnits += Math.max(0, Number(h.effectiveAvailable || 0));
    if (h.status !== 'sold_out' && h.pricing?.finalPriceUsd < entry.minHotelUsd) {
      entry.minHotelUsd = h.pricing.finalPriceUsd;
    }
  }

  for (const f of snapshot.flights || []) {
    const entry = byCity.get(f.destKey);
    if (entry) {
      entry.flights.push(f);
      if (!entry.destCode) entry.destCode = f.destCode;
    }
  }

  return Array.from(byCity.values()).map((c) => ({
    ...c,
    destCode: c.destCode || c.cityKey.slice(0, 3).toUpperCase(),
    minHotelUsd: Number.isFinite(c.minHotelUsd) ? c.minHotelUsd : c.hotels[0]?.pricing?.finalPriceUsd || 150,
  }));
}

function ensureCitySelections(state, cityKey) {
  const snap = state.snapshot;
  if (!snap) return;

  const cityHotels = snap.hotels.filter((h) => h.cityKey === cityKey);
  const currentHotel = cityHotels.find((h) => h.id === state.bundle.hotelId);
  if (!currentHotel && cityHotels.length > 0) {
    const pickedH = cityHotels.find((h) => h.status !== 'sold_out') || cityHotels[0];
    state.bundle.hotelId = pickedH.id;
    const pickedTier = pickedH.tiers?.find((tr) => tr.effectiveAvailable > 0) || pickedH.tiers?.[0];
    state.bundle.hotelTierId = pickedTier?.id || null;
    if (pickedTier) state.selectedTiers[pickedH.id] = pickedTier.id;
  }

  const originFilter = state.filters.origin;
  const cityFlights = snap.flights.filter(
    (f) => f.destKey === cityKey && (originFilter === 'all' || f.originCode === originFilter),
  );
  const fallbackFlights = cityFlights.length > 0 ? cityFlights : snap.flights.filter((f) => f.destKey === cityKey);
  const currentFlight = fallbackFlights.find((f) => f.id === state.bundle.flightId);

  if (!currentFlight && fallbackFlights.length > 0) {
    const pickedF = fallbackFlights.find((f) => f.status !== 'sold_out') || fallbackFlights[0];
    state.bundle.flightId = pickedF.id;
    const pickedFTier = pickedF.tiers?.find((tr) => tr.effectiveAvailable > 0) || pickedF.tiers?.[0];
    state.bundle.flightTierId = pickedFTier?.id || null;
    if (pickedFTier) state.selectedTiers[pickedF.id] = pickedFTier.id;
  }
}

export function computeJourneySummary(state) {
  const snap = state.snapshot;
  const cities = getCityCatalog(snap);
  const cityKey = getSelectedCityKey(state);
  const cityInfo = cities.find((c) => c.cityKey === cityKey) || cities[0];
  if (!snap || !cityInfo) return null;

  const hotel =
    snap.hotels.find((h) => h.id === state.bundle.hotelId && h.cityKey === cityInfo.cityKey) ||
    cityInfo.hotels.find((h) => h.status !== 'sold_out') ||
    cityInfo.hotels[0] ||
    null;

  const hTier = hotel
    ? hotel.tiers?.find((tr) => tr.id === (state.bundle.hotelTierId || state.selectedTiers[hotel.id])) ||
      hotel.tiers?.find((tr) => tr.effectiveAvailable > 0) ||
      hotel.tiers?.[0] ||
      null
    : null;

  const includeFlight = Boolean(state.journey.includeFlight);
  const matchingFlights = cityInfo.flights.filter(
    (f) => state.filters.origin === 'all' || f.originCode === state.filters.origin,
  );
  const flightPool = matchingFlights.length > 0 ? matchingFlights : cityInfo.flights;
  const flight = includeFlight
    ? flightPool.find((f) => f.id === state.bundle.flightId) ||
      flightPool.find((f) => f.status !== 'sold_out') ||
      flightPool[0] ||
      null
    : null;

  const fTier = flight
    ? flight.tiers?.find((tr) => tr.id === (state.bundle.flightTierId || state.selectedTiers[flight.id])) ||
      flight.tiers?.find((tr) => tr.effectiveAvailable > 0) ||
      flight.tiers?.[0] ||
      null
    : null;

  const nights = Math.max(1, Number(state.filters.nights) || 2);
  const rooms = Math.max(1, Number(state.filters.rooms) || 1);
  const pax = Math.max(1, (Number(state.filters.adults) || 2) + (Number(state.filters.children) || 0));

  const hotelSubUsd = hTier ? hTier.pricing.finalPriceUsd * nights * rooms : 0;
  const flightSubUsd = fTier ? fTier.pricing.finalPriceUsd * pax : 0;
  const separateUsd = Math.round((hotelSubUsd + flightSubUsd) * 100) / 100;
  const pct = Number(snap.markupConfig?.packageDiscountPercent ?? 6);
  const discountUsd = hotel && flight ? Math.round(((separateUsd * pct) / 100) * 100) / 100 : 0;

  const visaRule = getVisaRule(snap, state.filters.nationality, cityInfo.countryCode);
  const visaMultiplier = includeFlight && flight ? pax : rooms;
  const visaFeeUsd = state.journey.includeVisaAssist
    ? Math.round(Number(visaRule.assistFeeUsd || 0) * visaMultiplier * 100) / 100
    : 0;
  const totalUsd = Math.round((separateUsd - discountUsd + visaFeeUsd) * 100) / 100;

  return {
    cities,
    cityInfo,
    hotel,
    hTier,
    flight,
    fTier,
    includeFlight: Boolean(includeFlight && flight),
    nights,
    rooms,
    pax,
    hotelSubUsd,
    flightSubUsd,
    discountUsd,
    pct,
    visaRule,
    visaFeeUsd,
    totalUsd,
  };
}

/**
 * Directional View Transitions per modern-web-guidance:
 * Checks CSS/browser support, assigns forward/backward types, and restores focus cleanly.
 */
function runDirectionalTransition(direction, updateFn, focusSelector) {
  if (!document.startViewTransition) {
    updateFn();
    if (focusSelector) {
      document.querySelector(focusSelector)?.focus({ preventScroll: true });
    }
    return;
  }

  const transition = document.startViewTransition({
    update: updateFn,
    types: [direction || 'forward'],
  });
  transition.finished.finally(() => {
    if (focusSelector) {
      document.querySelector(focusSelector)?.focus({ preventScroll: true });
    }
  });
}

function getSeatLabel(lang, seatPref) {
  const keys = { window: 'seatWindow', aisle: 'seatAisle', family: 'seatFamily' };
  return t(lang, keys[seatPref] || 'seatWindow');
}

function getCompanionLabel(lang, comp) {
  const keys = {
    couple: 'companionCouple',
    family: 'companionFamily',
    business: 'companionBusiness',
    solo: 'companionSolo',
  };
  return t(lang, keys[comp] || 'companionCouple');
}

function getHospitalityLabel(lang, key) {
  const keys = {
    high_floor: 'hospHighFloor',
    early_checkin: 'hospEarlyCheckin',
    vip_welcome: 'hospVipWelcome',
    airport_transfer: 'hospAirportTransfer',
  };
  return t(lang, keys[key] || key);
}

function renderLiveBoardingPassHtml(state) {
  const summary = computeJourneySummary(state);
  if (!summary) return '';

  const isAr = state.lang === 'ar';
  const rates = state.snapshot.rates;
  const { cityInfo, hotel, hTier, flight, fTier, nights, rooms, pax, discountUsd, pct, visaFeeUsd, totalUsd } = summary;
  const completed = state.journey.completedBooking;

  const originCode = flight?.originCode || (state.filters.origin !== 'all' ? state.filters.origin : 'CAI');
  const originLabel = flight
    ? isAr
      ? flight.originAr
      : flight.originEn
    : state.filters.origin !== 'all'
      ? state.filters.origin
      : isAr
        ? 'القاهرة'
        : 'Cairo';
  const destLabel = isAr ? cityInfo.cityAr : cityInfo.cityEn;
  const passengerDisplay =
    completed?.guestName || state.journey.draftName?.trim() || t(state.lang, 'boardingGuestPlaceholder');
  const dateDisplay = `${state.filters.checkInDate} → ${state.filters.checkOutDate}`;

  const hotelName = hotel ? (isAr ? hotel.nameAr : hotel.nameEn) : '—';
  const tierName = hTier ? (isAr ? hTier.nameAr : hTier.nameEn) : '';
  const flightDisplay = flight
    ? `${isAr ? flight.airlineAr : flight.airlineEn} (${flight.flightNumber})`
    : isAr
      ? 'إقامة فندقية فقط'
      : 'Hotel Stay Only';

  const hospCount = state.journey.hospitality?.length || 0;

  return `
    <aside class="live-boarding-pass" aria-label="${escapeHtml(t(state.lang, 'boardingTitle'))}">
      <div class="bp-top-band">
        <div style="display:flex; align-items:center; gap:0.55rem;">
          ${brandCrestSvg('bp')}
          <div style="line-height:1.15;">
            <div style="font-size:0.86rem; font-weight:800; color:#FFFFFF;">${escapeHtml(t(state.lang, 'boardingTitle'))}</div>
            <div style="font-size:0.68rem; color:var(--brand-gold-bright);">${escapeHtml(t(state.lang, 'boardingSub'))}</div>
          </div>
        </div>
        ${
          completed
            ? `<span class="boarding-confirmed-stamp">${escapeHtml(t(state.lang, 'boardingStatusConfirmed'))}</span>`
            : `<span class="amenity-chip" style="background:rgba(16,185,129,0.2); color:#6EE7B7; border:1px solid rgba(110,231,183,0.4); font-size:0.68rem;">${escapeHtml(t(state.lang, 'boardingStatusDraft'))}</span>`
        }
      </div>

      <div class="bp-route-header">
        <div>
          <div class="bp-iata-big">${escapeHtml(flight ? originCode : 'VIP')}</div>
          <div class="bp-city-sub">${escapeHtml(flight ? originLabel : t(state.lang, 'brandName'))}</div>
        </div>
        <div style="display:grid; justify-items:center; gap:0.15rem; color:var(--brand-gold-bright);">
          <span style="font-size:1.15rem;">${flight ? '✈' : '🏛️'}</span>
          <span class="mono" dir="ltr" style="font-size:0.66rem; color:var(--ink-on-dark-muted);">${nights}N • ${pax} PAX</span>
        </div>
        <div>
          <div class="bp-iata-big">${escapeHtml(cityInfo.destCode)}</div>
          <div class="bp-city-sub">${escapeHtml(destLabel)}</div>
        </div>
      </div>

      <div class="bp-tear-divider" aria-hidden="true"></div>

      <div class="bp-body-details">
        <div class="bp-kv-row">
          <span class="bp-kv-label">${escapeHtml(t(state.lang, 'boardingPassenger'))}</span>
          <span class="bp-kv-val" id="bp-passenger-name" style="color:${state.journey.draftName?.trim() || completed ? 'var(--brand-gold-bright)' : 'rgba(255,255,255,0.52)'};">
            ${escapeHtml(passengerDisplay)}
          </span>
        </div>

        <div class="bp-kv-row">
          <span class="bp-kv-label">${escapeHtml(t(state.lang, 'boardingDates'))}</span>
          <span class="bp-kv-val mono" dir="ltr" style="font-size:0.78rem;">${escapeHtml(dateDisplay)}</span>
        </div>

        <div class="bp-kv-row">
          <span class="bp-kv-label">${escapeHtml(t(state.lang, 'boardingHotel'))}</span>
          <span class="bp-kv-val" style="max-inline-size:62%;">
            ${escapeHtml(hotelName)}
            ${tierName ? `<span style="display:block; font-size:0.7rem; font-weight:500; color:var(--ink-on-dark-muted);">${escapeHtml(tierName)} (${rooms} ${t(state.lang, 'roomsShort')})</span>` : ''}
          </span>
        </div>

        <div class="bp-kv-row">
          <span class="bp-kv-label">${escapeHtml(t(state.lang, 'boardingRoute'))}</span>
          <span class="bp-kv-val" style="max-inline-size:62%;">
            ${escapeHtml(flightDisplay)}
            ${fTier ? `<span style="display:block; font-size:0.7rem; font-weight:500; color:var(--ink-on-dark-muted);">${escapeHtml(isAr ? fTier.nameAr : fTier.nameEn)}</span>` : ''}
          </span>
        </div>

        ${
          flight
            ? `
          <div class="bp-kv-row">
            <span class="bp-kv-label">${escapeHtml(t(state.lang, 'boardingSeat'))}</span>
            <span class="bp-kv-val">${escapeHtml(getSeatLabel(state.lang, state.journey.seatPref))}</span>
          </div>
        `
            : ''
        }

        <div class="bp-kv-row">
          <span class="bp-kv-label">${escapeHtml(t(state.lang, 'boardingCompanion'))}</span>
          <span class="bp-kv-val">${escapeHtml(getCompanionLabel(state.lang, state.journey.companion))}</span>
        </div>

        ${
          hospCount > 0
            ? `
          <div class="bp-kv-row">
            <span class="bp-kv-label">${isAr ? 'لمسات الضيافة' : 'Concierge'}</span>
            <span class="bp-kv-val" dir="ltr" style="color:#6EE7B7;">+${hospCount} VIP</span>
          </div>
        `
            : ''
        }
      </div>

      <div class="bp-total-footer">
        ${
          completed
            ? `
          <div class="bp-kv-row">
            <span class="bp-kv-label">${escapeHtml(t(state.lang, 'boardingRefLabel'))}</span>
            <strong class="mono" style="color:var(--brand-gold-bright); font-size:0.95rem;">${escapeHtml(completed.reference)}</strong>
          </div>
        `
            : ''
        }
        ${
          discountUsd > 0 && !completed
            ? `
          <div class="bp-kv-row">
            <span style="font-size:0.74rem; color:#6EE7B7;">${escapeHtml(t(state.lang, 'dockSavedText'))} (-${pct}%)</span>
            <span class="num" style="font-size:0.82rem; font-weight:700; color:#6EE7B7;">-${formatCurrency(discountUsd, state.currency, rates)}</span>
          </div>
        `
            : ''
        }
        ${
          visaFeeUsd > 0 && !completed
            ? `
          <div class="bp-kv-row">
            <span style="font-size:0.74rem; color:var(--brand-gold-bright);">${isAr ? 'تجهيز التأشيرة' : 'Visa Desk'}</span>
            <span class="num" style="font-size:0.8rem;">+${formatCurrency(visaFeeUsd, state.currency, rates)}</span>
          </div>
        `
            : ''
        }
        <div class="bp-kv-row" style="align-items:baseline;">
          <span class="bp-kv-label" style="font-weight:700; color:#FFFFFF;">${escapeHtml(t(state.lang, 'boardingTotal'))}</span>
          <strong class="num" style="font-size:1.38rem; color:var(--brand-gold-bright);">
            ${formatCurrency(completed ? completed.pricingSummary.totalUsd : totalUsd, state.currency, rates)}
          </strong>
        </div>
      </div>
    </aside>
  `;
}

export function refreshJourneyLivePass(root, state) {
  const slot = root?.querySelector('[data-bp-container]');
  if (!slot) return;
  slot.innerHTML = renderLiveBoardingPassHtml(state);
}

function renderStage1Html(state, summary) {
  const isAr = state.lang === 'ar';
  const rates = state.snapshot.rates;
  const activeVibe = state.journey.vibe || 'all';
  const selectedCity = getSelectedCityKey(state);

  const filteredCities = summary.cities.filter((c) => activeVibe === 'all' || c.vibe === activeVibe);

  const vibes = [
    { id: 'all', label: t(state.lang, 'vibeAll') },
    { id: 'spiritual', label: t(state.lang, 'vibeSpiritual') },
    { id: 'beach', label: t(state.lang, 'vibeBeach') },
    { id: 'luxury', label: t(state.lang, 'vibeLuxury') },
    { id: 'heritage', label: t(state.lang, 'vibeHeritage') },
  ];

  const cardsHtml = filteredCities
    .map((c) => {
      const visa = getVisaRule(state.snapshot, state.filters.nationality, c.countryCode);
      const isPicked = c.cityKey === selectedCity;
      return `
        <button type="button" class="dest-canvas-card ${isPicked ? 'is-picked' : ''}" data-j-pick-city="${escapeHtml(c.cityKey)}">
          <div class="dest-canvas-photo">
            <img src="${escapeHtml(c.image)}" alt="${escapeHtml(isAr ? c.cityAr : c.cityEn)}" loading="lazy">
            <div class="dest-canvas-overlay">
              <div style="display:flex; justify-content:space-between; gap:0.4rem; align-items:center;">
                <span class="provider-badge">${escapeHtml(isAr ? c.tagAr : c.tagEn)}</span>
                <span class="mono" style="background:rgba(6,19,38,0.82); color:var(--brand-gold-bright); padding:0.18rem 0.45rem; border-radius:var(--radius-sm); font-size:0.7rem; font-weight:800;">${escapeHtml(c.destCode)}</span>
              </div>
              <div style="color:#FFFFFF; display:flex; justify-content:space-between; align-items:flex-end; gap:0.4rem;">
                <strong style="font-size:1.05rem;">${escapeHtml(isAr ? c.cityAr : c.cityEn)}</strong>
                <span style="font-size:0.74rem; color:rgba(255,255,255,0.85);">${escapeHtml(isAr ? c.countryAr : c.countryEn)}</span>
              </div>
            </div>
          </div>
          <div class="dest-canvas-body">
            <span class="visa-mini-pill ${visaChipClass(visa.status)}">🛂 ${escapeHtml(isAr ? visa.labelAr : visa.labelEn)}</span>
            <div style="display:flex; align-items:center; justify-content:space-between; margin-block-start:0.25rem; gap:0.4rem;">
              <div style="font-size:0.78rem; color:var(--ink-muted);">
                ${escapeHtml(t(state.lang, 'fromPricePrefix'))}
                <strong class="num" style="color:var(--brand-teal); font-size:0.95rem;">${formatCurrency(c.minHotelUsd, state.currency, rates)}</strong>
                <span>${escapeHtml(t(state.lang, 'perNightShort'))}</span>
              </div>
              <span style="font-size:0.75rem; font-weight:800; color:${isPicked ? 'var(--brand-gold)' : 'var(--brand-teal)'};">
                ${escapeHtml(isPicked ? t(state.lang, 'destChosenBadge') : t(state.lang, 'pickThisDest'))}
              </span>
            </div>
          </div>
        </button>
      `;
    })
    .join('');

  return `
    <div class="stage-header-block">
      <div>
        <h2 class="stage-title" id="journey-stage-heading" tabindex="-1">${escapeHtml(t(state.lang, 'journey1Title'))}</h2>
        <p class="stage-lead">${escapeHtml(t(state.lang, 'journey1Sub'))}</p>
      </div>
      <div style="display:flex; align-items:center; gap:0.45rem;">
        <label for="j-nat-select" style="font-size:0.8rem; font-weight:700; color:var(--ink-secondary);">${escapeHtml(t(state.lang, 'lblNationality'))}</label>
        <select id="j-nat-select" class="input-control" style="block-size:2.35rem; inline-size:auto; font-size:0.82rem; font-weight:700;">
          <option value="EG" ${state.filters.nationality === 'EG' ? 'selected' : ''}>🇪🇬 مصر (EG)</option>
          <option value="SA" ${state.filters.nationality === 'SA' ? 'selected' : ''}>🇸🇦 السعودية (SA)</option>
          <option value="AE" ${state.filters.nationality === 'AE' ? 'selected' : ''}>🇦🇪 الإمارات (AE)</option>
          <option value="JO" ${state.filters.nationality === 'JO' ? 'selected' : ''}>🇯🇴 الأردن (JO)</option>
        </select>
      </div>
    </div>

    <div class="vibe-pills-bar" role="group" aria-label="Travel Vibe Filter">
      ${vibes
        .map(
          (v) =>
            `<button type="button" class="vibe-btn" data-j-vibe="${v.id}" aria-pressed="${activeVibe === v.id}">${escapeHtml(v.label)}</button>`,
        )
        .join('')}
    </div>

    <div class="dest-canvas-grid">${cardsHtml}</div>

    <div class="journey-nav-footer">
      <span style="font-size:0.82rem; color:var(--ink-muted);">
        ${isAr ? '✓ جميع الأسعار مرتبطة لحظياً — لا يتطلب أي تسجيل دخول' : '✓ Live supplier pricing synced — zero login required'}
      </span>
      <button type="button" class="btn btn-primary" data-j-goto-step="2">
        ${escapeHtml(t(state.lang, 'stepNext'))}
      </button>
    </div>
  `;
}

function buildMonthCalendarHtml(state, baseDate, monthOffset, baseHotelUsd) {
  const isAr = state.lang === 'ar';
  const rates = state.snapshot.rates;
  const target = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth() + monthOffset, 1));
  const year = target.getUTCFullYear();
  const monthIdx = target.getUTCMonth();
  const monthLabel = new Intl.DateTimeFormat(isAr ? 'ar-EG' : 'en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    target,
  );

  const firstWeekday = target.getUTCDay(); // 0 = Sun
  const daysInMonth = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  const todayIso = new Date().toISOString().slice(0, 10);
  const inIso = state.filters.checkInDate;
  const outIso = state.filters.checkOutDate;

  const weekdayLabels = isAr
    ? ['ح', 'ن', 'ث', 'ر', 'خ', 'ج', 'س']
    : ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  let cells = '';
  for (let blank = 0; blank < firstWeekday; blank += 1) {
    cells += '<div></div>';
  }

  for (let d = 1; d <= daysInMonth; d += 1) {
    const iso = `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
    const isPast = iso < todayIso;

    // Deterministic seasonal curve per day
    let mult = 1.0;
    let tierCls = '';
    if (dow === 4 || dow === 5 || (d >= 18 && d <= 24)) {
      mult = 1.15;
      tierCls = 'tier-peak';
    } else if (dow === 1 || dow === 2 || d % 7 === 3) {
      mult = 0.86;
      tierCls = 'tier-deal';
    }
    const dayPriceUsd = Math.round(baseHotelUsd * mult);

    const isEdge = iso === inIso || iso === outIso;
    const isInRange = iso > inIso && iso < outIso;
    const shortPrice = formatCurrency(dayPriceUsd, state.currency, rates).replace(/[^\d.,٠-٩]+/g, '').trim();

    cells += `
      <button
        type="button"
        class="cal-day-cell ${tierCls} ${isEdge ? 'is-edge' : ''} ${isInRange ? 'is-in-range' : ''}"
        data-j-cal-date="${iso}"
        ${isPast ? 'disabled' : ''}
        aria-label="${iso} — ${formatCurrency(dayPriceUsd, state.currency, rates)}"
      >
        <span class="cal-day-num">${d}</span>
        <span class="cal-day-fare">${shortPrice}</span>
      </button>
    `;
  }

  return `
    <div class="cal-month-box">
      <div class="cal-month-title">${escapeHtml(monthLabel)}</div>
      <div class="cal-weekdays">${weekdayLabels.map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="cal-days-grid">${cells}</div>
    </div>
  `;
}

function renderStage2Html(state, summary) {
  const isAr = state.lang === 'ar';
  const baseUsd = summary.cityInfo.minHotelUsd || 160;
  const nowDate = new Date();
  const cal1 = buildMonthCalendarHtml(state, nowDate, 0, baseUsd);
  const cal2 = buildMonthCalendarHtml(state, nowDate, 1, baseUsd);

  const presets = [
    { nights: 2, label: t(state.lang, 'presetExpress') },
    { nights: 3, label: t(state.lang, 'presetWeekend') },
    { nights: 5, label: t(state.lang, 'presetEscape') },
    { nights: 7, label: t(state.lang, 'presetProgram') },
  ];

  const companions = [
    { id: 'couple', icon: '🥂', title: t(state.lang, 'companionCouple'), sub: t(state.lang, 'companionCoupleSub') },
    { id: 'family', icon: '👨‍👩‍👧', title: t(state.lang, 'companionFamily'), sub: t(state.lang, 'companionFamilySub') },
    { id: 'business', icon: '💼', title: t(state.lang, 'companionBusiness'), sub: t(state.lang, 'companionBusinessSub') },
    { id: 'solo', icon: '🧭', title: t(state.lang, 'companionSolo'), sub: t(state.lang, 'companionSoloSub') },
  ];

  const instructionMsg = state.journey.calSelectingOut
    ? t(state.lang, 'calInstructionOut')
    : t(state.lang, 'calInstructionDone');

  return `
    <div class="stage-header-block">
      <div>
        <h2 class="stage-title" id="journey-stage-heading" tabindex="-1">${escapeHtml(t(state.lang, 'journey2Title'))}</h2>
        <p class="stage-lead">${escapeHtml(t(state.lang, 'journey2Sub'))}</p>
      </div>
      <span class="amenity-chip is-green">${escapeHtml(instructionMsg)}</span>
    </div>

    <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:0.65rem;">
      <div class="rhythm-presets-row" role="group" aria-label="Stay Presets">
        ${presets
          .map(
            (p) =>
              `<button type="button" class="rhythm-chip" data-j-preset-nights="${p.nights}" aria-pressed="${state.filters.nights === p.nights}">${escapeHtml(p.label)}</button>`,
          )
          .join('')}
      </div>
      <div style="display:flex; gap:0.75rem; font-size:0.75rem; font-weight:700;">
        <span style="color:var(--status-success);">● ${escapeHtml(t(state.lang, 'calTierDeal'))}</span>
        <span style="color:var(--status-warning);">● ${escapeHtml(t(state.lang, 'calTierPeak'))}</span>
      </div>
    </div>

    <div class="visual-calendars-wrap">${cal1}${cal2}</div>

    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:0.85rem; align-items:end; background:var(--surface-soft); padding:0.9rem; border-radius:var(--radius-md);">
      <div>
        <label for="j-origin-select" style="display:block; font-size:0.8rem; font-weight:700; margin-block-end:0.35rem;">${escapeHtml(t(state.lang, 'departFromLabel'))}</label>
        <select id="j-origin-select" class="input-control" style="block-size:2.45rem;">
          <option value="all" ${state.filters.origin === 'all' ? 'selected' : ''}>${escapeHtml(t(state.lang, 'allOrigins'))}</option>
          <option value="CAI" ${state.filters.origin === 'CAI' ? 'selected' : ''}>🇪🇬 القاهرة (CAI)</option>
          <option value="RUH" ${state.filters.origin === 'RUH' ? 'selected' : ''}>🇸🇦 الرياض (RUH)</option>
          <option value="JED" ${state.filters.origin === 'JED' ? 'selected' : ''}>🇸🇦 جدة (JED)</option>
          <option value="DXB" ${state.filters.origin === 'DXB' ? 'selected' : ''}>🇦🇪 دبي (DXB)</option>
        </select>
      </div>

      <div style="display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:0.45rem;">
        ${['adults', 'children', 'rooms']
          .map((k) => {
            const lbl = k === 'adults' ? t(state.lang, 'adultsShort') : k === 'children' ? t(state.lang, 'childrenShort') : t(state.lang, 'roomsShort');
            return `
              <div style="background:#FFFFFF; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:0.35rem 0.45rem; text-align:center;">
                <div style="font-size:0.68rem; color:var(--ink-muted); font-weight:700;">${escapeHtml(lbl)}</div>
                <div style="display:flex; align-items:center; justify-content:space-between; margin-block-start:0.2rem;">
                  <button type="button" class="step-btn" data-j-step="${k}" data-delta="-1" style="inline-size:1.55rem; block-size:1.55rem;">−</button>
                  <strong class="num" style="font-size:0.86rem;">${state.filters[k]}</strong>
                  <button type="button" class="step-btn" data-j-step="${k}" data-delta="1" style="inline-size:1.55rem; block-size:1.55rem;">+</button>
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    </div>

    <div style="display:grid; gap:0.6rem;">
      <h3 style="font-size:0.95rem; font-weight:800;">${escapeHtml(t(state.lang, 'companionTitle'))}</h3>
      <div class="companions-grid" role="group" aria-label="Travel Style">
        ${companions
          .map(
            (c) => `
          <button type="button" class="companion-card" data-j-companion="${c.id}" aria-pressed="${state.journey.companion === c.id}">
            <div style="font-size:1.1rem;">${c.icon} <strong style="font-size:0.86rem;">${escapeHtml(c.title)}</strong></div>
            <span style="font-size:0.74rem; color:var(--ink-muted);">${escapeHtml(c.sub)}</span>
          </button>
        `,
          )
          .join('')}
      </div>
    </div>

    <div class="journey-nav-footer">
      <button type="button" class="btn btn-outline" data-j-goto-step="1">${escapeHtml(t(state.lang, 'stepBack'))}</button>
      <button type="button" class="btn btn-primary" data-j-goto-step="3">${escapeHtml(t(state.lang, 'stepNext'))}</button>
    </div>
  `;
}

function renderStage3Html(state, summary) {
  const isAr = state.lang === 'ar';
  const rates = state.snapshot.rates;
  const { cityInfo } = summary;
  const includeFlight = Boolean(state.journey.includeFlight);

  const matchingFlights = cityInfo.flights.filter(
    (f) => state.filters.origin === 'all' || f.originCode === state.filters.origin,
  );
  const flightPool = matchingFlights.length > 0 ? matchingFlights : cityInfo.flights;

  const seatVibes = [
    { id: 'window', title: t(state.lang, 'seatWindow'), sub: t(state.lang, 'seatWindowSub') },
    { id: 'aisle', title: t(state.lang, 'seatAisle'), sub: t(state.lang, 'seatAisleSub') },
    { id: 'family', title: t(state.lang, 'seatFamily'), sub: t(state.lang, 'seatFamilySub') },
  ];

  const flightsHtml = includeFlight
    ? `
      <div style="display:grid; gap:0.65rem;">
        <h3 style="font-size:0.95rem; font-weight:800;">✈ ${escapeHtml(t(state.lang, 'flightPickLabel'))}</h3>
        ${
          flightPool.length === 0
            ? `<div class="panel-card" style="font-size:0.84rem; color:var(--ink-muted);">${escapeHtml(t(state.lang, 'noFlightsCity'))}</div>`
            : flightPool
                .map((f) => {
                  const isChosen = summary.flight?.id === f.id;
                  const activeTierId =
                    (isChosen && state.bundle.flightTierId) || state.selectedTiers[f.id] || f.selectedTierId;
                  return `
                    <div class="journey-option-card ${isChosen ? 'is-chosen' : ''}">
                      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
                        <div>
                          <div style="display:flex; align-items:center; gap:0.45rem; flex-wrap:wrap;">
                            <strong>${escapeHtml(isAr ? f.airlineAr : f.airlineEn)}</strong>
                            <span class="mono" style="font-size:0.78rem; color:var(--ink-muted);">${escapeHtml(f.flightNumber)} • ${escapeHtml(f.originCode)}→${escapeHtml(f.destCode)}</span>
                            <span class="provider-badge">${escapeHtml(f.provider)}</span>
                          </div>
                          <div style="font-size:0.77rem; color:var(--ink-muted); margin-block-start:0.2rem;">
                            <span class="mono">${escapeHtml(f.depTime)}</span> → <span class="mono">${escapeHtml(f.arrTime)}</span> • ${f.stopsCount === 0 ? t(state.lang, 'directFlight') : t(state.lang, 'oneStopFlight')}
                          </div>
                        </div>
                        <button type="button" class="btn btn-sm ${isChosen ? 'btn-gold' : 'btn-outline'}" data-j-pick-flight="${escapeHtml(f.id)}" ${f.status === 'sold_out' ? 'disabled' : ''}>
                          ${isChosen ? (isAr ? '✓ مختارة' : '✓ Selected') : isAr ? 'اختيار الرحلة' : 'Pick Flight'}
                        </button>
                      </div>
                      <div class="tier-selector-mini">
                        ${(f.tiers || [])
                          .map((tr) => {
                            const active = isChosen && tr.id === activeTierId;
                            return `
                              <button type="button" class="tier-mini-btn ${active ? 'is-selected' : ''}" data-j-pick-ftier="${escapeHtml(f.id)}:${escapeHtml(tr.id)}" ${tr.effectiveAvailable <= 0 ? 'disabled' : ''}>
                                <span>${escapeHtml(isAr ? tr.nameAr : tr.nameEn)}</span>
                                <strong class="num" style="display:block; margin-block-start:0.12rem;">${formatCurrency(tr.pricing.finalPriceUsd, state.currency, rates)}</strong>
                              </button>
                            `;
                          })
                          .join('')}
                      </div>
                    </div>
                  `;
                })
                .join('')
        }
      </div>

      <div style="display:grid; gap:0.55rem;">
        <h3 style="font-size:0.95rem; font-weight:800;">💺 ${escapeHtml(t(state.lang, 'seatVibeTitle'))}</h3>
        <div class="seat-vibe-strip" role="group" aria-label="Seat Preference">
          ${seatVibes
            .map(
              (s) => `
            <button type="button" class="seat-pref-btn" data-j-seat="${s.id}" aria-pressed="${state.journey.seatPref === s.id}">
              <div style="display:grid; gap:0.12rem;">
                <span>${escapeHtml(s.title)}</span>
                <small style="font-weight:500; opacity:0.82; font-size:0.72rem;">${escapeHtml(s.sub)}</small>
              </div>
            </button>
          `,
            )
            .join('')}
        </div>
      </div>
    `
    : '';

  const hotelsHtml = cityInfo.hotels
    .map((h) => {
      const isChosen = summary.hotel?.id === h.id;
      const activeTierId = (isChosen && state.bundle.hotelTierId) || state.selectedTiers[h.id] || h.selectedTierId;
      return `
        <div class="journey-option-card ${isChosen ? 'is-chosen' : ''}">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.6rem;">
            <div style="display:flex; gap:0.75rem; align-items:center;">
              <img src="${escapeHtml(h.image)}" alt="${escapeHtml(isAr ? h.nameAr : h.nameEn)}" style="inline-size:66px; block-size:52px; object-fit:cover; border-radius:var(--radius-sm); flex-shrink:0;">
              <div>
                <div style="display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap;">
                  <strong>${escapeHtml(isAr ? h.nameAr : h.nameEn)}</strong>
                  <span style="color:var(--brand-gold); font-size:0.78rem;">${'★'.repeat(h.stars || 5)}</span>
                </div>
                <div style="font-size:0.77rem; color:var(--ink-muted);">
                  ${escapeHtml(isAr ? h.districtAr : h.districtEn)} • ${escapeHtml(h.provider)}
                </div>
              </div>
            </div>

            <div style="display:flex; gap:0.45rem; align-items:center;">
              <button type="button" class="btn btn-outline btn-sm" data-j-inspect-hotel="${escapeHtml(h.id)}">${escapeHtml(t(state.lang, 'inspectDetails'))}</button>
              <button type="button" class="btn btn-sm ${isChosen ? 'btn-gold' : 'btn-primary'}" data-j-pick-hotel="${escapeHtml(h.id)}" ${h.status === 'sold_out' ? 'disabled' : ''}>
                ${isChosen ? (isAr ? '✓ مختار' : '✓ Selected') : isAr ? 'اختيار الفندق' : 'Select Hotel'}
              </button>
            </div>
          </div>

          <div class="tier-selector-mini">
            ${(h.tiers || [])
              .map((tr) => {
                const active = isChosen && tr.id === activeTierId;
                return `
                  <button type="button" class="tier-mini-btn ${active ? 'is-selected' : ''}" data-j-pick-htier="${escapeHtml(h.id)}:${escapeHtml(tr.id)}" ${tr.effectiveAvailable <= 0 ? 'disabled' : ''}>
                    <span>${escapeHtml(isAr ? tr.nameAr : tr.nameEn)}</span>
                    <strong class="num" style="display:block; margin-block-start:0.12rem;">${formatCurrency(tr.pricing.finalPriceUsd, state.currency, rates)}</strong>
                  </button>
                `;
              })
              .join('')}
          </div>
        </div>
      `;
    })
    .join('');

  return `
    <div class="stage-header-block">
      <div>
        <h2 class="stage-title" id="journey-stage-heading" tabindex="-1">${escapeHtml(t(state.lang, 'journey3Title'))}</h2>
        <p class="stage-lead">${escapeHtml(t(state.lang, 'journey3Sub'))}</p>
      </div>
    </div>

    <div class="companions-grid" style="grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));">
      <button type="button" class="companion-card" data-j-include-flight="true" aria-pressed="${includeFlight}">
        <strong>✨ ${escapeHtml(t(state.lang, 'tripTypeBundle'))}</strong>
        <span style="font-size:0.75rem; color:var(--ink-muted);">${escapeHtml(t(state.lang, 'tripTypeBundleSub'))}</span>
      </button>
      <button type="button" class="companion-card" data-j-include-flight="false" aria-pressed="${!includeFlight}">
        <strong>🏨 ${escapeHtml(t(state.lang, 'tripTypeHotelOnly'))}</strong>
        <span style="font-size:0.75rem; color:var(--ink-muted);">${escapeHtml(t(state.lang, 'tripTypeHotelOnlySub'))}</span>
      </button>
    </div>

    ${flightsHtml}

    <div style="display:grid; gap:0.65rem;">
      <h3 style="font-size:0.95rem; font-weight:800;">🏨 ${escapeHtml(t(state.lang, 'hotelPickLabel'))}</h3>
      ${hotelsHtml}
    </div>

    <div class="journey-nav-footer">
      <button type="button" class="btn btn-outline" data-j-goto-step="2">${escapeHtml(t(state.lang, 'stepBack'))}</button>
      <button type="button" class="btn btn-gold" data-j-goto-step="4">${escapeHtml(t(state.lang, 'continueToCheckIn'))}</button>
    </div>
  `;
}

function renderStage4Html(state, summary) {
  const isAr = state.lang === 'ar';
  const rates = state.snapshot.rates;
  const completed = state.journey.completedBooking;

  if (completed) {
    return `
      <div class="stage-header-block">
        <div>
          <span class="boarding-confirmed-stamp" style="margin-block-end:0.65rem;">${escapeHtml(t(state.lang, 'passConfirmedStamp'))}</span>
          <h2 class="stage-title" id="journey-stage-heading" tabindex="-1">${escapeHtml(isAr ? completed.titleAr : completed.titleEn)}</h2>
          <p class="stage-lead">${escapeHtml(t(state.lang, 'passConfirmedLead'))}</p>
        </div>
      </div>

      <div class="summary-box">
        <div class="summary-row">
          <span>${escapeHtml(t(state.lang, 'boardingRefLabel'))}</span>
          <strong class="mono" style="font-size:1.05rem; color:var(--brand-teal);">${escapeHtml(completed.reference)}</strong>
        </div>
        <div class="summary-row">
          <span>${escapeHtml(t(state.lang, 'boardingPassenger'))}</span>
          <strong>${escapeHtml(completed.guestName)}</strong>
        </div>
        <div class="summary-row">
          <span>${escapeHtml(t(state.lang, 'boardingDates'))}</span>
          <span class="mono" dir="ltr">${escapeHtml(completed.checkInDate)} → ${escapeHtml(completed.checkOutDate || '')}</span>
        </div>
        ${
          completed.tripMeta?.hospitality?.length
            ? `
          <div class="summary-row">
            <span>${escapeHtml(t(state.lang, 'hospitalityTitle'))}</span>
            <span>${completed.tripMeta.hospitality.map((h) => escapeHtml(getHospitalityLabel(state.lang, h))).join(' • ')}</span>
          </div>
        `
            : ''
        }
        <div class="summary-row summary-total">
          <span>${escapeHtml(t(state.lang, 'boardingTotal'))}</span>
          <strong class="num" style="color:var(--brand-teal);">${formatCurrency(completed.pricingSummary.totalUsd, state.currency, rates)}</strong>
        </div>
      </div>

      <div style="display:flex; gap:0.65rem; flex-wrap:wrap;">
        <button type="button" class="btn btn-primary" id="j-btn-view-bookings">${escapeHtml(t(state.lang, 'viewMyBookings'))}</button>
        <button type="button" class="btn btn-secondary" id="j-btn-copy-ref" data-ref="${escapeHtml(completed.reference)}">${escapeHtml(t(state.lang, 'copyRefBtn'))}</button>
        <button type="button" class="btn btn-outline" id="j-btn-new-journey">${escapeHtml(t(state.lang, 'bookAnotherJourney'))}</button>
      </div>
    `;
  }

  const visaRule = summary.visaRule;
  const visaMultiplier = summary.includeFlight ? summary.pax : summary.rooms;
  const visaFee = Number(visaRule.assistFeeUsd || 0) * visaMultiplier;
  const touches = ['high_floor', 'early_checkin', 'vip_welcome', 'airport_transfer'];
  const pickedTouches = state.journey.hospitality || [];

  return `
    <div class="stage-header-block">
      <div>
        <h2 class="stage-title" id="journey-stage-heading" tabindex="-1">${escapeHtml(t(state.lang, 'journey4Title'))}</h2>
        <p class="stage-lead">${escapeHtml(t(state.lang, 'journey4Sub'))}</p>
      </div>
      <span class="passport-progress-pill" id="j-readiness-pill">
        ${escapeHtml(t(state.lang, 'readyMeterPrefix'))} <strong class="num" id="j-readiness-count">0 / 3</strong>
      </span>
    </div>

    <form id="journey-passport-form" novalidate style="display:grid; gap:1rem;">
      <div id="journey-live-announcer" class="visually-hidden" aria-live="polite"></div>

      <div class="passport-field-wrap">
        <label class="field-label" for="jp-guest-name">${escapeHtml(t(state.lang, 'guestNameLabel'))}</label>
        <div class="passport-hint" id="jp-name-hint">${escapeHtml(t(state.lang, 'guestNameHint'))}</div>
        <input
          class="passport-input"
          id="jp-guest-name"
          name="guestName"
          type="text"
          required
          minlength="4"
          autocomplete="name"
          aria-describedby="jp-name-hint"
          data-error-id="jp-name-err"
          placeholder="${escapeHtml(t(state.lang, 'guestNamePlaceholder'))}"
          value="${escapeHtml(state.journey.draftName || '')}"
        >
        <span class="passport-error-msg" id="jp-name-err">⚠ ${escapeHtml(t(state.lang, 'guestNameErr'))}</span>
        <span class="passport-valid-msg">✓ ${isAr ? 'مطبوع على البطاقة!' : 'Imprinted cleanly!'}</span>
      </div>

      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:0.85rem;">
        <div class="passport-field-wrap">
          <label class="field-label" for="jp-guest-phone">${escapeHtml(t(state.lang, 'guestPhoneLabel'))}</label>
          <div class="passport-hint" id="jp-phone-hint">${escapeHtml(t(state.lang, 'guestPhoneHint'))}</div>
          <input
            class="passport-input mono"
            id="jp-guest-phone"
            name="guestPhone"
            type="tel"
            required
            pattern="\\+?\\d[\\d\\s\\-]{6,}"
            autocomplete="tel"
            aria-describedby="jp-phone-hint"
            data-error-id="jp-phone-err"
            placeholder="${escapeHtml(t(state.lang, 'guestPhonePlaceholder'))}"
            value="${escapeHtml(state.journey.draftPhone || '')}"
          >
          <span class="passport-error-msg" id="jp-phone-err">⚠ ${escapeHtml(t(state.lang, 'guestPhoneErr'))}</span>
          <span class="passport-valid-msg">✓ ${isAr ? 'رقم موثق للإشعارات' : 'Verified for alerts'}</span>
        </div>

        <div class="passport-field-wrap">
          <label class="field-label" for="jp-guest-email">${escapeHtml(t(state.lang, 'guestEmailLabel'))}</label>
          <div class="passport-hint" id="jp-email-hint">${escapeHtml(t(state.lang, 'guestEmailHint'))}</div>
          <input
            class="passport-input"
            id="jp-guest-email"
            name="guestEmail"
            type="email"
            required
            autocomplete="email"
            aria-describedby="jp-email-hint"
            data-error-id="jp-email-err"
            placeholder="${escapeHtml(t(state.lang, 'guestEmailPlaceholder'))}"
            value="${escapeHtml(state.journey.draftEmail || '')}"
          >
          <span class="passport-error-msg" id="jp-email-err">⚠ ${escapeHtml(t(state.lang, 'guestEmailErr'))}</span>
          <span class="passport-valid-msg">✓ ${isAr ? 'جاهز لاستلام الإيصال' : 'Ready for e-voucher'}</span>
        </div>
      </div>

      <div style="display:grid; gap:0.45rem;">
        <span class="field-label">${escapeHtml(t(state.lang, 'hospitalityTitle'))}</span>
        <div class="concierge-touch-grid">
          ${touches
            .map(
              (tk) =>
                `<button type="button" class="touch-pill-btn" data-j-touch="${tk}" aria-pressed="${pickedTouches.includes(tk)}">${escapeHtml(getHospitalityLabel(state.lang, tk))}</button>`,
            )
            .join('')}
        </div>
      </div>

      <div class="summary-box" style="background:var(--brand-gold-tint); border-color:var(--border-gold);">
        <label style="display:flex; align-items:flex-start; gap:0.55rem; cursor:pointer;">
          <input type="checkbox" id="jp-visa-assist" ${state.journey.includeVisaAssist ? 'checked' : ''} style="margin-block-start:0.2rem;">
          <div>
            <strong style="font-size:0.86rem;">
              🛂 ${escapeHtml(t(state.lang, 'visaAssistTitle'))}
              (${visaFee > 0 ? `+${formatCurrency(visaFee, state.currency, rates)}` : isAr ? 'مجاني' : 'Free'})
            </strong>
            <div style="font-size:0.76rem; color:var(--ink-secondary);">${escapeHtml(isAr ? visaRule.noteAr : visaRule.noteEn)}</div>
          </div>
        </label>
      </div>

      <div>
        <label class="field-label" for="jp-payment-method">${escapeHtml(t(state.lang, 'paymentLabel'))}</label>
        <select class="input-control" id="jp-payment-method" style="margin-block-start:0.28rem;">
          <option value="card" ${state.journey.paymentMethod === 'card' ? 'selected' : ''}>${escapeHtml(t(state.lang, 'payCard'))}</option>
          <option value="wallet" ${state.journey.paymentMethod === 'wallet' ? 'selected' : ''}>${escapeHtml(t(state.lang, 'payWallet'))}</option>
          <option value="cash" ${state.journey.paymentMethod === 'cash' ? 'selected' : ''}>${escapeHtml(t(state.lang, 'payCash'))}</option>
        </select>
      </div>

      <div class="journey-nav-footer">
        <button type="button" class="btn btn-outline" data-j-goto-step="3">${escapeHtml(t(state.lang, 'stepBack'))}</button>
        <button type="submit" class="btn btn-gold" id="j-issue-pass-btn">
          ${escapeHtml(t(state.lang, 'issuePassBtn'))}
        </button>
      </div>
    </form>
  `;
}

function setupPassportValidation(form, state, root, onSubmitConfirmed) {
  const inputs = Array.from(form.querySelectorAll('.passport-input'));
  const announcer = form.querySelector('#journey-live-announcer');
  const countEl = root.querySelector('#j-readiness-count');
  let announceTimer = null;

  const updateReadiness = () => {
    const validCount = inputs.filter((inp) => inp.checkValidity()).length;
    if (countEl) countEl.textContent = `${validCount} / ${inputs.length}`;
  };

  const syncInputState = (input, forceReveal = false) => {
    if (forceReveal) touchedFields.set(input, true);
    const touched = touchedFields.get(input) === true;
    const isValid = input.checkValidity();

    if (!SUPPORTS_USER_INVALID && touched) {
      input.classList.toggle('user-invalid-fallback', !isValid);
      input.classList.toggle('user-valid-fallback', isValid);
    }

    const baseDesc = (input.getAttribute('aria-describedby') || '')
      .split(/\s+/)
      .filter((id) => id && !id.endsWith('-err'));
    const errId = input.dataset.errorId;

    if (touched && !isValid) {
      input.setAttribute('aria-invalid', 'true');
      if (errId && !baseDesc.includes(errId)) baseDesc.push(errId);
    } else {
      input.removeAttribute('aria-invalid');
    }
    input.setAttribute('aria-describedby', baseDesc.join(' '));
  };

  const queueAnnounce = (msg) => {
    if (!announcer) return;
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      announcer.textContent = msg || '';
    }, 500);
  };

  for (const input of inputs) {
    input.addEventListener('blur', () => {
      touchedFields.set(input, true);
      syncInputState(input);
      if (!input.checkValidity()) {
        const errText = document.getElementById(input.dataset.errorId)?.textContent || '';
        queueAnnounce(errText);
      }
      updateReadiness();
    });

    input.addEventListener('input', () => {
      if (input.id === 'jp-guest-name') {
        state.journey.draftName = input.value;
        const bpNameEl = root.querySelector('#bp-passenger-name');
        if (bpNameEl) {
          const val = input.value.trim();
          bpNameEl.textContent = val || t(state.lang, 'boardingGuestPlaceholder');
          bpNameEl.style.color = val ? 'var(--brand-gold-bright)' : 'rgba(255,255,255,0.52)';
        }
      } else if (input.id === 'jp-guest-phone') {
        state.journey.draftPhone = input.value;
      } else if (input.id === 'jp-guest-email') {
        state.journey.draftEmail = input.value;
      }

      if (touchedFields.get(input)) {
        syncInputState(input);
      }
      updateReadiness();
    });
  }

  updateReadiness();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    let firstInvalid = null;
    for (const inp of inputs) {
      syncInputState(inp, true);
      if (!SUPPORTS_USER_INVALID) {
        inp.classList.toggle('user-invalid-fallback', !inp.checkValidity());
        inp.classList.toggle('user-valid-fallback', inp.checkValidity());
      }
      if (!inp.checkValidity() && !firstInvalid) firstInvalid = inp;
    }

    if (firstInvalid) {
      const errText = document.getElementById(firstInvalid.dataset.errorId)?.textContent || '';
      queueAnnounce(errText);
      firstInvalid.focus();
      return;
    }

    await onSubmitConfirmed();
  });
}

export function renderJourneyStudio(root, state, callbacks) {
  const { onSnapshot, onToast, onGoBookings, onInspectHotel } = callbacks;
  const isAr = state.lang === 'ar';

  const summary = computeJourneySummary(state);
  if (!summary) return;
  ensureCitySelections(state, summary.cityInfo.cityKey);

  const curStep = Math.min(4, Math.max(1, Number(state.journey.step) || 1));
  const steps = [
    { num: 1, title: t(state.lang, 'journeyStep1') },
    { num: 2, title: t(state.lang, 'journeyStep2') },
    { num: 3, title: t(state.lang, 'journeyStep3') },
    { num: 4, title: t(state.lang, 'journeyStep4') },
  ];

  let stageHtml = '';
  if (curStep === 1) stageHtml = renderStage1Html(state, summary);
  else if (curStep === 2) stageHtml = renderStage2Html(state, summary);
  else if (curStep === 3) stageHtml = renderStage3Html(state, summary);
  else stageHtml = renderStage4Html(state, summary);

  root.innerHTML = `
    <div class="journey-studio-shell">
      <nav class="journey-progress-rail" aria-label="Journey Stages">
        ${steps
          .map((s) => {
            const cls = s.num === curStep ? 'is-active' : s.num < curStep || state.journey.completedBooking ? 'is-done' : '';
            return `
              <button type="button" class="journey-step-node ${cls}" data-j-rail-step="${s.num}" aria-current="${s.num === curStep ? 'step' : 'false'}">
                <span class="journey-step-num">${s.num < curStep && !state.journey.completedBooking ? '✓' : s.num}</span>
                <span class="journey-step-text">
                  <small>${isAr ? `محطة ${s.num} من ٤` : `Stage ${s.num} / 4`}</small>
                  <strong>${escapeHtml(s.title)}</strong>
                </span>
              </button>
            `;
          })
          .join('')}
      </nav>

      <div class="journey-split">
        <section class="journey-stage-card" aria-labelledby="journey-stage-heading">
          ${stageHtml}
        </section>

        <div data-bp-container="true">
          ${renderLiveBoardingPassHtml(state)}
        </div>
      </div>
    </div>
  `;

  const goToStep = (nextStep) => {
    const clamped = Math.min(4, Math.max(1, Number(nextStep)));
    if (clamped === curStep) return;
    const dir = clamped > curStep ? 'forward' : 'backward';
    runDirectionalTransition(
      dir,
      () => {
        state.journey.step = clamped;
        renderJourneyStudio(root, state, callbacks);
      },
      '#journey-stage-heading',
    );
  };

  root.querySelectorAll('[data-j-rail-step], [data-j-goto-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.jRailStep || btn.dataset.jGotoStep;
      goToStep(target);
    });
  });

  // Stage 1 listeners
  root.querySelector('#j-nat-select')?.addEventListener('change', (ev) => {
    state.filters.nationality = ev.currentTarget.value;
    const navNat = document.getElementById('search-nationality');
    if (navNat) navNat.value = state.filters.nationality;
    renderJourneyStudio(root, state, callbacks);
  });

  root.querySelectorAll('[data-j-vibe]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.journey.vibe = btn.dataset.jVibe;
      renderJourneyStudio(root, state, callbacks);
    });
  });

  root.querySelectorAll('[data-j-pick-city]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cityKey = btn.dataset.jPickCity;
      state.filters.destination = cityKey;
      state.bundle.hotelId = null;
      state.bundle.hotelTierId = null;
      state.bundle.flightId = null;
      state.bundle.flightTierId = null;
      ensureCitySelections(state, cityKey);
      goToStep(2);
    });
  });

  // Stage 2 listeners
  root.querySelectorAll('[data-j-preset-nights]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nights = Number(btn.dataset.jPresetNights);
      state.filters.nights = nights;
      state.filters.checkOutDate = addDaysIso(state.filters.checkInDate, nights);
      state.journey.calSelectingOut = false;
      renderJourneyStudio(root, state, callbacks);
    });
  });

  root.querySelectorAll('[data-j-cal-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const iso = btn.dataset.jCalDate;
      if (!state.journey.calSelectingOut || iso <= state.filters.checkInDate) {
        state.filters.checkInDate = iso;
        const stayLen = Math.max(1, state.filters.nights || 2);
        state.filters.checkOutDate = addDaysIso(iso, stayLen);
        state.journey.calSelectingOut = true;
      } else {
        state.filters.checkOutDate = iso;
        state.filters.nights = diffDays(state.filters.checkInDate, iso);
        state.journey.calSelectingOut = false;
      }
      renderJourneyStudio(root, state, callbacks);
    });
  });

  root.querySelector('#j-origin-select')?.addEventListener('change', (ev) => {
    state.filters.origin = ev.currentTarget.value;
    state.bundle.flightId = null;
    state.bundle.flightTierId = null;
    ensureCitySelections(state, getSelectedCityKey(state));
    renderJourneyStudio(root, state, callbacks);
  });

  root.querySelectorAll('[data-j-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.jStep;
      const delta = Number(btn.dataset.delta);
      const min = key === 'children' ? 0 : 1;
      const max = key === 'rooms' ? 4 : 6;
      state.filters[key] = Math.min(max, Math.max(min, (state.filters[key] || 0) + delta));
      renderJourneyStudio(root, state, callbacks);
    });
  });

  root.querySelectorAll('[data-j-companion]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.journey.companion = btn.dataset.jCompanion;
      renderJourneyStudio(root, state, callbacks);
    });
  });

  // Stage 3 listeners
  root.querySelectorAll('[data-j-include-flight]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.journey.includeFlight = btn.dataset.jIncludeFlight === 'true';
      renderJourneyStudio(root, state, callbacks);
    });
  });

  root.querySelectorAll('[data-j-seat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.journey.seatPref = btn.dataset.jSeat;
      renderJourneyStudio(root, state, callbacks);
    });
  });

  root.querySelectorAll('[data-j-pick-flight]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const fid = btn.dataset.jPickFlight;
      const f = state.snapshot.flights.find((x) => x.id === fid);
      if (f) {
        state.bundle.flightId = f.id;
        state.bundle.flightTierId = state.selectedTiers[f.id] || f.selectedTierId;
        renderJourneyStudio(root, state, callbacks);
      }
    });
  });

  root.querySelectorAll('[data-j-pick-ftier]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [fid, tid] = btn.dataset.jPickFtier.split(':');
      state.bundle.flightId = fid;
      state.bundle.flightTierId = tid;
      state.selectedTiers[fid] = tid;
      renderJourneyStudio(root, state, callbacks);
    });
  });

  root.querySelectorAll('[data-j-pick-hotel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const hid = btn.dataset.jPickHotel;
      const h = state.snapshot.hotels.find((x) => x.id === hid);
      if (h) {
        state.bundle.hotelId = h.id;
        state.bundle.hotelTierId = state.selectedTiers[h.id] || h.selectedTierId;
        renderJourneyStudio(root, state, callbacks);
      }
    });
  });

  root.querySelectorAll('[data-j-pick-htier]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [hid, tid] = btn.dataset.jPickHtier.split(':');
      state.bundle.hotelId = hid;
      state.bundle.hotelTierId = tid;
      state.selectedTiers[hid] = tid;
      renderJourneyStudio(root, state, callbacks);
    });
  });

  root.querySelectorAll('[data-j-inspect-hotel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      onInspectHotel?.('hotel', btn.dataset.jInspectHotel);
    });
  });

  // Stage 4 listeners
  root.querySelectorAll('[data-j-touch]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tk = btn.dataset.jTouch;
      const set = new Set(state.journey.hospitality || []);
      if (set.has(tk)) set.delete(tk);
      else set.add(tk);
      state.journey.hospitality = Array.from(set);
      btn.setAttribute('aria-pressed', String(set.has(tk)));
      refreshJourneyLivePass(root, state);
    });
  });

  root.querySelector('#jp-visa-assist')?.addEventListener('change', (ev) => {
    state.journey.includeVisaAssist = ev.currentTarget.checked;
    refreshJourneyLivePass(root, state);
  });

  root.querySelector('#jp-payment-method')?.addEventListener('change', (ev) => {
    state.journey.paymentMethod = ev.currentTarget.value;
  });

  root.querySelector('#j-btn-view-bookings')?.addEventListener('click', () => {
    onGoBookings?.();
  });

  root.querySelector('#j-btn-copy-ref')?.addEventListener('click', (ev) => {
    const ref = ev.currentTarget.dataset.ref;
    navigator.clipboard?.writeText(ref).catch(() => {});
    onToast(isAr ? 'تم نسخ المرجع' : 'Reference copied', 'success');
  });

  root.querySelector('#j-btn-new-journey')?.addEventListener('click', () => {
    state.journey.completedBooking = null;
    state.journey.step = 1;
    renderJourneyStudio(root, state, callbacks);
  });

  const passportForm = root.querySelector('#journey-passport-form');
  if (passportForm) {
    setupPassportValidation(passportForm, state, root, async () => {
      const btn = root.querySelector('#j-issue-pass-btn');
      const liveSummary = computeJourneySummary(state);
      if (!liveSummary?.hotel) return;

      if (btn) {
        btn.disabled = true;
        btn.textContent = t(state.lang, 'issuingPassBtn');
      }

      const guestName = passportForm.querySelector('#jp-guest-name').value.trim();
      const guestPhone = passportForm.querySelector('#jp-guest-phone').value.trim();
      const guestEmail = passportForm.querySelector('#jp-guest-email').value.trim();
      const paymentMethod = passportForm.querySelector('#jp-payment-method')?.value || 'card';
      const includeVisaAssist = Boolean(state.journey.includeVisaAssist);
      const tripMeta = {
        source: 'journey-studio',
        vibe: liveSummary.cityInfo.vibe,
        companion: state.journey.companion,
        seatPref: liveSummary.includeFlight ? state.journey.seatPref : null,
        hospitality: state.journey.hospitality || [],
      };

      try {
        let confirmRes;
        if (liveSummary.includeFlight && liveSummary.flight) {
          const lockRes = await lockBundle({
            hotelId: liveSummary.hotel.id,
            hotelTierId: liveSummary.hTier.id,
            flightId: liveSummary.flight.id,
            flightTierId: liveSummary.fTier.id,
            nights: liveSummary.nights,
            guests: liveSummary.pax,
            rooms: liveSummary.rooms,
            nationality: state.filters.nationality,
            includeVisaAssist,
            expectedBundleTotalUsd: liveSummary.totalUsd,
          });
          confirmRes = await confirmBundleBooking({
            lockId: lockRes.lock.id,
            guestName,
            guestPhone,
            guestEmail,
            paymentMethod,
            checkInDate: state.filters.checkInDate,
            checkOutDate: state.filters.checkOutDate,
            nationality: state.filters.nationality,
            includeVisaAssist,
            tripMeta,
          });
        } else {
          const lockRes = await lockInventory({
            itemType: 'hotel',
            itemId: liveSummary.hotel.id,
            tierId: liveSummary.hTier.id,
            quantity: liveSummary.rooms,
            nights: liveSummary.nights,
            expectedUnitPriceUsd: liveSummary.hTier.pricing.finalPriceUsd,
          });
          confirmRes = await confirmBooking({
            lockId: lockRes.lock.id,
            guestName,
            guestPhone,
            guestEmail,
            paymentMethod,
            checkInDate: state.filters.checkInDate,
            checkOutDate: state.filters.checkOutDate,
            nationality: state.filters.nationality,
            includeVisaAssist,
            tripMeta,
          });
        }

        state.journey.completedBooking = confirmRes.booking;
        onSnapshot(confirmRes.snapshot);
        onToast(
          isAr ? `تم تأكيد رحلتك بنجاح (${confirmRes.booking.reference})` : `Booking stamped! (${confirmRes.booking.reference})`,
          'success',
        );
      } catch (err) {
        onToast(isAr ? err.data?.messageAr || err.message : err.data?.messageEn || err.message, 'danger');
        if (err.data?.snapshot) onSnapshot(err.data.snapshot);
      } finally {
        if (btn && document.contains(btn)) {
          btn.disabled = false;
          btn.textContent = t(state.lang, 'issuePassBtn');
        }
      }
    });
  }
}

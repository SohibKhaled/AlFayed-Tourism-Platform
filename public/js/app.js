import {
  cancelBooking,
  connectLiveStream,
  getBootstrap,
  lookupBooking,
} from './api.js';
import { renderAdminView } from './admin.js';
import {
  closeDialogSmoothly,
  initCheckoutDialogLifecycle,
  openCheckoutForBundle,
  openCheckoutForItem,
} from './checkout.js';
import { brandCrestSvg, iconSvg } from './icons.js';
import { diffDays, formatCurrency, t } from './i18n.js';
import { refreshJourneyLivePass, renderJourneyStudio } from './journey.js';

// Conditional feature-detected polyfills per Modern Web Guidance
if (!('commandForElement' in HTMLButtonElement.prototype)) {
  import('https://esm.run/invokers-polyfill').catch(() => {});
}
if (!Object.hasOwn(HTMLElement.prototype, 'popover')) {
  import('https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js').catch(() => {});
}

const DEFAULT_IN = new Date(Date.now() + 86400000 * 4).toISOString().slice(0, 10);
const DEFAULT_OUT = new Date(Date.now() + 86400000 * 6).toISOString().slice(0, 10);

function loadFavorites() {
  try {
    const raw = localStorage.getItem('alfayed_favorites_v2');
    return Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveFavorites(ids) {
  try {
    localStorage.setItem('alfayed_favorites_v2', JSON.stringify(ids));
  } catch {
    // Ignore storage quota errors
  }
}

const state = {
  lang: 'ar',
  currency: 'EGP',
  activeView: 'store', // store | bookings | admin
  expMode: 'journey', // journey | explorer
  connected: false,
  snapshot: null,
  prevPrices: {},
  flashMap: {}, // { [id]: 'up' | 'down' }
  selectedTiers: {}, // { [itemId]: tierId }
  favorites: loadFavorites(),
  compareIds: [],
  bundle: {
    hotelId: null,
    hotelTierId: null,
    flightId: null,
    flightTierId: null,
  },
  journey: {
    step: 1,
    vibe: 'all',
    calSelectingOut: false,
    companion: 'couple',
    includeFlight: true,
    seatPref: 'window',
    hospitality: ['high_floor'],
    includeVisaAssist: false,
    paymentMethod: 'card',
    draftName: '',
    draftPhone: '',
    draftEmail: '',
    completedBooking: null,
  },
  filters: {
    mode: 'all', // all | hotels | flights | package
    destination: 'all',
    origin: 'all',
    checkInDate: DEFAULT_IN,
    checkOutDate: DEFAULT_OUT,
    nights: 2,
    adults: 2,
    children: 0,
    rooms: 1,
    nationality: 'EG',
    keyword: '',
    maxBudgetUsd: 1200,
    minStars: 0,
    board: 'all',
    freeCancelOnly: false,
    favoritesOnly: false,
    directOnly: false,
    refundableOnly: false,
    timeSlot: 'all',
    airline: 'all',
    showSoldOut: false,
    sortBy: 'featured',
  },
  verifiedBooking: null,
};

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(message, variant = 'info') {
  const stack = document.getElementById('toast-stack');
  if (!stack || !message) return;
  const el = document.createElement('div');
  el.className = `toast-item is-${variant}`;
  el.textContent = message;
  stack.prepend(el);
  setTimeout(() => {
    el.remove();
  }, 5200);
}

function getVisaInfo(countryCode) {
  const rules = state.snapshot?.visaRules?.[state.filters.nationality] || state.snapshot?.visaRules?.EG || {};
  return rules[countryCode] || {
    status: 'embassy',
    labelAr: 'مراجعة التأشيرة عبر الفايد',
    labelEn: 'Visa check via Al-Fayed',
    noteAr: 'إصدار الحجز متوافق مع ملفات السفارات',
    noteEn: 'Embassy-compliant reservation support',
    assistFeeUsd: 55,
  };
}

function getActiveTier(item) {
  if (!item.tiers || item.tiers.length === 0) return null;
  const chosenId = state.selectedTiers[item.id];
  return (
    item.tiers.find((x) => x.id === chosenId) ||
    item.tiers.find((x) => x.effectiveAvailable > 0) ||
    item.tiers[0]
  );
}

function getBundleTotals() {
  const snap = state.snapshot;
  if (!snap) return null;
  const hotel = state.bundle.hotelId ? snap.hotels.find((h) => h.id === state.bundle.hotelId) : null;
  const flight = state.bundle.flightId ? snap.flights.find((f) => f.id === state.bundle.flightId) : null;
  if (!hotel && !flight) return null;

  const hTier = hotel
    ? hotel.tiers?.find((x) => x.id === (state.bundle.hotelTierId || hotel.selectedTierId)) || hotel.tiers?.[0]
    : null;
  const fTier = flight
    ? flight.tiers?.find((x) => x.id === (state.bundle.flightTierId || flight.selectedTierId)) || flight.tiers?.[0]
    : null;

  const nights = Math.max(1, Number(state.filters.nights) || 2);
  const rooms = Math.max(1, Number(state.filters.rooms) || 1);
  const pax = Math.max(1, (Number(state.filters.adults) || 2) + (Number(state.filters.children) || 0));

  const hotelSub = hTier ? hTier.pricing.finalPriceUsd * nights * rooms : 0;
  const flightSub = fTier ? fTier.pricing.finalPriceUsd * pax : 0;
  const separateUsd = Math.round((hotelSub + flightSub) * 100) / 100;
  const pct = Number(snap.markupConfig?.packageDiscountPercent ?? 6);
  const discountUsd = hotel && flight ? Math.round(((separateUsd * pct) / 100) * 100) / 100 : 0;
  const totalUsd = Math.round((separateUsd - discountUsd) * 100) / 100;

  const hotelSoldOut = hotel && (!hTier || hTier.effectiveAvailable < rooms);
  const flightSoldOut = flight && (!fTier || fTier.effectiveAvailable < pax);

  return { hotel, hTier, flight, fTier, hotelSub, flightSub, separateUsd, discountUsd, pct, totalUsd, hotelSoldOut, flightSoldOut };
}

function detectPriceTransitions(newSnap) {
  const all = [...(newSnap.hotels || []), ...(newSnap.flights || [])];
  const nextPrev = {};
  const flashes = {};

  for (const item of all) {
    const tier = getActiveTier(item);
    const price = tier ? tier.pricing.finalPriceUsd : item.pricing.finalPriceUsd;
    nextPrev[item.id] = price;
    if (state.prevPrices[item.id] !== undefined && state.prevPrices[item.id] !== price) {
      flashes[item.id] = price > state.prevPrices[item.id] ? 'up' : 'down';
    }
  }
  state.prevPrices = nextPrev;
  state.flashMap = flashes;
}

function applyLocaleAndChrome() {
  const isAr = state.lang === 'ar';
  document.documentElement.lang = isAr ? 'ar' : 'en';
  document.documentElement.dir = isAr ? 'rtl' : 'ltr';
  document.title = isAr
    ? 'الفايد للسياحة | حجز الفنادق والطيران والباقات لحظياً'
    : 'Al-Fayed Tourism | Real-Time Hotels, Flights & Dual Packages';

  const setTxt = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  const crestEl = document.getElementById('brand-crest');
  if (crestEl && !crestEl.innerHTML.trim()) crestEl.innerHTML = brandCrestSvg('hdr');
  const fCrest = document.getElementById('footer-crest');
  if (fCrest && !fCrest.innerHTML.trim()) fCrest.innerHTML = brandCrestSvg('ftr');

  setTxt('brand-name', t(state.lang, 'brandName'));
  setTxt('brand-sub', t(state.lang, 'brandSub'));
  setTxt('footer-brand-name', t(state.lang, 'brandName'));
  setTxt('footer-note', t(state.lang, 'footerNote'));
  setTxt('nav-store-label', t(state.lang, 'navStore'));
  setTxt('nav-bookings-label', t(state.lang, 'navBookings'));
  setTxt('nav-admin-label', t(state.lang, 'navAdmin'));
  setTxt('lang-toggle-btn', t(state.lang, 'langToggle'));

  setTxt('hero-eyebrow-text', t(state.lang, 'heroEyebrow'));
  setTxt('hero-title-prefix', t(state.lang, 'heroTitlePrefix'));
  setTxt('hero-title-brand', t(state.lang, 'brandName'));
  setTxt('hero-subtitle', t(state.lang, 'heroSubtitle'));
  setTxt('trust-no-login', t(state.lang, 'trustNoLogin'));
  setTxt('trust-live-sync', t(state.lang, 'trustLiveSync'));
  setTxt('trust-zero-double', t(state.lang, 'trustZeroDouble'));
  setTxt('trust-bundle', t(state.lang, 'trustBundle'));

  setTxt('seg-all-label', t(state.lang, 'segAll'));
  setTxt('seg-hotels-label', t(state.lang, 'segHotels'));
  setTxt('seg-flights-label', t(state.lang, 'segFlights'));
  setTxt('seg-package-label', t(state.lang, 'segPackage'));
  const pct = Number(state.snapshot?.markupConfig?.packageDiscountPercent ?? 6);
  setTxt('seg-package-badge', `-${pct}%`);
  setTxt('lbl-nationality', t(state.lang, 'lblNationality'));
  setTxt('zero-login-chip-text', t(state.lang, 'zeroLoginChip'));

  setTxt('lbl-destination', t(state.lang, 'lblDestination'));
  setTxt('lbl-origin', t(state.lang, 'lblOrigin'));
  setTxt('lbl-checkin', t(state.lang, 'lblCheckIn'));
  const outLabel = document.getElementById('lbl-checkout');
  if (outLabel) {
    const n = state.filters.nights;
    const nTxt = n === 1 ? (isAr ? 'ليلة واحدة' : '1 Night') : `${n} ${t(state.lang, 'nightsLabel')}`;
    outLabel.innerHTML = `${escapeHtml(t(state.lang, 'lblCheckOut'))} <span class="nights-tag num" id="search-nights-tag">${nTxt}</span>`;
  }
  setTxt('lbl-guests', t(state.lang, 'lblGuests'));
  setTxt('lbl-adults-step', t(state.lang, 'adultsStep'));
  setTxt('lbl-children-step', t(state.lang, 'childrenStep'));
  setTxt('lbl-rooms-step', t(state.lang, 'roomsStep'));
  setTxt('guests-done-btn', t(state.lang, 'doneBtn'));
  setTxt('search-submit-label', t(state.lang, 'searchSubmit'));

  const gSum = document.getElementById('guests-summary-text');
  if (gSum) {
    const { adults, children, rooms } = state.filters;
    const parts = [`${adults} ${t(state.lang, 'adultsShort')}`];
    if (children > 0) parts.push(`${children} ${t(state.lang, 'childrenShort')}`);
    parts.push(`${rooms} ${t(state.lang, 'roomsShort')}`);
    gSum.textContent = parts.join(' • ');
  }

  const livePill = document.getElementById('live-status-pill');
  const liveTxt = document.getElementById('live-status-text');
  if (livePill && liveTxt) {
    livePill.classList.toggle('is-disconnected', !state.connected);
    liveTxt.textContent = state.connected ? t(state.lang, 'liveConnected') : t(state.lang, 'liveDisconnected');
  }

  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.setAttribute('aria-selected', String(btn.dataset.view === state.activeView));
  });
  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.setAttribute('aria-selected', String(btn.dataset.searchMode === state.filters.mode));
  });
  document.querySelectorAll('[data-exp-mode]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.expMode === state.expMode));
  });

  setTxt('exp-journey-title', t(state.lang, 'expJourneyTitle'));
  setTxt('exp-journey-sub', t(state.lang, 'expJourneySub'));
  setTxt('exp-explorer-title', t(state.lang, 'expExplorerTitle'));
  setTxt('exp-explorer-sub', t(state.lang, 'expExplorerSub'));

  const expSearchShell = document.getElementById('explorer-search-shell');
  if (expSearchShell) {
    expSearchShell.hidden = state.expMode !== 'explorer';
  }

  const syncVal = (id, v) => {
    const el = document.getElementById(id);
    if (el && v !== undefined && el.value !== String(v)) el.value = String(v);
  };
  syncVal('search-checkin', state.filters.checkInDate);
  syncVal('search-checkout', state.filters.checkOutDate);
  syncVal('search-nationality', state.filters.nationality);
  syncVal('search-destination', state.filters.destination);
  syncVal('search-origin', state.filters.origin);
  setTxt('step-val-adults', String(state.filters.adults));
  setTxt('step-val-children', String(state.filters.children));
  setTxt('step-val-rooms', String(state.filters.rooms));

  const badge = document.getElementById('bookings-count-badge');
  const confirmedCount = (state.snapshot?.bookings || []).filter((b) => b.status === 'confirmed').length;
  if (badge) {
    badge.textContent = String(confirmedCount);
    badge.hidden = confirmedCount === 0;
  }

  const heroSec = document.getElementById('hero-section');
  if (heroSec) {
    heroSec.hidden = state.activeView !== 'store';
  }

  const latestEv = state.snapshot?.feedEvents?.[0];
  if (latestEv) {
    setTxt('ticker-badge', latestEv.provider || 'Global EIS');
    setTxt('ticker-message', isAr ? latestEv.messageAr : latestEv.messageEn);
    setTxt('ticker-time', new Date(latestEv.ts).toLocaleTimeString(isAr ? 'ar-EG' : 'en-US'));
  }
}

function populateSearchOptions() {
  if (!state.snapshot) return;
  const isAr = state.lang === 'ar';
  const destSel = document.getElementById('search-destination');
  const originSel = document.getElementById('search-origin');
  const curDest = state.filters.destination;
  const curOrig = state.filters.origin;

  if (destSel) {
    const cities = new Map();
    for (const h of state.snapshot.hotels) {
      cities.set(h.cityKey, isAr ? `${h.cityAr} (${h.countryAr})` : `${h.cityEn}, ${h.countryEn}`);
    }
    destSel.innerHTML = `<option value="all">${t(state.lang, 'allDestinations')}</option>`;
    for (const [k, label] of cities.entries()) {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = label;
      if (k === curDest) opt.selected = true;
      destSel.appendChild(opt);
    }
  }

  if (originSel) {
    const origins = new Map();
    for (const f of state.snapshot.flights) {
      origins.set(f.originCode, isAr ? `${f.originAr} (${f.originCode})` : `${f.originEn} (${f.originCode})`);
    }
    originSel.innerHTML = `<option value="all">${t(state.lang, 'allOrigins')}</option>`;
    for (const [code, label] of origins.entries()) {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = label;
      if (code === curOrig) opt.selected = true;
      originSel.appendChild(opt);
    }
  }
}

function renderSpotlightRail() {
  if (!state.snapshot) return '';
  const isAr = state.lang === 'ar';
  const byCity = new Map();

  for (const h of state.snapshot.hotels) {
    if (h.status === 'sold_out') continue;
    const prev = byCity.get(h.cityKey);
    const minPrice = h.pricing.finalPriceUsd;
    if (!prev || minPrice < prev.minUsd) {
      byCity.set(h.cityKey, {
        cityKey: h.cityKey,
        label: isAr ? h.cityAr : h.cityEn,
        image: h.image,
        minUsd: minPrice,
        countryCode: h.countryCode,
      });
    }
  }

  const pills = Array.from(byCity.values())
    .map((c) => {
      const active = state.filters.destination === c.cityKey;
      return `
        <button type="button" class="dest-pill-card" data-dest-pick="${escapeHtml(c.cityKey)}" aria-pressed="${active}">
          <img class="dest-thumb" src="${escapeHtml(c.image)}" alt="${escapeHtml(c.label)}" loading="lazy">
          <span class="dest-meta">
            <span class="dest-name">${escapeHtml(c.label)}</span>
            <span class="dest-price num">${isAr ? 'من' : 'From'} ${formatCurrency(c.minUsd, state.currency, state.snapshot.rates)}</span>
          </span>
        </button>
      `;
    })
    .join('');

  return `
    <section class="spotlight-section" aria-label="${escapeHtml(t(state.lang, 'spotlightTitle'))}">
      <div class="spotlight-header">
        <h2 class="spotlight-title">${t(state.lang, 'spotlightTitle')}</h2>
        ${
          state.filters.destination !== 'all'
            ? `<button type="button" class="text-link-btn" id="clear-dest-pill">${t(state.lang, 'allDestinations')}</button>`
            : ''
        }
      </div>
      <div class="spotlight-rail">${pills}</div>
    </section>
  `;
}

function filterAndSortItems() {
  const snap = state.snapshot;
  const f = state.filters;
  const kw = f.keyword.trim().toLowerCase();

  let hotels = snap.hotels.filter((h) => {
    if (!f.showSoldOut && h.status === 'sold_out') return false;
    if (f.destination !== 'all' && h.cityKey !== f.destination) return false;
    const tier = getActiveTier(h);
    const priceUsd = tier ? tier.pricing.finalPriceUsd : h.pricing.finalPriceUsd;
    if (priceUsd > f.maxBudgetUsd) return false;
    if (f.minStars > 0 && h.stars < f.minStars) return false;
    if (f.board !== 'all') {
      const hasBoard = h.tiers?.some((x) => x.boardKey === f.board && (f.showSoldOut || x.effectiveAvailable > 0));
      if (!hasBoard) return false;
    }
    if (f.freeCancelOnly && !h.freeCancellation) return false;
    if (f.favoritesOnly && !state.favorites.includes(h.id)) return false;
    if (kw) {
      const hay = `${h.nameAr} ${h.nameEn} ${h.cityAr} ${h.cityEn} ${h.districtAr} ${h.districtEn} ${h.provider}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });

  let flights = snap.flights.filter((fl) => {
    if (!f.showSoldOut && fl.status === 'sold_out') return false;
    if (f.destination !== 'all' && fl.destKey !== f.destination) return false;
    if (f.origin !== 'all' && fl.originCode !== f.origin) return false;
    const tier = getActiveTier(fl);
    const priceUsd = tier ? tier.pricing.finalPriceUsd : fl.pricing.finalPriceUsd;
    if (priceUsd > f.maxBudgetUsd) return false;
    if (f.directOnly && fl.stopsCount > 0) return false;
    if (f.refundableOnly && !fl.refundable) return false;
    if (f.timeSlot !== 'all' && fl.timeSlot !== f.timeSlot) return false;
    if (f.airline !== 'all' && fl.airlineCode !== f.airline) return false;
    if (f.favoritesOnly && !state.favorites.includes(fl.id)) return false;
    if (kw) {
      const hay = `${fl.airlineAr} ${fl.airlineEn} ${fl.flightNumber} ${fl.destAr} ${fl.destEn} ${fl.originCode} ${fl.destCode} ${fl.provider}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });

  const sorter = (a, b) => {
    const ta = getActiveTier(a);
    const tb = getActiveTier(b);
    const pa = ta ? ta.pricing.finalPriceUsd : a.pricing.finalPriceUsd;
    const pb = tb ? tb.pricing.finalPriceUsd : b.pricing.finalPriceUsd;
    if (f.sortBy === 'price_low') return pa - pb;
    if (f.sortBy === 'rating') return (b.rating || 9) - (a.rating || 9);
    if (f.sortBy === 'stock') return b.effectiveAvailable - a.effectiveAvailable;
    return (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || pa - pb;
  };

  hotels = [...hotels].sort(sorter);
  flights = [...flights].sort(sorter);

  return { hotels, flights };
}

function renderHotelCard(hotel) {
  const isAr = state.lang === 'ar';
  const rates = state.snapshot.rates;
  const activeTier = getActiveTier(hotel);
  const priceUsd = activeTier ? activeTier.pricing.finalPriceUsd : hotel.pricing.finalPriceUsd;
  const availCount = activeTier ? activeTier.effectiveAvailable : hotel.effectiveAvailable;
  const isSold = hotel.status === 'sold_out' || (activeTier && activeTier.availableCount <= 0);
  const isLocked = !isSold && availCount <= 0;
  const isPinned = state.bundle.hotelId === hotel.id;
  const isFav = state.favorites.includes(hotel.id);
  const isCmp = state.compareIds.includes(hotel.id);
  const flashCls = state.flashMap[hotel.id] ? `price-flash-${state.flashMap[hotel.id]}` : '';

  const visa = getVisaInfo(hotel.countryCode);
  const visaCls = visa.status === 'free' || visa.status === 'domestic' ? 'visa-free' : visa.status === 'embassy' ? 'visa-embassy' : '';

  const stockClass = isSold ? 'is-sold' : isLocked ? 'is-locked' : availCount <= 2 ? 'is-low' : '';
  const stockLabel = isSold
    ? t(state.lang, 'soldOutBadge')
    : isLocked
      ? t(state.lang, 'tempLockedBadge')
      : `${t(state.lang, 'roomsLeft')} ${availCount}`;

  const tierButtons = (hotel.tiers || [])
    .map((tr) => {
      const sel = activeTier?.id === tr.id;
      const disabled = tr.availableCount <= 0;
      const shortName = tr.code === 'STD' ? (isAr ? 'قياسية' : 'Standard') : tr.code === 'DLX' ? (isAr ? 'ديلوكس' : 'Deluxe') : isAr ? 'جناح' : 'Suite';
      return `
        <button type="button" class="tier-mini-btn ${sel ? 'is-selected' : ''}" ${disabled ? 'disabled' : ''} data-pick-tier="hotel:${hotel.id}:${tr.id}">
          <div>${shortName}</div>
          <div class="num" style="font-size:0.68rem;">${formatCurrency(tr.pricing.finalPriceUsd, state.currency, rates)}</div>
        </button>
      `;
    })
    .join('');

  const trendHtml =
    hotel.priceTrend === 'up'
      ? `<span class="trend-arrow up">↑</span>`
      : hotel.priceTrend === 'down'
        ? `<span class="trend-arrow down">↓</span>`
        : '';

  return `
    <article class="offer-card ${isPinned ? 'is-pinned' : ''} ${isSold ? 'is-sold-out' : ''} ${flashCls}" data-offer-id="${hotel.id}">
      <div class="card-media">
        <img src="${escapeHtml(hotel.image)}" alt="${escapeHtml(isAr ? hotel.nameAr : hotel.nameEn)}" loading="lazy">
        <div class="card-media-gradient"></div>

        <div class="card-top-badges">
          <span class="provider-badge">${escapeHtml(hotel.provider)} • ${hotel.feedLatencyMs}ms</span>
          <div class="card-actions-overlay">
            <button type="button" class="btn-icon-pill is-fav ${isFav ? 'is-active' : ''}" data-fav-id="${hotel.id}" aria-label="Favorite" title="${isAr ? 'حفظ بالمفضلة' : 'Save'}">
              ${iconSvg(isFav ? 'heartFill' : 'heart', 13)}
            </button>
            <button type="button" class="btn-icon-pill ${isCmp ? 'is-active' : ''}" data-cmp-id="${hotel.id}" title="${t(state.lang, 'compareAdd')}">
              ${iconSvg('compare', 13)}
            </button>
          </div>
        </div>

        <div class="media-bottom-bar">
          <span class="stock-pill ${stockClass} num">${stockLabel}</span>
          <span class="visa-mini-pill ${visaCls}">${iconSvg('passport', 11)} ${escapeHtml(isAr ? visa.labelAr.split('(')[0] : visa.labelEn.split('(')[0])}</span>
        </div>
      </div>

      <div class="card-body">
        <div class="card-title-row">
          <div>
            <div style="color:var(--brand-gold); font-size:0.75rem; line-height:1; margin-block-end:0.2rem;">${'★'.repeat(hotel.stars)}</div>
            <h3 class="card-title">${escapeHtml(isAr ? hotel.nameAr : hotel.nameEn)}</h3>
          </div>
          <span class="rating-pill num">${hotel.rating}</span>
        </div>

        <div class="card-location">
          ${iconSvg('pin', 14)}
          <span>${escapeHtml(isAr ? `${hotel.cityAr} • ${hotel.districtAr}` : `${hotel.cityEn} • ${hotel.districtEn}`)}</span>
        </div>
        <div class="card-distance">${escapeHtml(isAr ? hotel.distanceAr : hotel.distanceEn)}</div>

        <div class="tier-selector-mini" role="group" aria-label="Room Tier">${tierButtons}</div>

        <div class="amenities-row">
          ${activeTier ? `<span class="amenity-chip is-green">${escapeHtml(isAr ? activeTier.boardAr : activeTier.boardEn)}</span>` : ''}
          ${activeTier?.freeCancellation ? `<span class="amenity-chip">${t(state.lang, 'freeCancelTag')}</span>` : ''}
          <span class="amenity-chip num">${activeTier?.sizeSqm || 38} m²</span>
        </div>

        <div class="card-footer-price">
          <div class="price-top-line">
            <div>
              <span class="price-label">${t(state.lang, 'perNight')}</span>
              <div class="price-value num">${formatCurrency(priceUsd, state.currency, rates)} ${trendHtml}</div>
            </div>
            <div style="font-size:0.72rem; color:var(--ink-muted); text-align:end;">
              ${isAr ? `${state.filters.nights} ليالٍ:` : `${state.filters.nights}N total:`}
              <strong class="num" style="display:block; color:var(--ink-primary);">${formatCurrency(priceUsd * state.filters.nights, state.currency, rates)}</strong>
            </div>
          </div>

          <div class="card-cta-pair">
            <button type="button" class="btn btn-primary btn-sm" ${isSold || isLocked ? 'disabled' : ''} data-book-single="hotel:${hotel.id}:${activeTier?.id || ''}">
              ${t(state.lang, 'bookNow')}
            </button>
            <button type="button" class="btn ${isPinned ? 'btn-gold' : 'btn-outline'} btn-sm" ${isSold || isLocked ? 'disabled' : ''} data-pin-bundle="hotel:${hotel.id}:${activeTier?.id || ''}">
              ${isPinned ? t(state.lang, 'pinnedInBundle') : t(state.lang, 'addToBundle')}
            </button>
          </div>

          <div class="card-secondary-links">
            <button type="button" class="text-link-btn" data-open-detail="hotel:${hotel.id}">${t(state.lang, 'inspectDetails')}</button>
            <button type="button" class="text-link-btn" data-cmp-id="${hotel.id}">${isCmp ? t(state.lang, 'compared') : t(state.lang, 'compareAdd')}</button>
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderFlightCard(flight) {
  const isAr = state.lang === 'ar';
  const rates = state.snapshot.rates;
  const activeTier = getActiveTier(flight);
  const priceUsd = activeTier ? activeTier.pricing.finalPriceUsd : flight.pricing.finalPriceUsd;
  const availCount = activeTier ? activeTier.effectiveAvailable : flight.effectiveAvailable;
  const isSold = flight.status === 'sold_out' || (activeTier && activeTier.availableCount <= 0);
  const isLocked = !isSold && availCount <= 0;
  const isPinned = state.bundle.flightId === flight.id;
  const isFav = state.favorites.includes(flight.id);
  const isCmp = state.compareIds.includes(flight.id);
  const flashCls = state.flashMap[flight.id] ? `price-flash-${state.flashMap[flight.id]}` : '';

  const visa = getVisaInfo(flight.countryCode);
  const visaCls = visa.status === 'free' || visa.status === 'domestic' ? 'visa-free' : visa.status === 'embassy' ? 'visa-embassy' : '';

  const tierButtons = (flight.tiers || [])
    .map((tr) => {
      const sel = activeTier?.id === tr.id;
      const disabled = tr.availableCount <= 0;
      const shortName = tr.id === 'light' ? (isAr ? 'خفيف' : 'Light') : tr.id === 'flex' ? (isAr ? 'مرن' : 'Flex') : isAr ? 'بيزنس' : 'Business';
      return `
        <button type="button" class="tier-mini-btn ${sel ? 'is-selected' : ''}" ${disabled ? 'disabled' : ''} data-pick-tier="flight:${flight.id}:${tr.id}">
          <div>${shortName}</div>
          <div class="num" style="font-size:0.68rem;">${formatCurrency(tr.pricing.finalPriceUsd, state.currency, rates)}</div>
        </button>
      `;
    })
    .join('');

  const stockLabel = isSold
    ? t(state.lang, 'soldOutBadge')
    : isLocked
      ? t(state.lang, 'tempLockedBadge')
      : `${t(state.lang, 'seatsLeft')} ${availCount}`;

  return `
    <article class="offer-card ${isPinned ? 'is-pinned' : ''} ${isSold ? 'is-sold-out' : ''} ${flashCls}" data-offer-id="${flight.id}">
      <div class="flight-head">
        <div class="airline-badge-wrap">
          <span class="airline-code mono">${escapeHtml(flight.airlineCode)}</span>
          <div>
            <div style="font-weight:800; font-size:0.94rem;">${escapeHtml(isAr ? flight.airlineAr : flight.airlineEn)}</div>
            <div class="mono" style="font-size:0.72rem; opacity:0.8;">${escapeHtml(flight.flightNumber)} • ${escapeHtml(flight.aircraft || '')}</div>
          </div>
        </div>
        <div style="display:flex; gap:0.35rem; align-items:center;">
          <button type="button" class="btn-icon-pill is-fav ${isFav ? 'is-active' : ''}" data-fav-id="${flight.id}" aria-label="Favorite">
            ${iconSvg(isFav ? 'heartFill' : 'heart', 13)}
          </button>
          <span class="provider-badge">${escapeHtml(flight.provider)}</span>
        </div>
      </div>

      <div class="card-body">
        <div class="flight-timeline">
          <div class="airport-node">
            <span class="airport-time num">${escapeHtml(flight.depTime)}</span>
            <span class="airport-code mono">${escapeHtml(flight.originCode)} • ${escapeHtml(isAr ? flight.originAr : flight.originEn)}</span>
          </div>
          <div class="flight-track">
            <span class="num" style="font-size:0.72rem; color:var(--ink-muted); font-weight:700;">${escapeHtml(isAr ? flight.durationAr : flight.durationEn)}</span>
            <div class="flight-track-line"></div>
            <span style="font-size:0.7rem; font-weight:800; color:${flight.stopsCount === 0 ? 'var(--brand-teal)' : 'var(--status-warning)'};">
              ${flight.stopsCount === 0 ? t(state.lang, 'directFlight') : t(state.lang, 'oneStopFlight')}
            </span>
          </div>
          <div class="airport-node is-end">
            <span class="airport-time num">${escapeHtml(flight.arrTime)}</span>
            <span class="airport-code mono">${escapeHtml(flight.destCode)} • ${escapeHtml(isAr ? flight.destAr : flight.destEn)}</span>
          </div>
        </div>

        <div class="tier-selector-mini" role="group" aria-label="Fare Tier">${tierButtons}</div>

        <div class="amenities-row">
          <span class="amenity-chip">${escapeHtml(isAr ? activeTier?.baggageAr || flight.baggageAr : activeTier?.baggageEn || flight.baggageEn)}</span>
          ${activeTier?.refundable ? `<span class="amenity-chip is-green">${t(state.lang, 'refundableTag')}</span>` : ''}
          <span class="visa-mini-pill ${visaCls}">${iconSvg('passport', 11)} ${escapeHtml(isAr ? visa.labelAr.split('(')[0] : visa.labelEn.split('(')[0])}</span>
        </div>

        <div class="card-footer-price">
          <div class="price-top-line">
            <div>
              <span class="price-label">${t(state.lang, 'perTraveler')}</span>
              <div class="price-value num">${formatCurrency(priceUsd, state.currency, rates)}</div>
            </div>
            <span class="stock-pill ${isSold ? 'is-sold' : availCount <= 2 ? 'is-low' : ''} num">${stockLabel}</span>
          </div>

          <div class="card-cta-pair">
            <button type="button" class="btn btn-primary btn-sm" ${isSold || isLocked ? 'disabled' : ''} data-book-single="flight:${flight.id}:${activeTier?.id || ''}">
              ${t(state.lang, 'bookNow')}
            </button>
            <button type="button" class="btn ${isPinned ? 'btn-gold' : 'btn-outline'} btn-sm" ${isSold || isLocked ? 'disabled' : ''} data-pin-bundle="flight:${flight.id}:${activeTier?.id || ''}">
              ${isPinned ? t(state.lang, 'pinnedInBundle') : t(state.lang, 'addToBundle')}
            </button>
          </div>

          <div class="card-secondary-links">
            <button type="button" class="text-link-btn" data-open-detail="flight:${flight.id}">${t(state.lang, 'inspectFlight')}</button>
            <button type="button" class="text-link-btn" data-cmp-id="${flight.id}">${isCmp ? t(state.lang, 'compared') : t(state.lang, 'compareAdd')}</button>
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderStoreResultsInto(container) {
  if (!container || !state.snapshot) return;
  const { hotels, flights } = filterAndSortItems();
  const mode = state.filters.mode;
  const isAr = state.lang === 'ar';

  const soldOutTotal = state.snapshot.metrics.soldOutHotelCount + state.snapshot.metrics.soldOutFlightCount;

  const airlineOpts = new Map();
  for (const fl of state.snapshot.flights) {
    airlineOpts.set(fl.airlineCode, isAr ? fl.airlineAr : fl.airlineEn);
  }

  let sectionsHtml = '';
  if (mode === 'all' || mode === 'hotels' || mode === 'package') {
    sectionsHtml += `
      <section aria-label="${escapeHtml(t(state.lang, 'hotelsSection'))}">
        <div class="section-header-row">
          <h2 class="section-heading">
            <span class="section-icon">${iconSvg('hotel', 20)}</span>
            <span>${t(state.lang, 'hotelsSection')} (${hotels.length})</span>
          </h2>
        </div>
        ${
          hotels.length > 0
            ? `<div class="cards-grid">${hotels.map(renderHotelCard).join('')}</div>`
            : `<div class="panel-card" style="text-align:center; color:var(--ink-muted);">${t(state.lang, 'noHotelsMatch')}</div>`
        }
      </section>
    `;
  }

  if (mode === 'all' || mode === 'flights' || mode === 'package') {
    sectionsHtml += `
      <section aria-label="${escapeHtml(t(state.lang, 'flightsSection'))}">
        <div class="section-header-row">
          <h2 class="section-heading">
            <span class="section-icon">${iconSvg('plane', 20)}</span>
            <span>${t(state.lang, 'flightsSection')} (${flights.length})</span>
          </h2>
        </div>
        ${
          flights.length > 0
            ? `<div class="cards-grid">${flights.map(renderFlightCard).join('')}</div>`
            : `<div class="panel-card" style="text-align:center; color:var(--ink-muted);">${t(state.lang, 'noFlightsMatch')}</div>`
        }
      </section>
    `;
  }

  container.innerHTML = `
    <div class="catalog-toolbar">
      <div class="toolbar-stats">
        <span class="metric-chip num">${hotels.length} ${isAr ? 'فندق' : 'Hotels'}</span>
        <span class="metric-chip num">${flights.length} ${isAr ? 'رحلة' : 'Flights'}</span>
        ${
          soldOutTotal > 0
            ? `<span class="metric-chip hidden-sold-pill num">${t(state.lang, 'hiddenSoldLabel')} ${soldOutTotal}</span>`
            : ''
        }
      </div>

      <div style="display:flex; align-items:center; gap:0.5rem;">
        <label for="sort-select" style="font-size:0.8rem; font-weight:700; color:var(--ink-muted);">${t(state.lang, 'sortLabel')}</label>
        <select class="input-control" id="sort-select" style="inline-size:auto; block-size:2.35rem; font-size:0.82rem;">
          <option value="featured" ${state.filters.sortBy === 'featured' ? 'selected' : ''}>${t(state.lang, 'sortFeatured')}</option>
          <option value="price_low" ${state.filters.sortBy === 'price_low' ? 'selected' : ''}>${t(state.lang, 'sortPriceLow')}</option>
          <option value="rating" ${state.filters.sortBy === 'rating' ? 'selected' : ''}>${t(state.lang, 'sortRating')}</option>
          <option value="stock" ${state.filters.sortBy === 'stock' ? 'selected' : ''}>${t(state.lang, 'sortStock')}</option>
        </select>
      </div>
    </div>

    ${sectionsHtml}
  `;

  bindResultsEvents(container);
}

function renderStoreView(root) {
  const isAr = state.lang === 'ar';
  const rates = state.snapshot.rates;

  const airlineOptions = Array.from(
    new Map(state.snapshot.flights.map((f) => [f.airlineCode, isAr ? f.airlineAr : f.airlineEn])).entries(),
  )
    .map(([code, label]) => `<option value="${code}" ${state.filters.airline === code ? 'selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');

  const pkgBanner =
    state.filters.mode === 'package'
      ? `
      <div class="package-hero-banner">
        <div>
          <h2 style="font-size:1.15rem; color:var(--brand-gold-bright); margin-block-end:0.25rem;">✨ ${t(state.lang, 'packageBannerTitle')}</h2>
          <p style="margin:0; font-size:0.86rem; color:var(--ink-on-dark-muted);">${t(state.lang, 'packageBannerSub')}</p>
        </div>
        <button type="button" class="btn btn-gold btn-sm" id="btn-smart-auto-bundle">
          ${isAr ? 'اختر أرخص باكيدج متوافق الآن' : 'Suggest Best Bundle Now'}
        </button>
      </div>
    `
      : '';

  root.innerHTML = `
    ${renderSpotlightRail()}
    ${pkgBanner}

    <div class="store-layout">
      <aside class="filters-sidebar" aria-label="${escapeHtml(t(state.lang, 'filtersTitle'))}">
        <div class="filter-head">
          <h3 style="font-size:0.98rem; font-weight:800;">${t(state.lang, 'filtersTitle')}</h3>
          <button type="button" class="text-link-btn" id="btn-reset-filters">${t(state.lang, 'resetFilters')}</button>
        </div>

        <div class="filter-group">
          <label class="filter-group-title" for="filter-keyword-input">${t(state.lang, 'searchKeyword')}</label>
          <input class="input-control" id="filter-keyword-input" type="search" value="${escapeHtml(state.filters.keyword)}" placeholder="${escapeHtml(t(state.lang, 'searchPlaceholder'))}" style="block-size:2.45rem; font-size:0.84rem;">
        </div>

        <div class="filter-group">
          <div class="slider-meta-row">
            <label for="max-budget-slider">${t(state.lang, 'maxBudget')}</label>
            <span class="slider-val-pill num" id="max-budget-readout">${formatCurrency(state.filters.maxBudgetUsd, state.currency, rates)}</span>
          </div>
          <input
            type="range"
            id="max-budget-slider"
            class="brand-range-slider"
            min="100"
            max="1200"
            step="20"
            value="${state.filters.maxBudgetUsd}"
            aria-valuetext="${formatCurrency(state.filters.maxBudgetUsd, state.currency, rates)}"
          >
        </div>

        <div class="filter-group">
          <span class="filter-group-title">${t(state.lang, 'starFilter')}</span>
          <div class="chip-toggle-group">
            <button type="button" class="chip-filter-btn" data-star-val="0" aria-pressed="${state.filters.minStars === 0}">${t(state.lang, 'allStars')}</button>
            <button type="button" class="chip-filter-btn" data-star-val="5" aria-pressed="${state.filters.minStars === 5}">${t(state.lang, 'stars5')}</button>
            <button type="button" class="chip-filter-btn" data-star-val="4" aria-pressed="${state.filters.minStars === 4}">${t(state.lang, 'stars4plus')}</button>
          </div>
        </div>

        <div class="filter-group">
          <span class="filter-group-title">${t(state.lang, 'boardFilter')}</span>
          <div class="chip-toggle-group">
            <button type="button" class="chip-filter-btn" data-board-val="all" aria-pressed="${state.filters.board === 'all'}">${t(state.lang, 'boardAll')}</button>
            <button type="button" class="chip-filter-btn" data-board-val="bb" aria-pressed="${state.filters.board === 'bb'}">${t(state.lang, 'boardBb')}</button>
            <button type="button" class="chip-filter-btn" data-board-val="hb" aria-pressed="${state.filters.board === 'hb'}">${t(state.lang, 'boardHb')}</button>
            <button type="button" class="chip-filter-btn" data-board-val="ai" aria-pressed="${state.filters.board === 'ai'}">${t(state.lang, 'boardAi')}</button>
          </div>
        </div>

        <div class="filter-group">
          <span class="filter-group-title">${t(state.lang, 'timeSlotFilter')}</span>
          <div class="chip-toggle-group">
            <button type="button" class="chip-filter-btn" data-slot-val="all" aria-pressed="${state.filters.timeSlot === 'all'}">${t(state.lang, 'slotAll')}</button>
            <button type="button" class="chip-filter-btn" data-slot-val="morning" aria-pressed="${state.filters.timeSlot === 'morning'}">${t(state.lang, 'slotMorning')}</button>
            <button type="button" class="chip-filter-btn" data-slot-val="afternoon" aria-pressed="${state.filters.timeSlot === 'afternoon'}">${t(state.lang, 'slotAfternoon')}</button>
            <button type="button" class="chip-filter-btn" data-slot-val="evening" aria-pressed="${state.filters.timeSlot === 'evening'}">${t(state.lang, 'slotEvening')}</button>
          </div>
        </div>

        <div class="filter-group">
          <label class="filter-group-title" for="filter-airline-select">${t(state.lang, 'airlineFilter')}</label>
          <select class="input-control" id="filter-airline-select" style="block-size:2.4rem; font-size:0.84rem;">
            <option value="all">${t(state.lang, 'allAirlines')}</option>
            ${airlineOptions}
          </select>
        </div>

        <div class="filter-group" style="gap:0.55rem;">
          <label class="checkbox-row">
            <input type="checkbox" id="chk-free-cancel" ${state.filters.freeCancelOnly ? 'checked' : ''}>
            <span>${t(state.lang, 'freeCancelOnly')}</span>
          </label>
          <label class="checkbox-row">
            <input type="checkbox" id="chk-direct-only" ${state.filters.directOnly ? 'checked' : ''}>
            <span>${t(state.lang, 'directOnly')}</span>
          </label>
          <label class="checkbox-row">
            <input type="checkbox" id="chk-refundable-only" ${state.filters.refundableOnly ? 'checked' : ''}>
            <span>${t(state.lang, 'refundableOnly')}</span>
          </label>
          <label class="checkbox-row">
            <input type="checkbox" id="chk-fav-only" ${state.filters.favoritesOnly ? 'checked' : ''}>
            <span>${t(state.lang, 'favoritesOnly')} (${state.favorites.length})</span>
          </label>
          <label class="checkbox-row">
            <input type="checkbox" id="chk-show-sold" ${state.filters.showSoldOut ? 'checked' : ''}>
            <span>${t(state.lang, 'showSoldOut')}</span>
          </label>
        </div>
      </aside>

      <div id="store-results-region"></div>
    </div>
  `;

  const resultsRegion = root.querySelector('#store-results-region');
  renderStoreResultsInto(resultsRegion);

  // Wire slider per modern-web-guidance (sync --attr-min, --attr-max, --control-value)
  const slider = root.querySelector('#max-budget-slider');
  const readout = root.querySelector('#max-budget-readout');
  const syncSliderProps = () => {
    if (!slider) return;
    slider.style.setProperty('--attr-min', slider.min || 100);
    slider.style.setProperty('--attr-max', slider.max || 1200);
    slider.style.setProperty('--control-value', slider.value);
    const formatted = formatCurrency(Number(slider.value), state.currency, rates);
    slider.setAttribute('aria-valuetext', formatted);
    if (readout) readout.textContent = formatted;
  };
  syncSliderProps();

  slider?.addEventListener('input', () => {
    state.filters.maxBudgetUsd = Number(slider.value);
    syncSliderProps();
    renderStoreResultsInto(resultsRegion);
  });

  root.querySelector('#filter-keyword-input')?.addEventListener('input', (ev) => {
    state.filters.keyword = ev.currentTarget.value;
    renderStoreResultsInto(resultsRegion);
  });

  root.querySelectorAll('[data-dest-pick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.destPick;
      state.filters.destination = state.filters.destination === k ? 'all' : k;
      populateSearchOptions();
      renderMain();
    });
  });

  root.querySelector('#clear-dest-pill')?.addEventListener('click', () => {
    state.filters.destination = 'all';
    populateSearchOptions();
    renderMain();
  });

  root.querySelectorAll('[data-star-val]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filters.minStars = Number(btn.dataset.starVal);
      renderStoreView(root);
    });
  });

  root.querySelectorAll('[data-board-val]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filters.board = btn.dataset.boardVal;
      renderStoreView(root);
    });
  });

  root.querySelectorAll('[data-slot-val]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filters.timeSlot = btn.dataset.slotVal;
      renderStoreView(root);
    });
  });

  root.querySelector('#filter-airline-select')?.addEventListener('change', (ev) => {
    state.filters.airline = ev.currentTarget.value;
    renderStoreResultsInto(resultsRegion);
  });

  const bindCheck = (sel, prop) => {
    root.querySelector(sel)?.addEventListener('change', (ev) => {
      state.filters[prop] = ev.currentTarget.checked;
      renderStoreResultsInto(resultsRegion);
    });
  };
  bindCheck('#chk-free-cancel', 'freeCancelOnly');
  bindCheck('#chk-direct-only', 'directOnly');
  bindCheck('#chk-refundable-only', 'refundableOnly');
  bindCheck('#chk-fav-only', 'favoritesOnly');
  bindCheck('#chk-show-sold', 'showSoldOut');

  root.querySelector('#btn-reset-filters')?.addEventListener('click', () => {
    Object.assign(state.filters, {
      destination: 'all',
      origin: 'all',
      keyword: '',
      maxBudgetUsd: 1200,
      minStars: 0,
      board: 'all',
      freeCancelOnly: false,
      favoritesOnly: false,
      directOnly: false,
      refundableOnly: false,
      timeSlot: 'all',
      airline: 'all',
      showSoldOut: false,
      sortBy: 'featured',
    });
    populateSearchOptions();
    renderMain();
  });

  root.querySelector('#btn-smart-auto-bundle')?.addEventListener('click', () => {
    const dest = state.filters.destination !== 'all' ? state.filters.destination : 'dubai';
    const h = state.snapshot.hotels.find((x) => x.cityKey === dest && x.status !== 'sold_out') || state.snapshot.hotels.find((x) => x.status !== 'sold_out');
    const f = state.snapshot.flights.find((x) => x.destKey === (h?.cityKey || dest) && x.status !== 'sold_out') || state.snapshot.flights.find((x) => x.status !== 'sold_out');
    if (h && f) {
      state.bundle = {
        hotelId: h.id,
        hotelTierId: h.selectedTierId,
        flightId: f.id,
        flightTierId: f.selectedTierId,
      };
      renderFloatingDock();
      renderStoreResultsInto(resultsRegion);
      showToast(isAr ? 'تم تجهيز أفضل باكيدج طيران + فندق في أسفل الشاشة!' : 'Matched top Flight + Hotel pair below!', 'success');
    }
  });
}

function bindResultsEvents(container) {
  const isAr = state.lang === 'ar';

  container.querySelector('#sort-select')?.addEventListener('change', (ev) => {
    state.filters.sortBy = ev.currentTarget.value;
    renderStoreResultsInto(container);
  });

  container.querySelectorAll('[data-pick-tier]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [, itemId, tierId] = btn.dataset.pickTier.split(':');
      state.selectedTiers[itemId] = tierId;
      if (state.bundle.hotelId === itemId) state.bundle.hotelTierId = tierId;
      if (state.bundle.flightId === itemId) state.bundle.flightTierId = tierId;
      renderStoreResultsInto(container);
      renderFloatingDock();
    });
  });

  container.querySelectorAll('[data-fav-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.favId;
      if (state.favorites.includes(id)) {
        state.favorites = state.favorites.filter((x) => x !== id);
      } else {
        state.favorites = [...state.favorites, id];
      }
      saveFavorites(state.favorites);
      renderMain();
    });
  });

  container.querySelectorAll('[data-cmp-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.cmpId;
      if (state.compareIds.includes(id)) {
        state.compareIds = state.compareIds.filter((x) => x !== id);
      } else {
        if (state.compareIds.length >= 3) {
          showToast(isAr ? 'يمكن مقارنة 3 عروض كحد أقصى في نفس الوقت' : 'Compare up to 3 offers at a time', 'warning');
          return;
        }
        state.compareIds = [...state.compareIds, id];
      }
      renderStoreResultsInto(container);
      renderFloatingDock();
    });
  });

  container.querySelectorAll('[data-book-single]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [itemType, itemId, tierId] = btn.dataset.bookSingle.split(':');
      openCheckoutForItem({
        dialog: document.getElementById('checkout-dialog'),
        bodyEl: document.getElementById('checkout-dialog-body'),
        state,
        itemType,
        itemId,
        tierId: tierId || null,
        onSnapshot: applyIncomingSnapshot,
        onToast: showToast,
        onGoBookings: () => switchView('bookings'),
      });
    });
  });

  container.querySelectorAll('[data-pin-bundle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [itemType, itemId, tierId] = btn.dataset.pinBundle.split(':');
      if (itemType === 'hotel') {
        if (state.bundle.hotelId === itemId) {
          state.bundle.hotelId = null;
          state.bundle.hotelTierId = null;
        } else {
          state.bundle.hotelId = itemId;
          state.bundle.hotelTierId = tierId || null;
        }
      } else {
        if (state.bundle.flightId === itemId) {
          state.bundle.flightId = null;
          state.bundle.flightTierId = null;
        } else {
          state.bundle.flightId = itemId;
          state.bundle.flightTierId = tierId || null;
        }
      }
      renderStoreResultsInto(container);
      renderFloatingDock();
    });
  });

  container.querySelectorAll('[data-open-detail]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [itemType, itemId] = btn.dataset.openDetail.split(':');
      openDetailModal(itemType, itemId);
    });
  });
}

function openDetailModal(itemType, itemId) {
  const dialog = document.getElementById('detail-dialog');
  const body = document.getElementById('detail-dialog-body');
  const titleEl = document.getElementById('detail-dialog-title');
  if (!dialog || !body || !state.snapshot) return;

  const isAr = state.lang === 'ar';
  const rates = state.snapshot.rates;
  const list = itemType === 'hotel' ? state.snapshot.hotels : state.snapshot.flights;
  const item = list.find((x) => x.id === itemId);
  if (!item) return;

  titleEl.textContent = isAr ? item.nameAr || `${item.airlineAr} ${item.flightNumber}` : item.nameEn || `${item.airlineEn} ${item.flightNumber}`;
  const activeTier = getActiveTier(item);
  const visa = getVisaInfo(item.countryCode);

  if (itemType === 'hotel') {
    const scores = item.subScores || { location: 9.5, cleanliness: 9.4, service: 9.2, value: 8.9 };
    const subScoreBars = Object.entries(scores)
      .map(([k, val]) => {
        const labels = {
          location: isAr ? 'الموقع' : 'Location',
          cleanliness: isAr ? 'النظافة' : 'Cleanliness',
          service: isAr ? 'الضيافة والخدمة' : 'Service',
          value: isAr ? 'القيمة مقابل السعر' : 'Value',
        };
        return `
          <div class="subscore-box">
            <div style="display:flex; justify-content:space-between; font-size:0.78rem; font-weight:700;">
              <span>${labels[k] || k}</span>
              <span class="num" style="color:var(--brand-teal);">${val}</span>
            </div>
            <div class="subscore-bar-track"><div class="subscore-bar-fill" style="inline-size:${Math.min(100, val * 10)}%;"></div></div>
          </div>
        `;
      })
      .join('');

    const tiersHtml = (item.tiers || [])
      .map((tr) => {
        const isSold = tr.availableCount <= 0;
        return `
          <div class="tier-detail-card ${activeTier?.id === tr.id ? 'is-picked' : ''}">
            <div>
              <div style="font-weight:800; font-size:0.94rem;">${escapeHtml(isAr ? tr.nameAr : tr.nameEn)}</div>
              <div style="font-size:0.8rem; color:var(--ink-secondary); margin-block-start:0.15rem;">
                ${escapeHtml(isAr ? tr.boardAr : tr.boardEn)} • ${tr.sizeSqm} m² • ${tr.freeCancellation ? t(state.lang, 'freeCancelTag') : (isAr ? 'غير مسترد' : 'Non-refundable')} •
                <strong class="num" style="color:${tr.effectiveAvailable <= 2 ? 'var(--status-warning)' : 'var(--brand-teal)'};">
                  ${isSold ? t(state.lang, 'soldOutBadge') : `${t(state.lang, 'roomsLeft')} ${tr.effectiveAvailable}`}
                </strong>
              </div>
            </div>
            <div style="display:flex; align-items:center; gap:0.55rem;">
              <strong class="num" style="font-size:1.05rem;">${formatCurrency(tr.pricing.finalPriceUsd, state.currency, rates)}</strong>
              <button type="button" class="btn btn-primary btn-sm" ${isSold || tr.effectiveAvailable <= 0 ? 'disabled' : ''} data-modal-book="hotel:${item.id}:${tr.id}">
                ${t(state.lang, 'bookNow')}
              </button>
              <button type="button" class="btn btn-outline btn-sm" ${isSold || tr.effectiveAvailable <= 0 ? 'disabled' : ''} data-modal-pin="hotel:${item.id}:${tr.id}">
                ${t(state.lang, 'addToBundle')}
              </button>
            </div>
          </div>
        `;
      })
      .join('');

    body.innerHTML = `
      <div style="border-radius:var(--radius-md); overflow:hidden; aspect-ratio:21/9; background:var(--surface-navy-mid);">
        <img src="${escapeHtml(item.image)}" alt="${escapeHtml(isAr ? item.nameAr : item.nameEn)}" style="inline-size:100%; block-size:100%; object-fit:cover; display:block;">
      </div>
      <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:0.5rem;">
        <div>
          <div style="font-weight:800; color:var(--brand-teal); font-size:0.86rem;">${escapeHtml(isAr ? item.districtAr : item.districtEn)}</div>
          <div style="font-size:0.83rem; color:var(--ink-secondary);">${escapeHtml(isAr ? item.distanceAr : item.distanceEn)}</div>
        </div>
        <span class="rating-pill num">${item.rating} (${item.reviewsCount} ${isAr ? 'تقييم' : 'reviews'})</span>
      </div>

      <div class="subscore-grid">${subScoreBars}</div>

      <div class="amenities-row">
        ${(isAr ? item.amenitiesAr : item.amenitiesEn).map((a) => `<span class="amenity-chip">${escapeHtml(a)}</span>`).join('')}
      </div>

      <div style="padding:0.65rem 0.85rem; border-radius:var(--radius-sm); background:var(--brand-gold-tint); border:1px solid var(--border-gold); font-size:0.82rem;">
        <strong>${iconSvg('passport', 14)} ${t(state.lang, 'visaBannerPrefix')} ${escapeHtml(state.filters.nationality)}:</strong>
        ${escapeHtml(isAr ? visa.labelAr : visa.labelEn)} — ${escapeHtml(isAr ? visa.noteAr : visa.noteEn)}
      </div>

      <h3 style="font-size:0.98rem;">${isAr ? 'الغرف المتاحة لحظياً من المزود:' : 'Live Room Tiers & Meal Plans:'}</h3>
      <div class="tiers-detail-list">${tiersHtml}</div>
    `;
  } else {
    // Flight Detail Modal with +/- 2 Days Flexible Fare Strip + Fare Tiers
    const baseDate = new Date(`${state.filters.checkInDate || DEFAULT_IN}T00:00:00Z`);
    const deltas = item.flexDeltas || [-15, -6, 0, +10, +18];
    const minDelta = Math.min(...deltas);
    const flexDaysHtml = deltas
      .map((d, idx) => {
        const dt = new Date(baseDate.getTime() + (idx - 2) * 86400000).toISOString().slice(0, 10);
        const isCur = idx === 2;
        const isBest = d === minDelta;
        const estPrice = Math.max(45, (activeTier?.pricing.finalPriceUsd || item.pricing.finalPriceUsd) + d);
        return `
          <button type="button" class="flex-day-pill ${isCur ? 'is-current' : isBest ? 'is-cheapest' : ''}" data-pick-flex-date="${dt}">
            <div class="mono" style="font-size:0.7rem;">${dt.slice(5)}</div>
            <strong class="num">${formatCurrency(estPrice, state.currency, rates)}</strong>
          </button>
        `;
      })
      .join('');

    const tiersHtml = (item.tiers || [])
      .map((tr) => {
        const isSold = tr.availableCount <= 0;
        return `
          <div class="tier-detail-card ${activeTier?.id === tr.id ? 'is-picked' : ''}">
            <div>
              <div style="font-weight:800; font-size:0.94rem;">${escapeHtml(isAr ? tr.cabinAr : tr.cabinEn)}</div>
              <div style="font-size:0.8rem; color:var(--ink-secondary);">
                ${escapeHtml(isAr ? tr.baggageAr : tr.baggageEn)} • ${escapeHtml(isAr ? tr.seatSelectAr : tr.seatSelectEn)} •
                <strong class="num" style="color:${tr.effectiveAvailable <= 2 ? 'var(--status-warning)' : 'var(--brand-teal)'};">
                  ${isSold ? t(state.lang, 'soldOutBadge') : `${t(state.lang, 'seatsLeft')} ${tr.effectiveAvailable}`}
                </strong>
              </div>
            </div>
            <div style="display:flex; align-items:center; gap:0.55rem;">
              <strong class="num" style="font-size:1.05rem;">${formatCurrency(tr.pricing.finalPriceUsd, state.currency, rates)}</strong>
              <button type="button" class="btn btn-primary btn-sm" ${isSold || tr.effectiveAvailable <= 0 ? 'disabled' : ''} data-modal-book="flight:${item.id}:${tr.id}">
                ${t(state.lang, 'bookNow')}
              </button>
              <button type="button" class="btn btn-outline btn-sm" ${isSold || tr.effectiveAvailable <= 0 ? 'disabled' : ''} data-modal-pin="flight:${item.id}:${tr.id}">
                ${t(state.lang, 'addToBundle')}
              </button>
            </div>
          </div>
        `;
      })
      .join('');

    body.innerHTML = `
      <div class="summary-box">
        <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:0.5rem;">
          <strong>${escapeHtml(isAr ? item.airlineAr : item.airlineEn)} — ${escapeHtml(item.flightNumber)} (${escapeHtml(item.aircraft || '')})</strong>
          <span class="mono">${escapeHtml(item.originCode)} → ${escapeHtml(item.destCode)} • ${escapeHtml(isAr ? item.durationAr : item.durationEn)}</span>
        </div>
        <div style="font-size:0.82rem; color:var(--ink-secondary);">
          ${item.hasWifi ? (isAr ? '✓ واي فاي على الطائرة' : '✓ In-flight Wi-Fi') : ''}
          ${item.hasMeal ? (isAr ? ' • ✓ وجبة رئيسية مجانية' : ' • ✓ Complimentary Meal') : ''}
        </div>
      </div>

      <div>
        <h3 style="font-size:0.9rem; margin-block-end:0.45rem;">${isAr ? 'تقويم الأسعار المرن (+/- يومين):' : 'Flexible Fare Calendar (+/- 2 Days):'}</h3>
        <div class="flex-dates-strip">${flexDaysHtml}</div>
      </div>

      <h3 style="font-size:0.98rem;">${isAr ? 'درجات وفئات التذكرة المتاحة:' : 'Available Fare Classes:'}</h3>
      <div class="tiers-detail-list">${tiersHtml}</div>
    `;
  }

  dialog.showModal();

  body.querySelectorAll('[data-modal-book]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [tp, iid, tid] = btn.dataset.modalBook.split(':');
      closeDialogSmoothly(dialog);
      openCheckoutForItem({
        dialog: document.getElementById('checkout-dialog'),
        bodyEl: document.getElementById('checkout-dialog-body'),
        state,
        itemType: tp,
        itemId: iid,
        tierId: tid,
        onSnapshot: applyIncomingSnapshot,
        onToast: showToast,
        onGoBookings: () => switchView('bookings'),
      });
    });
  });

  body.querySelectorAll('[data-modal-pin]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [tp, iid, tid] = btn.dataset.modalPin.split(':');
      if (tp === 'hotel') {
        state.bundle.hotelId = iid;
        state.bundle.hotelTierId = tid;
      } else {
        state.bundle.flightId = iid;
        state.bundle.flightTierId = tid;
      }
      state.selectedTiers[iid] = tid;
      closeDialogSmoothly(dialog);
      renderFloatingDock();
      renderMain();
      showToast(isAr ? 'تمت إضافة الفئة المختارة إلى باكيدج الرحلة' : 'Selected tier added to Trip Bundle', 'success');
    });
  });

  body.querySelectorAll('[data-pick-flex-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextIn = btn.dataset.pickFlexDate;
      state.filters.checkInDate = nextIn;
      const inInput = document.getElementById('search-checkin');
      if (inInput) inInput.value = nextIn;
      const nextOut = new Date(new Date(`${nextIn}T00:00:00Z`).getTime() + state.filters.nights * 86400000).toISOString().slice(0, 10);
      state.filters.checkOutDate = nextOut;
      const outInput = document.getElementById('search-checkout');
      if (outInput) outInput.value = nextOut;
      openDetailModal(itemType, itemId);
    });
  });
}

function openCompareModal() {
  const dialog = document.getElementById('detail-dialog');
  const body = document.getElementById('detail-dialog-body');
  const titleEl = document.getElementById('detail-dialog-title');
  if (!dialog || !body || !state.snapshot) return;

  const isAr = state.lang === 'ar';
  const rates = state.snapshot.rates;
  const all = [...state.snapshot.hotels, ...state.snapshot.flights];
  const picked = state.compareIds.map((id) => all.find((x) => x.id === id)).filter(Boolean);
  if (picked.length === 0) return;

  titleEl.textContent = t(state.lang, 'dialogCompareTitle');

  const cols = picked
    .map(
      (x) => `
      <th>
        <div>${escapeHtml(isAr ? x.nameAr || `${x.airlineAr} ${x.flightNumber}` : x.nameEn || `${x.airlineEn} ${x.flightNumber}`)}</div>
        <div class="mono" style="font-size:0.7rem; color:var(--ink-muted);">${escapeHtml(x.provider)}</div>
      </th>
    `,
    )
    .join('');

  const priceRow = picked
    .map((x) => `<td class="num" style="font-weight:800; color:var(--brand-teal);">${formatCurrency((getActiveTier(x)?.pricing || x.pricing).finalPriceUsd, state.currency, rates)}</td>`)
    .join('');

  const stockRow = picked
    .map((x) => `<td class="num">${x.effectiveAvailable}</td>`)
    .join('');

  const metaRow = picked
    .map((x) => {
      if (x.itemType === 'hotel') {
        const tier = getActiveTier(x);
        return `<td>${'★'.repeat(x.stars)} (${x.rating})<br>${escapeHtml(isAr ? tier?.boardAr || x.boardAr : tier?.boardEn || x.boardEn)}</td>`;
      }
      return `<td>${escapeHtml(x.originCode)} → ${escapeHtml(x.destCode)}<br>${x.stopsCount === 0 ? t(state.lang, 'directFlight') : t(state.lang, 'oneStopFlight')}</td>`;
    })
    .join('');

  const visaRow = picked
    .map((x) => {
      const v = getVisaInfo(x.countryCode);
      return `<td>${escapeHtml(isAr ? v.labelAr : v.labelEn)}</td>`;
    })
    .join('');

  const ctaRow = picked
    .map(
      (x) => `
      <td>
        <button type="button" class="btn btn-primary btn-sm" data-cmp-book="${x.itemType}:${x.id}">${t(state.lang, 'bookNow')}</button>
        <button type="button" class="btn btn-outline btn-sm" data-cmp-remove="${x.id}">✕</button>
      </td>
    `,
    )
    .join('');

  body.innerHTML = `
    <div class="compare-table-wrap">
      <table class="compare-table">
        <thead>
          <tr><th>${isAr ? 'العنصر' : 'Attribute'}</th>${cols}</tr>
        </thead>
        <tbody>
          <tr><td><strong>${isAr ? 'السعر المباشر' : 'Live Price'}</strong></td>${priceRow}</tr>
          <tr><td><strong>${isAr ? 'المواصفات والوجبات' : 'Specs / Meals'}</strong></td>${metaRow}</tr>
          <tr><td><strong>${isAr ? 'التوافر اللحظي' : 'Live Stock'}</strong></td>${stockRow}</tr>
          <tr><td><strong>${isAr ? 'وضع التأشيرة' : 'Visa Status'}</strong></td>${visaRow}</tr>
          <tr><td><strong>${isAr ? 'الإجراء' : 'Action'}</strong></td>${ctaRow}</tr>
        </tbody>
      </table>
    </div>
  `;

  dialog.showModal();

  body.querySelectorAll('[data-cmp-book]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [tp, iid] = btn.dataset.cmpBook.split(':');
      closeDialogSmoothly(dialog);
      openCheckoutForItem({
        dialog: document.getElementById('checkout-dialog'),
        bodyEl: document.getElementById('checkout-dialog-body'),
        state,
        itemType: tp,
        itemId: iid,
        onSnapshot: applyIncomingSnapshot,
        onToast: showToast,
        onGoBookings: () => switchView('bookings'),
      });
    });
  });

  body.querySelectorAll('[data-cmp-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.compareIds = state.compareIds.filter((id) => id !== btn.dataset.cmpRemove);
      renderFloatingDock();
      if (state.compareIds.length === 0) closeDialogSmoothly(dialog);
      else openCompareModal();
      renderMain();
    });
  });
}

function renderFloatingDock() {
  const dockRoot = document.getElementById('floating-dock-root');
  if (!dockRoot || !state.snapshot) return;

  const isAr = state.lang === 'ar';
  const rates = state.snapshot.rates;
  const b = getBundleTotals();
  const hasCompare = state.compareIds.length > 0;

  if (state.activeView !== 'store' || state.expMode === 'journey' || (!b && !hasCompare)) {
    dockRoot.hidden = true;
    dockRoot.innerHTML = '';
    document.body.classList.remove('has-floating-dock');
    return;
  }

  dockRoot.hidden = false;
  document.body.classList.add('has-floating-dock');

  const hotelChip = b?.hotel
    ? `
      <span class="dock-leg-chip ${b.hotelSoldOut ? 'is-alert' : ''}">
        <span>🏨 ${escapeHtml(isAr ? b.hotel.nameAr : b.hotel.nameEn)}</span>
        <button type="button" class="dock-leg-clear" data-clear-leg="hotel" aria-label="Remove hotel">✕</button>
      </span>
    `
    : b?.flight
      ? `
      <button type="button" class="btn btn-outline btn-sm" style="border-color:var(--border-gold); color:var(--brand-gold-bright); background:transparent;" id="dock-auto-hotel">
        + ${t(state.lang, 'dockAutoPairHotel')}
      </button>
    `
      : '';

  const flightChip = b?.flight
    ? `
      <span class="dock-leg-chip ${b.flightSoldOut ? 'is-alert' : ''}">
        <span>✈ ${escapeHtml(b.flight.flightNumber)} (${escapeHtml(b.flight.originCode)}→${escapeHtml(b.flight.destCode)})</span>
        <button type="button" class="dock-leg-clear" data-clear-leg="flight" aria-label="Remove flight">✕</button>
      </span>
    `
    : b?.hotel
      ? `
      <button type="button" class="btn btn-outline btn-sm" style="border-color:var(--border-gold); color:var(--brand-gold-bright); background:transparent;" id="dock-auto-flight">
        + ${t(state.lang, 'dockAutoPairFlight')}
      </button>
    `
      : '';

  const bothReady = Boolean(b?.hotel && b?.flight && !b.hotelSoldOut && !b.flightSoldOut);
  const compareOnly = !b && hasCompare;

  dockRoot.innerHTML = `
    <div class="floating-dock-card ${compareOnly ? 'is-compare-only' : ''}">
      <div class="dock-legs">
        ${b ? `<strong style="font-size:0.84rem; color:var(--brand-gold-bright);">✨ ${t(state.lang, 'dockBundleTitle')}:</strong>` : ''}
        ${
          compareOnly
            ? `<span style="font-size:0.82rem; font-weight:700; color:var(--brand-gold-bright);">${iconSvg('compare', 14)} ${isAr ? `تم تحديد ${state.compareIds.length} عروض للمقارنة` : `${state.compareIds.length} selected to compare`}</span>`
            : ''
        }
        ${hotelChip}
        ${flightChip}
        ${b?.hotelSoldOut || b?.flightSoldOut ? `<span style="font-size:0.78rem; color:#FDA4AF;">⚠ ${t(state.lang, 'dockLegSoldWarning')}</span>` : ''}
      </div>

      <div class="dock-actions">
        ${
          hasCompare
            ? `<button type="button" class="btn btn-secondary btn-sm" id="dock-open-compare">${t(state.lang, 'dockCompareBtn')} (${state.compareIds.length})</button>`
            : ''
        }
        ${
          compareOnly
            ? `<button type="button" class="dock-leg-clear" id="dock-clear-compare" aria-label="Clear compare">✕</button>`
            : ''
        }
        ${
          b?.hotel && b?.flight
            ? `
          <div class="dock-total-box">
            <span class="num" style="font-size:0.72rem; color:#6EE7B7;">${t(state.lang, 'dockSavedText')} ${formatCurrency(b.discountUsd, state.currency, rates)} (-${b.pct}%)</span>
            <strong class="num" style="font-size:1.05rem;">${formatCurrency(b.totalUsd, state.currency, rates)}</strong>
          </div>
          <button type="button" class="btn btn-gold btn-sm" ${bothReady ? '' : 'disabled'} id="dock-book-bundle">
            ${t(state.lang, 'dockBookTogether')}
          </button>
        `
            : ''
        }
        ${b ? `<button type="button" class="btn btn-outline btn-sm" style="color:#E2E8F0; background:transparent; border-color:rgba(255,255,255,0.22);" id="dock-clear-all">${t(state.lang, 'dockClearBundle')}</button>` : ''}
      </div>
    </div>
  `;

  dockRoot.querySelectorAll('[data-clear-leg]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.clearLeg === 'hotel') {
        state.bundle.hotelId = null;
        state.bundle.hotelTierId = null;
      } else {
        state.bundle.flightId = null;
        state.bundle.flightTierId = null;
      }
      renderFloatingDock();
      renderMain();
    });
  });

  dockRoot.querySelector('#dock-clear-all')?.addEventListener('click', () => {
    state.bundle = { hotelId: null, hotelTierId: null, flightId: null, flightTierId: null };
    renderFloatingDock();
    renderMain();
  });

  dockRoot.querySelector('#dock-clear-compare')?.addEventListener('click', () => {
    state.compareIds = [];
    renderFloatingDock();
    renderMain();
  });

  dockRoot.querySelector('#dock-auto-flight')?.addEventListener('click', () => {
    const cityKey = b.hotel.cityKey;
    const match = state.snapshot.flights.find((f) => f.destKey === cityKey && f.status !== 'sold_out') || state.snapshot.flights.find((f) => f.status !== 'sold_out');
    if (match) {
      state.bundle.flightId = match.id;
      state.bundle.flightTierId = match.selectedTierId;
      renderFloatingDock();
      renderMain();
    }
  });

  dockRoot.querySelector('#dock-auto-hotel')?.addEventListener('click', () => {
    const destKey = b.flight.destKey;
    const match = state.snapshot.hotels.find((h) => h.cityKey === destKey && h.status !== 'sold_out') || state.snapshot.hotels.find((h) => h.status !== 'sold_out');
    if (match) {
      state.bundle.hotelId = match.id;
      state.bundle.hotelTierId = match.selectedTierId;
      renderFloatingDock();
      renderMain();
    }
  });

  dockRoot.querySelector('#dock-open-compare')?.addEventListener('click', openCompareModal);

  dockRoot.querySelector('#dock-book-bundle')?.addEventListener('click', () => {
    openCheckoutForBundle({
      dialog: document.getElementById('checkout-dialog'),
      bodyEl: document.getElementById('checkout-dialog-body'),
      state,
      onSnapshot: applyIncomingSnapshot,
      onToast: showToast,
      onGoBookings: () => switchView('bookings'),
      onClearBundle: () => {
        state.bundle = { hotelId: null, hotelTierId: null, flightId: null, flightTierId: null };
        renderFloatingDock();
      },
    });
  });
}

function renderBookingsView(root) {
  const isAr = state.lang === 'ar';
  const rates = state.snapshot.rates;
  const bookings = state.snapshot.bookings || [];

  const cardsHtml =
    bookings.length === 0
      ? `<div class="panel-card" style="text-align:center; padding:2.2rem; color:var(--ink-muted);">${t(state.lang, 'noBookingsYet')}</div>`
      : bookings
          .map((b) => {
            const isCancelled = b.status === 'cancelled';
            const isBundle = b.bookingType === 'bundle';
            const title = isAr ? b.titleAr : b.titleEn;

            return `
              <article class="voucher-card ${isBundle ? 'is-bundle' : ''} ${isCancelled ? 'is-cancelled' : ''}">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.6rem;">
                  <div>
                    <div style="display:flex; align-items:center; gap:0.45rem; flex-wrap:wrap; margin-block-end:0.35rem;">
                      <span class="mono" style="font-weight:800; color:var(--brand-gold); background:var(--surface-navy-deep); padding:0.2rem 0.6rem; border-radius:var(--radius-sm); font-size:0.84rem;">${escapeHtml(b.reference)}</span>
                      <span class="amenity-chip ${isCancelled ? '' : 'is-green'}">${isCancelled ? t(state.lang, 'statusCancelled') : t(state.lang, 'statusConfirmed')}</span>
                      ${isBundle ? `<span class="amenity-chip" style="background:var(--brand-gold-tint); color:#92400E;">${t(state.lang, 'bundleVoucherBadge')}</span>` : ''}
                      ${b.includeVisaAssist ? `<span class="amenity-chip is-green">${t(state.lang, 'visaAssistIncludedBadge')}</span>` : ''}
                      ${
                        b.tripMeta?.companion
                          ? `<span class="amenity-chip">✨ ${escapeHtml(
                              t(
                                state.lang,
                                b.tripMeta.companion === 'family'
                                  ? 'companionFamily'
                                  : b.tripMeta.companion === 'business'
                                    ? 'companionBusiness'
                                    : b.tripMeta.companion === 'solo'
                                      ? 'companionSolo'
                                      : 'companionCouple',
                              ),
                            )}</span>`
                          : ''
                      }
                      ${
                        b.tripMeta?.seatPref
                          ? `<span class="amenity-chip">💺 ${escapeHtml(
                              t(
                                state.lang,
                                b.tripMeta.seatPref === 'aisle'
                                  ? 'seatAisle'
                                  : b.tripMeta.seatPref === 'family'
                                    ? 'seatFamily'
                                    : 'seatWindow',
                              ),
                            )}</span>`
                          : ''
                      }
                    </div>
                    <h3 style="font-size:1.06rem;">${escapeHtml(title)}</h3>
                    <div style="font-size:0.82rem; color:var(--ink-muted); margin-block-start:0.25rem;">
                      ${escapeHtml(b.guestName)} • <span class="mono">${escapeHtml(b.guestPhone)}</span> • ${escapeHtml(b.checkInDate || '')}
                    </div>
                  </div>
                  <div style="text-align:end;">
                    <div style="font-size:0.74rem; color:var(--ink-muted);">${isAr ? 'الإجمالي المؤكد' : 'Confirmed Total'}</div>
                    <strong class="num" style="font-size:1.22rem; color:var(--brand-teal);">${formatCurrency(b.pricingSummary.totalUsd, state.currency, rates)}</strong>
                  </div>
                </div>

                ${
                  isBundle && b.hotelLeg && b.flightLeg
                    ? `
                  <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:0.6rem; font-size:0.81rem; background:var(--surface-soft); padding:0.72rem; border-radius:var(--radius-sm);">
                    <div><strong>🏨 ${escapeHtml(isAr ? b.hotelLeg.nameAr : b.hotelLeg.nameEn)}</strong><div style="color:var(--ink-muted);">${escapeHtml(isAr ? b.hotelLeg.tierLabelAr : b.hotelLeg.tierLabelEn)} (${b.hotelLeg.rooms} × ${b.hotelLeg.nights}N)</div></div>
                    <div><strong>✈ ${escapeHtml(isAr ? b.flightLeg.airlineAr : b.flightLeg.airlineEn)} (${escapeHtml(b.flightLeg.flightNumber)})</strong><div style="color:var(--ink-muted);">${escapeHtml(b.flightLeg.originCode)}→${escapeHtml(b.flightLeg.destCode)} • ${escapeHtml(isAr ? b.flightLeg.tierLabelAr : b.flightLeg.tierLabelEn)}</div></div>
                  </div>
                `
                    : ''
                }

                <div style="display:flex; gap:0.55rem; flex-wrap:wrap;">
                  <button type="button" class="btn btn-secondary btn-sm" data-copy-ref="${escapeHtml(b.reference)}">${t(state.lang, 'copyRefBtn')}</button>
                  <button type="button" class="btn btn-outline btn-sm" onclick="window.print()">${t(state.lang, 'printVoucherBtn')}</button>
                  ${
                    !isCancelled
                      ? `<button type="button" class="btn btn-danger btn-sm" data-cancel-bkg="${escapeHtml(b.id)}">${t(state.lang, 'cancelBookingBtn')}</button>`
                      : ''
                  }
                </div>
              </article>
            `;
          })
          .join('');

  root.innerHTML = `
    <div style="display:grid; gap:1.25rem;">
      <div class="section-header-row">
        <h2 class="section-heading">
          <span class="section-icon">${iconSvg('ticket', 20)}</span>
          <span>${t(state.lang, 'bookingsTitle')}</span>
        </h2>

        <form id="booking-lookup-form" style="display:flex; gap:0.5rem; flex-wrap:wrap;">
          <input class="input-control mono" id="lookup-ref-input" type="text" placeholder="${escapeHtml(t(state.lang, 'bookingsLookupPlaceholder'))}" style="inline-size:240px; block-size:2.4rem;">
          <button type="submit" class="btn btn-primary btn-sm">${t(state.lang, 'bookingsSearchBtn')}</button>
        </form>
      </div>

      ${
        state.verifiedBooking
          ? `<div class="panel-card" style="border-color:var(--brand-teal); background:var(--brand-teal-light);">
              <strong>✓ ${isAr ? 'تم التحقق من السيرفر:' : 'Verified on Server:'}</strong>
              <span class="mono">${escapeHtml(state.verifiedBooking.reference)}</span> — ${escapeHtml(isAr ? state.verifiedBooking.titleAr : state.verifiedBooking.titleEn)} (${escapeHtml(state.verifiedBooking.status)})
            </div>`
          : ''
      }

      <div class="bookings-list">${cardsHtml}</div>
    </div>
  `;

  root.querySelector('#booking-lookup-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const ref = root.querySelector('#lookup-ref-input')?.value?.trim();
    if (!ref) return;
    try {
      const res = await lookupBooking(ref);
      state.verifiedBooking = res.booking;
      renderBookingsView(root);
    } catch (err) {
      state.verifiedBooking = null;
      showToast(isAr ? err.data?.messageAr || err.message : err.data?.messageEn || err.message, 'warning');
    }
  });

  root.querySelectorAll('[data-copy-ref]').forEach((btn) => {
    btn.addEventListener('click', () => {
      navigator.clipboard?.writeText(btn.dataset.copyRef).catch(() => {});
      showToast(isAr ? 'تم نسخ رقم الحجز المرجعي' : 'Booking reference copied', 'success');
    });
  });

  root.querySelectorAll('[data-cancel-bkg]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const res = await cancelBooking(btn.dataset.cancelBkg);
        applyIncomingSnapshot(res.snapshot);
        showToast(isAr ? 'تم الإلغاء وإرجاع الوحدات للتوافر اللحظي' : 'Cancelled & stock restored live', 'info');
      } catch (err) {
        showToast(err.message, 'danger');
      }
    });
  });
}

function renderMain() {
  const root = document.getElementById('main-workspace');
  if (!root || !state.snapshot) return;

  if (state.activeView === 'store') {
    const activeEl = document.activeElement;
    if (state.expMode === 'journey') {
      if (activeEl && activeEl.closest('#journey-passport-form') && root.querySelector('[data-bp-container]')) {
        refreshJourneyLivePass(root, state);
      } else {
        renderJourneyStudio(root, state, {
          onSnapshot: applyIncomingSnapshot,
          onToast: showToast,
          onGoBookings: () => switchView('bookings'),
          onInspectHotel: openDetailModal,
        });
      }
      return;
    }

    if (
      activeEl &&
      (activeEl.id === 'filter-keyword-input' || activeEl.id === 'max-budget-slider') &&
      root.querySelector('#store-results-region')
    ) {
      renderStoreResultsInto(root.querySelector('#store-results-region'));
    } else {
      renderStoreView(root);
    }
  } else if (state.activeView === 'bookings') {
    renderBookingsView(root);
  } else if (state.activeView === 'admin') {
    renderAdminView(root, state, { onSnapshot: applyIncomingSnapshot, onToast: showToast });
  }
}

function applyIncomingSnapshot(newSnap) {
  if (!newSnap) return;
  detectPriceTransitions(newSnap);
  state.snapshot = newSnap;
  applyLocaleAndChrome();
  populateSearchOptions();
  renderMain();
  renderFloatingDock();
}

function switchView(nextView) {
  state.activeView = nextView;
  applyLocaleAndChrome();
  renderMain();
  renderFloatingDock();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function wireStaticControls() {
  const inEl = document.getElementById('search-checkin');
  const outEl = document.getElementById('search-checkout');
  if (inEl) inEl.value = state.filters.checkInDate;
  if (outEl) outEl.value = state.filters.checkOutDate;

  const syncDates = () => {
    if (!inEl || !outEl) return;
    state.filters.checkInDate = inEl.value || DEFAULT_IN;
    state.filters.checkOutDate = outEl.value || DEFAULT_OUT;
    state.filters.nights = diffDays(state.filters.checkInDate, state.filters.checkOutDate);
    applyLocaleAndChrome();
  };
  inEl?.addEventListener('change', syncDates);
  outEl?.addEventListener('change', syncDates);

  document.getElementById('search-nationality')?.addEventListener('change', (ev) => {
    state.filters.nationality = ev.currentTarget.value;
    renderMain();
  });

  document.getElementById('search-destination')?.addEventListener('change', (ev) => {
    state.filters.destination = ev.currentTarget.value;
    renderMain();
  });

  document.getElementById('search-origin')?.addEventListener('change', (ev) => {
    state.filters.origin = ev.currentTarget.value;
    renderMain();
  });

  document.querySelectorAll('.step-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.step;
      const delta = Number(btn.dataset.delta);
      const min = key === 'children' ? 0 : 1;
      const max = key === 'rooms' ? 4 : 6;
      state.filters[key] = Math.min(max, Math.max(min, (state.filters[key] || 0) + delta));
      const valEl = document.getElementById(`step-val-${key}`);
      if (valEl) valEl.textContent = String(state.filters[key]);
      applyLocaleAndChrome();
    });
  });

  document.getElementById('hero-search-form')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    renderMain();
    document.getElementById('main-workspace')?.scrollIntoView({ behavior: 'smooth' });
  });

  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  document.getElementById('brand-home-link')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    switchView('store');
  });

  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filters.mode = btn.dataset.searchMode;
      applyLocaleAndChrome();
      renderMain();
    });
  });

  document.querySelectorAll('[data-exp-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextExp = btn.dataset.expMode;
      if (nextExp === state.expMode) return;
      state.expMode = nextExp;
      if (state.activeView !== 'store') state.activeView = 'store';
      applyLocaleAndChrome();
      renderMain();
      renderFloatingDock();
    });
  });

  document.getElementById('currency-select')?.addEventListener('change', (ev) => {
    state.currency = ev.currentTarget.value;
    renderMain();
    renderFloatingDock();
  });

  document.getElementById('lang-toggle-btn')?.addEventListener('click', () => {
    state.lang = state.lang === 'ar' ? 'en' : 'ar';
    applyLocaleAndChrome();
    populateSearchOptions();
    renderMain();
    renderFloatingDock();
  });

  // Ensure dialog close & popover controls work even offline without CDN polyfill
  document.querySelectorAll('.dialog-close[command="request-close"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('commandfor');
      const dlg = targetId ? document.getElementById(targetId) : btn.closest('dialog');
      if (dlg?.open) dlg.close();
    });
  });

  if (!('commandForElement' in HTMLButtonElement.prototype)) {
    const popEl = document.getElementById('guests-popover');
    document.getElementById('guests-popover-btn')?.addEventListener('click', () => {
      popEl?.togglePopover?.();
    });
    document.getElementById('guests-done-btn')?.addEventListener('click', () => {
      popEl?.hidePopover?.();
    });
  }

  initCheckoutDialogLifecycle(document.getElementById('checkout-dialog'), {
    onSnapshot: applyIncomingSnapshot,
  });
}

async function boot() {
  wireStaticControls();
  applyLocaleAndChrome();

  try {
    const snap = await getBootstrap();
    applyIncomingSnapshot(snap);
  } catch (err) {
    showToast(err.message, 'danger');
  }

  connectLiveStream({
    onConnectionChange: (ok) => {
      state.connected = ok;
      applyLocaleAndChrome();
    },
    onSnapshot: (snap) => {
      applyIncomingSnapshot(snap);
    },
  });
}

boot();

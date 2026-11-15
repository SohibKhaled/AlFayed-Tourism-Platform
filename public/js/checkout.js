import { confirmBooking, confirmBundleBooking, lockBundle, lockInventory, releaseLock } from './api.js';
import { formatCurrency, t } from './i18n.js';

let activeLockState = null;
let countdownTimerId = null;

function clearCountdown() {
  if (countdownTimerId) {
    clearInterval(countdownTimerId);
    countdownTimerId = null;
  }
}

export function closeDialogSmoothly(dialog) {
  if (!dialog || !dialog.open) return;
  dialog.close();
}

function getSelectedGuestCounts(filters) {
  const adults = Number(filters.adults) || 2;
  const children = Number(filters.children) || 0;
  const rooms = Number(filters.rooms) || 1;
  return { adults, children, rooms, totalPax: adults + children };
}

function getVisaRule(snapshot, nationality, countryCode) {
  const table = snapshot?.visaRules?.[nationality] || snapshot?.visaRules?.EG || {};
  return table[countryCode] || {
    status: 'embassy',
    labelAr: 'تأشيرة / مراجعة مستندات عبر الفايد',
    labelEn: 'Visa check via Al-Fayed Desk',
    noteAr: 'إصدار حجوزات فندق وطيران صالحة لتقديم التأشيرة',
    noteEn: 'Includes confirmed vouchers ready for embassy visa submission',
    assistFeeUsd: 55,
  };
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderConfirmedReceipt(bodyEl, booking, state, { onClose, onGoBookings }) {
  clearCountdown();
  activeLockState = null;

  const { lang, currency, snapshot } = state;
  const isAr = lang === 'ar';
  const rates = snapshot.rates;
  const title = isAr ? booking.titleAr : booking.titleEn;

  bodyEl.innerHTML = `
    <div style="text-align:center; display:grid; gap:0.65rem;">
      <div style="inline-size:3.2rem; block-size:3.2rem; margin-inline:auto; border-radius:50%; background:var(--status-success-bg); color:var(--status-success); display:grid; place-items:center; font-size:1.5rem; font-weight:800;">✓</div>
      <h3 style="font-size:1.18rem;">${isAr ? 'تم تأكيد الحجز لحظياً بدون حساب!' : 'Booking Confirmed Instantly — Zero Login!'}</h3>
      <div class="mono" style="font-size:1.15rem; font-weight:800; padding:0.5rem 1rem; border-radius:var(--radius-sm); background:var(--surface-navy-deep); color:var(--brand-gold-bright); display:inline-block; margin-inline:auto;">
        ${escapeHtml(booking.reference)}
      </div>
      <p style="font-size:0.86rem; color:var(--ink-secondary); margin:0;">${escapeHtml(title)}</p>
      ${
        booking.bookingType === 'bundle'
          ? `<span class="amenity-chip is-green" style="margin-inline:auto;">${t(lang, 'bundleVoucherBadge')}</span>`
          : ''
      }
      ${
        booking.includeVisaAssist
          ? `<span class="amenity-chip" style="background:var(--brand-gold-tint); color:#92400E; margin-inline:auto;">${t(lang, 'visaAssistIncludedBadge')}</span>`
          : ''
      }
    </div>

    <div class="summary-box">
      <div class="summary-row">
        <span>${isAr ? 'المسافر' : 'Traveler'}</span>
        <strong>${escapeHtml(booking.guestName)}</strong>
      </div>
      <div class="summary-row">
        <span>${isAr ? 'الهاتف' : 'Phone'}</span>
        <span class="mono">${escapeHtml(booking.guestPhone)}</span>
      </div>
      <div class="summary-row">
        <span>${isAr ? 'تاريخ الوصول' : 'Check-in'}</span>
        <span class="mono">${escapeHtml(booking.checkInDate)}</span>
      </div>
      <div class="summary-row summary-total">
        <span>${isAr ? 'الإجمالي المؤكد' : 'Confirmed Total'}</span>
        <strong class="num" style="color:var(--brand-teal);">${formatCurrency(booking.pricingSummary.totalUsd, currency, rates)}</strong>
      </div>
    </div>

    <div style="display:flex; gap:0.6rem; flex-wrap:wrap;">
      <button type="button" class="btn btn-primary" style="flex:1;" id="rcpt-view-bookings">${t(lang, 'navBookings')}</button>
      <button type="button" class="btn btn-secondary" id="rcpt-copy-ref">${t(lang, 'copyRefBtn')}</button>
      <button type="button" class="btn btn-outline" id="rcpt-close-btn">${isAr ? 'إغلاق' : 'Close'}</button>
    </div>
  `;

  bodyEl.querySelector('#rcpt-copy-ref')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(booking.reference).catch(() => {});
  });
  bodyEl.querySelector('#rcpt-view-bookings')?.addEventListener('click', () => {
    onClose();
    onGoBookings();
  });
  bodyEl.querySelector('#rcpt-close-btn')?.addEventListener('click', () => onClose());
}

function attachLockCountdown(badgeEl, dialogEl, state, onExpired) {
  clearCountdown();
  const update = () => {
    if (!activeLockState || !dialogEl.open) {
      clearCountdown();
      return;
    }
    const remMs = Math.max(0, activeLockState.expiresAt - Date.now());
    const sec = Math.floor(remMs / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    if (badgeEl) {
      badgeEl.textContent = state.lang === 'ar' ? `السعر مثبّت لمدة ${mm}:${ss}` : `Rate held ${mm}:${ss}`;
    }
    if (remMs <= 0) {
      clearCountdown();
      onExpired();
    }
  };
  update();
  countdownTimerId = setInterval(update, 1000);
}

function wireGuestValidation(formEl, lang) {
  const nameInput = formEl.querySelector('input[name="guestName"]');
  const phoneInput = formEl.querySelector('input[name="guestPhone"]');
  const errName = formEl.querySelector('#err-guest-name');
  const errPhone = formEl.querySelector('#err-guest-phone');

  let interacted = false;

  const validateField = (input, errEl, checkFn, msgAr, msgEn) => {
    const ok = checkFn(input.value);
    if (!ok && (interacted || input.dataset.touched === '1')) {
      input.classList.add('is-invalid');
      input.setAttribute('aria-invalid', 'true');
      errEl.textContent = lang === 'ar' ? msgAr : msgEn;
      return false;
    }
    input.classList.remove('is-invalid');
    input.removeAttribute('aria-invalid');
    errEl.textContent = '';
    return ok;
  };

  nameInput?.addEventListener('blur', () => {
    nameInput.dataset.touched = '1';
    validateField(nameInput, errName, (v) => String(v).trim().length >= 3, 'أدخل اسم المسافر الثلاثي أو الكامل', 'Enter full traveler name');
  });

  phoneInput?.addEventListener('blur', () => {
    phoneInput.dataset.touched = '1';
    validateField(phoneInput, errPhone, (v) => String(v).trim().length >= 7, 'أدخل رقم واتساب أو هاتف صحيح للتواصل', 'Enter a valid phone number');
  });

  return () => {
    interacted = true;
    const ok1 = validateField(nameInput, errName, (v) => String(v).trim().length >= 3, 'يرجى كتابة اسم المسافر', 'Traveler name is required');
    const ok2 = validateField(phoneInput, errPhone, (v) => String(v).trim().length >= 7, 'يرجى إدخال رقم هاتف للتأكيد الفوري', 'Phone number is required');
    return ok1 && ok2;
  };
}

export async function openCheckoutForItem({
  dialog,
  bodyEl,
  state,
  itemType,
  itemId,
  tierId = null,
  onSnapshot,
  onToast,
  onGoBookings,
}) {
  const { lang, currency, snapshot, filters } = state;
  const isAr = lang === 'ar';
  const list = itemType === 'hotel' ? snapshot.hotels : snapshot.flights;
  const item = list.find((x) => x.id === itemId);
  if (!item) return;

  const pickedTier = item.tiers?.find((x) => x.id === tierId) || item.tiers?.find((x) => x.effectiveAvailable > 0) || item.tiers?.[0];
  const { rooms, totalPax } = getSelectedGuestCounts(filters);
  const qty = itemType === 'hotel' ? rooms : Math.min(4, totalPax);
  const nights = itemType === 'hotel' ? Math.max(1, Number(filters.nights) || 2) : 1;
  const unitPriceUsd = pickedTier ? pickedTier.pricing.finalPriceUsd : item.pricing.finalPriceUsd;

  try {
    const lockRes = await lockInventory({
      itemType,
      itemId,
      tierId: pickedTier?.id || null,
      quantity: qty,
      nights,
      expectedUnitPriceUsd: unitPriceUsd,
    });

    activeLockState = lockRes.lock;
    if (lockRes.snapshot) onSnapshot(lockRes.snapshot);

    const lock = lockRes.lock;
    const rates = (lockRes.snapshot || snapshot).rates;
    const visaRule = getVisaRule(snapshot, filters.nationality || 'EG', item.countryCode || 'EG');
    const visaUnitUsd = visaRule.assistFeeUsd || 0;

    const titleEl = dialog.querySelector('#checkout-dialog-title');
    if (titleEl) titleEl.textContent = t(lang, 'dialogCheckoutSingleTitle');

    const title = isAr ? item.nameAr || `${item.airlineAr} ${item.flightNumber}` : item.nameEn || `${item.airlineEn} ${item.flightNumber}`;
    const tierLabel = isAr ? lock.tierLabelAr : lock.tierLabelEn;

    bodyEl.innerHTML = `
      <div class="lock-banner">
        <span id="lock-countdown-label" class="num">...</span>
        <span class="mono" style="font-size:0.74rem;">${escapeHtml(item.provider)}</span>
      </div>

      <div class="summary-box">
        <div style="font-weight:800; font-size:0.96rem;">${escapeHtml(title)}</div>
        <div style="font-size:0.82rem; color:var(--brand-teal); font-weight:700;">${escapeHtml(tierLabel)}</div>
        <div class="summary-row">
          <span>${itemType === 'hotel' ? `${qty} × ${nights} ${isAr ? 'ليالٍ' : 'nights'}` : `${qty} ${isAr ? 'تذكرة' : 'passenger(s)'}`}</span>
          <strong class="num">${formatCurrency(lock.totalUsd, currency, rates)}</strong>
        </div>
        <div class="summary-row" id="visa-fee-summary-row" hidden>
          <span>${isAr ? 'خدمة تجهيز وإصدار التأشيرة (الفايد)' : 'Al-Fayed Visa Desk Filing'}</span>
          <strong class="num" id="visa-fee-val"></strong>
        </div>
        <div class="summary-row summary-total">
          <span>${isAr ? 'الإجمالي النهائي للضيف' : 'Total Guest Price'}</span>
          <strong class="num" id="checkout-grand-total" style="color:var(--brand-teal);">${formatCurrency(lock.totalUsd, currency, rates)}</strong>
        </div>
      </div>

      <div style="font-size:0.81rem; padding:0.6rem 0.8rem; border-radius:var(--radius-sm); background:var(--surface-soft);">
        <strong>${t(lang, 'visaBannerPrefix')} ${escapeHtml(filters.nationality || 'EG')}:</strong>
        <span style="color:var(--brand-teal); font-weight:700;"> ${escapeHtml(isAr ? visaRule.labelAr : visaRule.labelEn)}</span>
        <div style="color:var(--ink-muted); margin-block-start:0.15rem;">${escapeHtml(isAr ? visaRule.noteAr : visaRule.noteEn)}</div>
      </div>

      ${
        visaUnitUsd > 0
          ? `
        <label class="visa-upsell-box">
          <input type="checkbox" id="chk-include-visa" name="includeVisaAssist">
          <div>
            <div style="font-weight:800; font-size:0.85rem;">${t(lang, 'visaAssistTitle')} (+${formatCurrency(visaUnitUsd * qty, currency, rates)})</div>
            <div style="font-size:0.76rem; color:var(--ink-secondary);">${t(lang, 'visaAssistFreeHint')}</div>
          </div>
        </label>
      `
          : ''
      }

      <form id="guest-checkout-form" novalidate style="display:grid; gap:0.75rem;">
        <div class="field-group">
          <label class="field-label" for="guest-name">${isAr ? 'الاسم الكامل للمسافر (كما في الجواز) *' : 'Traveler Full Name (as in Passport) *'}</label>
          <input class="input-control" id="guest-name" name="guestName" type="text" required placeholder="${isAr ? 'مثال: أحمد محمد الفايد' : 'e.g. Ahmed Mohamed Al-Fayed'}">
          <span class="field-error-text" id="err-guest-name"></span>
        </div>

        <div class="field-group">
          <label class="field-label" for="guest-phone">${isAr ? 'رقم الهاتف / واتساب لإرسال الإيصال *' : 'Phone / WhatsApp for Instant Voucher *'}</label>
          <input class="input-control mono" id="guest-phone" name="guestPhone" type="tel" required placeholder="+20 100 000 0000">
          <span class="field-error-text" id="err-guest-phone"></span>
        </div>

        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:0.65rem;">
          <div class="field-group">
            <label class="field-label" for="guest-email">${isAr ? 'البريد الإلكتروني (اختياري)' : 'Email (Optional)'}</label>
            <input class="input-control" id="guest-email" name="guestEmail" type="email" placeholder="guest@example.com">
          </div>
          <div class="field-group">
            <label class="field-label" for="guest-payment">${isAr ? 'وسيلة الدفع' : 'Payment Method'}</label>
            <select class="input-control" id="guest-payment" name="paymentMethod">
              <option value="pay_later">${isAr ? 'دفع عند الوصول / كاش فرع الفايد' : 'Pay on Arrival / Office Cash'}</option>
              <option value="card_instant">${isAr ? 'بطاقة ائتمانية / مدى / ميزة' : 'Visa / Mastercard / Mada'}</option>
            </select>
          </div>
        </div>

        <button type="submit" class="btn btn-primary" id="confirm-booking-submit">
          ${isAr ? 'تأكيد الحجز الفوري وإصدار الإيصال' : 'Confirm Instant Zero-Login Booking'}
        </button>
      </form>
    `;

    dialog.showModal();
    attachLockCountdown(bodyEl.querySelector('#lock-countdown-label'), dialog, state, () => {
      onToast(isAr ? 'انتهت مهلة التثبيت — يرجى إعادة فتح العرض' : 'Lock expired — please re-open offer', 'warning');
      closeDialogSmoothly(dialog);
    });

    const visaCheckbox = bodyEl.querySelector('#chk-include-visa');
    const visaRow = bodyEl.querySelector('#visa-fee-summary-row');
    const visaFeeVal = bodyEl.querySelector('#visa-fee-val');
    const totalEl = bodyEl.querySelector('#checkout-grand-total');

    visaCheckbox?.addEventListener('change', () => {
      const extraUsd = visaCheckbox.checked ? visaUnitUsd * qty : 0;
      if (visaRow) visaRow.hidden = !visaCheckbox.checked;
      if (visaFeeVal) visaFeeVal.textContent = formatCurrency(extraUsd, currency, rates);
      if (totalEl) totalEl.textContent = formatCurrency(lock.totalUsd + extraUsd, currency, rates);
    });

    const form = bodyEl.querySelector('#guest-checkout-form');
    const checkValid = wireGuestValidation(form, lang);

    form?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!checkValid()) return;
      const submitBtn = form.querySelector('#confirm-booking-submit');
      submitBtn.disabled = true;

      try {
        const fd = new FormData(form);
        const res = await confirmBooking({
          lockId: lock.id,
          guestName: fd.get('guestName'),
          guestPhone: fd.get('guestPhone'),
          guestEmail: fd.get('guestEmail'),
          paymentMethod: fd.get('paymentMethod'),
          checkInDate: filters.checkInDate,
          checkOutDate: filters.checkOutDate,
          nationality: filters.nationality || 'EG',
          includeVisaAssist: Boolean(visaCheckbox?.checked),
        });
        onSnapshot(res.snapshot);
        renderConfirmedReceipt(bodyEl, res.booking, state, {
          onClose: () => closeDialogSmoothly(dialog),
          onGoBookings,
        });
      } catch (err) {
        submitBtn.disabled = false;
        const msg = isAr ? err.data?.messageAr || err.message : err.data?.messageEn || err.message;
        if (err.data?.snapshot) onSnapshot(err.data.snapshot);
        onToast(msg, 'danger');
      }
    });
  } catch (err) {
    const msg = isAr ? err.data?.messageAr || err.message : err.data?.messageEn || err.message;
    if (err.data?.snapshot) onSnapshot(err.data.snapshot);
    onToast(msg, 'warning');
  }
}

export async function openCheckoutForBundle({
  dialog,
  bodyEl,
  state,
  onSnapshot,
  onToast,
  onGoBookings,
  onClearBundle,
}) {
  const { lang, currency, snapshot, filters, bundle } = state;
  const isAr = lang === 'ar';
  if (!bundle.hotelId || !bundle.flightId) return;

  const { rooms, totalPax } = getSelectedGuestCounts(filters);
  const nights = Math.max(1, Number(filters.nights) || 2);

  try {
    const lockRes = await lockBundle({
      hotelId: bundle.hotelId,
      hotelTierId: bundle.hotelTierId || null,
      flightId: bundle.flightId,
      flightTierId: bundle.flightTierId || null,
      nights,
      guests: totalPax,
      rooms,
      nationality: filters.nationality || 'EG',
      includeVisaAssist: false,
    });

    activeLockState = lockRes.lock;
    if (lockRes.snapshot) onSnapshot(lockRes.snapshot);

    const lock = lockRes.lock;
    const quote = lockRes.quote;
    const rates = (lockRes.snapshot || snapshot).rates;
    const visaRule = lock.visaRule;
    const visaUnitUsd = visaRule?.assistFeeUsd || 0;

    const titleEl = dialog.querySelector('#checkout-dialog-title');
    if (titleEl) titleEl.textContent = t(lang, 'dialogCheckoutBundleTitle');

    bodyEl.innerHTML = `
      <div class="lock-banner">
        <span id="lock-countdown-label" class="num">...</span>
        <span class="mono" style="font-size:0.74rem;">ATOMIC DUAL-LOCK</span>
      </div>

      <div class="summary-box">
        <div style="display:grid; gap:0.55rem;">
          <div style="padding:0.55rem 0.7rem; background:#FFFFFF; border-radius:var(--radius-sm); border:1px solid var(--border-subtle);">
            <div style="font-size:0.74rem; color:var(--brand-teal); font-weight:800;">🏨 ${isAr ? 'الشق الفندقي المثبّت' : 'LOCKED HOTEL LEG'}</div>
            <div style="font-weight:800; font-size:0.9rem;">${escapeHtml(isAr ? quote.hotel.nameAr : quote.hotel.nameEn)}</div>
            <div style="display:flex; justify-content:space-between; font-size:0.8rem; color:var(--ink-secondary);">
              <span>${escapeHtml(isAr ? lock.hotelLock.tierLabelAr : lock.hotelLock.tierLabelEn)} (${rooms} × ${nights}N)</span>
              <strong class="num">${formatCurrency(lock.hotelLock.subtotalUsd, currency, rates)}</strong>
            </div>
          </div>

          <div style="padding:0.55rem 0.7rem; background:#FFFFFF; border-radius:var(--radius-sm); border:1px solid var(--border-subtle);">
            <div style="font-size:0.74rem; color:var(--brand-gold); font-weight:800;">✈ ${isAr ? 'شق الطيران المثبّت' : 'LOCKED FLIGHT LEG'}</div>
            <div style="font-weight:800; font-size:0.9rem;">${escapeHtml(isAr ? quote.flight.airlineAr : quote.flight.airlineEn)} — ${escapeHtml(quote.flight.flightNumber)}</div>
            <div style="display:flex; justify-content:space-between; font-size:0.8rem; color:var(--ink-secondary);">
              <span>${escapeHtml(quote.flight.originCode)} → ${escapeHtml(quote.flight.destCode)} • ${escapeHtml(isAr ? lock.flightLock.tierLabelAr : lock.flightLock.tierLabelEn)} (${totalPax} ${isAr ? 'مسافر' : 'pax'})</span>
              <strong class="num">${formatCurrency(lock.flightLock.subtotalUsd, currency, rates)}</strong>
            </div>
          </div>
        </div>

        <div class="summary-row" style="margin-block-start:0.25rem; color:var(--status-success); font-weight:800;">
          <span>✨ ${isAr ? `خصم الباكيدج التلقائي (${lock.packageDiscountPercent}%)` : `Automatic Bundle Savings (${lock.packageDiscountPercent}%)`}</span>
          <span class="num">−${formatCurrency(lock.bundleDiscountUsd, currency, rates)}</span>
        </div>

        <div class="summary-row" id="bundle-visa-row" hidden>
          <span>${isAr ? 'تجهيز وإصدار التأشيرة عبر الفايد' : 'Al-Fayed Visa Desk Filing'}</span>
          <strong class="num" id="bundle-visa-val"></strong>
        </div>

        <div class="summary-row summary-total">
          <span>${isAr ? 'الإجمالي الموحد (طيران + فندق معاً)' : 'Unified Package Total'}</span>
          <strong class="num" id="bundle-grand-total" style="color:var(--brand-teal);">${formatCurrency(lock.totalUsd, currency, rates)}</strong>
        </div>
      </div>

      ${
        visaUnitUsd > 0
          ? `
        <label class="visa-upsell-box">
          <input type="checkbox" id="chk-bundle-visa">
          <div>
            <div style="font-weight:800; font-size:0.84rem;">${t(lang, 'visaAssistTitle')} (+${formatCurrency(visaUnitUsd * totalPax, currency, rates)})</div>
            <div style="font-size:0.76rem; color:var(--ink-secondary);">${escapeHtml(isAr ? visaRule.noteAr : visaRule.noteEn)}</div>
          </div>
        </label>
      `
          : ''
      }

      <form id="guest-checkout-form" novalidate style="display:grid; gap:0.75rem;">
        <div class="field-group">
          <label class="field-label" for="guest-name">${isAr ? 'الاسم الكامل للمسافر الرئيسي *' : 'Lead Traveler Full Name *'}</label>
          <input class="input-control" id="guest-name" name="guestName" type="text" required placeholder="${isAr ? 'مثال: سارة عبد الله الفايد' : 'e.g. Sara Abdallah'}">
          <span class="field-error-text" id="err-guest-name"></span>
        </div>

        <div class="field-group">
          <label class="field-label" for="guest-phone">${isAr ? 'رقم الهاتف / واتساب للتأكيد الفوري *' : 'WhatsApp / Mobile Number *'}</label>
          <input class="input-control mono" id="guest-phone" name="guestPhone" type="tel" required placeholder="+20 100 000 0000">
          <span class="field-error-text" id="err-guest-phone"></span>
        </div>

        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:0.65rem;">
          <div class="field-group">
            <label class="field-label" for="guest-email">${isAr ? 'البريد الإلكتروني (اختياري)' : 'Email (Optional)'}</label>
            <input class="input-control" id="guest-email" name="guestEmail" type="email" placeholder="guest@example.com">
          </div>
          <div class="field-group">
            <label class="field-label" for="guest-payment">${isAr ? 'وسيلة الدفع' : 'Payment Method'}</label>
            <select class="input-control" id="guest-payment" name="paymentMethod">
              <option value="pay_later">${isAr ? 'دفع عند فرع الفايد / لاحقاً' : 'Pay at Office / Later'}</option>
              <option value="card_instant">${isAr ? 'بطاقة بنكية فورية' : 'Instant Card'}</option>
            </select>
          </div>
        </div>

        <button type="submit" class="btn btn-gold" id="confirm-booking-submit">
          ${isAr ? 'تثبيت وحجز الفندق + الطيران معاً في نفس الثانية' : 'Book Both Flight & Hotel Simultaneously'}
        </button>
      </form>
    `;

    dialog.showModal();
    attachLockCountdown(bodyEl.querySelector('#lock-countdown-label'), dialog, state, () => {
      onToast(isAr ? 'انتهت مهلة التثبيت المزدوج' : 'Bundle hold expired', 'warning');
      closeDialogSmoothly(dialog);
    });

    const visaCheckbox = bodyEl.querySelector('#chk-bundle-visa');
    const visaRow = bodyEl.querySelector('#bundle-visa-row');
    const visaVal = bodyEl.querySelector('#bundle-visa-val');
    const grandTotal = bodyEl.querySelector('#bundle-grand-total');

    visaCheckbox?.addEventListener('change', () => {
      const extra = visaCheckbox.checked ? visaUnitUsd * totalPax : 0;
      if (visaRow) visaRow.hidden = !visaCheckbox.checked;
      if (visaVal) visaVal.textContent = formatCurrency(extra, currency, rates);
      if (grandTotal) grandTotal.textContent = formatCurrency(lock.totalUsd + extra, currency, rates);
    });

    const form = bodyEl.querySelector('#guest-checkout-form');
    const checkValid = wireGuestValidation(form, lang);

    form?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!checkValid()) return;
      const submitBtn = form.querySelector('#confirm-booking-submit');
      submitBtn.disabled = true;

      try {
        const fd = new FormData(form);
        const res = await confirmBundleBooking({
          lockId: lock.id,
          guestName: fd.get('guestName'),
          guestPhone: fd.get('guestPhone'),
          guestEmail: fd.get('guestEmail'),
          paymentMethod: fd.get('paymentMethod'),
          checkInDate: filters.checkInDate,
          checkOutDate: filters.checkOutDate,
          nationality: filters.nationality || 'EG',
          includeVisaAssist: Boolean(visaCheckbox?.checked),
        });
        onSnapshot(res.snapshot);
        onClearBundle?.();
        renderConfirmedReceipt(bodyEl, res.booking, state, {
          onClose: () => closeDialogSmoothly(dialog),
          onGoBookings,
        });
      } catch (err) {
        submitBtn.disabled = false;
        const msg = isAr ? err.data?.messageAr || err.message : err.data?.messageEn || err.message;
        if (err.data?.snapshot) onSnapshot(err.data.snapshot);
        onToast(msg, 'danger');
      }
    });
  } catch (err) {
    const msg = isAr ? err.data?.messageAr || err.message : err.data?.messageEn || err.message;
    if (err.data?.snapshot) onSnapshot(err.data.snapshot);
    onToast(msg, 'danger');
  }
}

export function initCheckoutDialogLifecycle(dialog, { onSnapshot }) {
  dialog?.addEventListener('close', async () => {
    clearCountdown();
    if (activeLockState?.id) {
      const id = activeLockState.id;
      activeLockState = null;
      try {
        const res = await releaseLock(id);
        if (res.snapshot) onSnapshot(res.snapshot);
      } catch {
        // Ignore already released/confirmed lock
      }
    }
  });
}

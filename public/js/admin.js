import { saveMarkupConfig, toggleAutoPulse, triggerSimulation } from './api.js';
import { formatCurrency, t } from './i18n.js';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderAdminView(root, state, { onSnapshot, onToast }) {
  const { snapshot, lang, currency } = state;
  if (!snapshot) return;

  // Guard active form focus so live SSE broadcasts never wipe admin edits while typing
  if (root.contains(document.activeElement) && document.activeElement?.closest('#admin-markup-form')) {
    return;
  }

  const mc = snapshot.markupConfig;
  const metrics = snapshot.metrics;
  const isAr = lang === 'ar';

  const kpiCards = `
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">${isAr ? 'الفنادق النشطة حالياً' : 'Active Hotels'}</div>
        <div class="kpi-value num">${metrics.activeHotelCount} / ${snapshot.hotels.length}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">${isAr ? 'الرحلات الجوية النشطة' : 'Active Flights'}</div>
        <div class="kpi-value num">${metrics.activeFlightCount} / ${snapshot.flights.length}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">${isAr ? 'الحجوزات المؤكدة' : 'Confirmed Bookings'}</div>
        <div class="kpi-value num">${metrics.confirmedBookingsCount}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">${isAr ? 'صافي أرباح الهامش المحققة' : 'Realized Margin Profit'}</div>
        <div class="kpi-value num" style="color:var(--brand-teal);">${formatCurrency(metrics.estimatedProfitUsd, currency, snapshot.rates)}</div>
      </div>
    </div>
  `;

  const providerRows = Object.entries(mc.providers || {})
    .map(
      ([name, rule]) => `
      <div class="rule-row">
        <div>
          <strong class="mono" style="font-size:0.86rem;">${escapeHtml(name)}</strong>
        </div>
        <label class="checkbox-row">
          <input type="checkbox" name="prov_${escapeHtml(name)}_enabled" ${rule.enabled ? 'checked' : ''}>
          <span>${isAr ? 'مفعّل' : 'Enabled'}</span>
        </label>
        <select class="input-control" name="prov_${escapeHtml(name)}_type">
          <option value="percent" ${rule.type === 'percent' ? 'selected' : ''}>${t(lang, 'adminTypePercent')}</option>
          <option value="fixed" ${rule.type === 'fixed' ? 'selected' : ''}>${t(lang, 'adminTypeFixed')}</option>
        </select>
        <input class="input-control num" type="number" step="0.5" min="0" name="prov_${escapeHtml(name)}_value" value="${Number(rule.value)}">
      </div>
    `,
    )
    .join('');

  const hotelOptions = snapshot.hotels
    .map(
      (h) =>
        `<option value="hotel:${h.id}">${isAr ? `فندق: ${h.nameAr}` : `Hotel: ${h.nameEn}`} (${h.effectiveAvailable})</option>`,
    )
    .join('');

  const flightOptions = snapshot.flights
    .map(
      (f) =>
        `<option value="flight:${f.id}">${isAr ? `رحلة: ${f.airlineAr} ${f.flightNumber}` : `Flight: ${f.airlineEn} ${f.flightNumber}`} (${f.effectiveAvailable})</option>`,
    )
    .join('');

  const liveRows = [...snapshot.hotels.slice(0, 5), ...snapshot.flights.slice(0, 4)]
    .map((item) => {
      const title = item.itemType === 'hotel' ? (isAr ? item.nameAr : item.nameEn) : `${item.flightNumber} (${item.originCode}→${item.destCode})`;
      return `
        <tr>
          <td><strong>${escapeHtml(title)}</strong><div class="mono" style="font-size:0.72rem; color:var(--ink-muted);">${escapeHtml(item.provider)}</div></td>
          <td class="num">${formatCurrency(item.pricing.supplierPriceUsd, currency, snapshot.rates)}</td>
          <td class="num" style="color:var(--brand-teal); font-weight:700;">+${formatCurrency(item.pricing.markupUsd, currency, snapshot.rates)} (${item.pricing.marginPercent}%)</td>
          <td class="num" style="font-weight:800;">${formatCurrency(item.pricing.finalPriceUsd, currency, snapshot.rates)}</td>
          <td class="num">${item.effectiveAvailable}</td>
        </tr>
      `;
    })
    .join('');

  const feedHtml = (snapshot.feedEvents || [])
    .map((ev) => {
      const msg = isAr ? ev.messageAr : ev.messageEn;
      const timeStr = new Date(ev.ts).toLocaleTimeString(isAr ? 'ar-EG' : 'en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      return `
        <div class="feed-row">
          <div>
            <span class="ticker-badge" style="margin-inline-end:0.45rem;">${escapeHtml(ev.provider)}</span>
            <span>${escapeHtml(msg)}</span>
          </div>
          <span class="mono" style="font-size:0.75rem; color:var(--ink-muted); flex-shrink:0;">${timeStr}</span>
        </div>
      `;
    })
    .join('');

  root.innerHTML = `
    <div class="admin-grid">
      <div class="section-header-row">
        <h2 class="section-heading">
          <span class="section-icon">⚙</span>
          <span>${t(lang, 'adminTitle')}</span>
        </h2>
        <div style="display:flex; gap:0.65rem; flex-wrap:wrap; align-items:center;">
          <label class="checkbox-row" style="background:#FFFFFF; padding:0.45rem 0.8rem; border-radius:var(--radius-pill); border:1px solid var(--border-subtle);">
            <input type="checkbox" id="admin-autopulse-toggle" ${snapshot.autoPulseEnabled ? 'checked' : ''}>
            <span>${t(lang, 'adminAutoPulse')}</span>
          </label>
          <button type="button" class="btn btn-secondary btn-sm" id="admin-reset-all-btn">${t(lang, 'adminResetAll')}</button>
        </div>
      </div>

      ${kpiCards}

      <div class="panel-card">
        <h3 class="panel-title">${isAr ? 'قواعد هامش الربح وخصم الباكيدج التلقائي' : 'Dynamic Margin & Dual-Package Rules'}</h3>
        <form id="admin-markup-form">
          <div class="rule-row">
            <div><strong>${t(lang, 'adminRuleGlobal')}</strong></div>
            <span class="amenity-chip is-green">${isAr ? 'افتراضي نشط' : 'Fallback'}</span>
            <select class="input-control" name="global_type">
              <option value="percent" ${mc.global.type === 'percent' ? 'selected' : ''}>${t(lang, 'adminTypePercent')}</option>
              <option value="fixed" ${mc.global.type === 'fixed' ? 'selected' : ''}>${t(lang, 'adminTypeFixed')}</option>
            </select>
            <input class="input-control num" type="number" step="0.5" min="0" name="global_value" value="${Number(mc.global.value)}">
          </div>

          <div class="rule-row">
            <div><strong>${t(lang, 'adminRuleHotels')}</strong></div>
            <label class="checkbox-row">
              <input type="checkbox" name="hotels_enabled" ${mc.hotels.enabled ? 'checked' : ''}>
              <span>${isAr ? 'مفعّل' : 'Enabled'}</span>
            </label>
            <select class="input-control" name="hotels_type">
              <option value="percent" ${mc.hotels.type === 'percent' ? 'selected' : ''}>${t(lang, 'adminTypePercent')}</option>
              <option value="fixed" ${mc.hotels.type === 'fixed' ? 'selected' : ''}>${t(lang, 'adminTypeFixed')}</option>
            </select>
            <input class="input-control num" type="number" step="0.5" min="0" name="hotels_value" value="${Number(mc.hotels.value)}">
          </div>

          <div class="rule-row">
            <div><strong>${t(lang, 'adminRuleFlights')}</strong></div>
            <label class="checkbox-row">
              <input type="checkbox" name="flights_enabled" ${mc.flights.enabled ? 'checked' : ''}>
              <span>${isAr ? 'مفعّل' : 'Enabled'}</span>
            </label>
            <select class="input-control" name="flights_type">
              <option value="percent" ${mc.flights.type === 'percent' ? 'selected' : ''}>${t(lang, 'adminTypePercent')}</option>
              <option value="fixed" ${mc.flights.type === 'fixed' ? 'selected' : ''}>${t(lang, 'adminTypeFixed')}</option>
            </select>
            <input class="input-control num" type="number" step="0.5" min="0" name="flights_value" value="${Number(mc.flights.value)}">
          </div>

          <div class="rule-row">
            <div><strong>${t(lang, 'adminPackageDiscount')}</strong></div>
            <span class="amenity-chip">${isAr ? 'فندق + طيران' : 'Bundle'}</span>
            <span style="font-size:0.8rem; color:var(--ink-muted);">${isAr ? 'نسبة الخصم %' : 'Discount %'}</span>
            <input class="input-control num" type="number" step="1" min="0" max="25" name="package_discount" value="${Number(mc.packageDiscountPercent ?? 6)}">
          </div>

          <h4 style="margin-block:1rem 0.35rem; font-size:0.92rem;">${t(lang, 'adminProviderOverrides')}</h4>
          ${providerRows}

          <div style="margin-block-start:1rem; display:flex; justify-content:flex-end;">
            <button type="submit" class="btn btn-primary">${t(lang, 'adminSaveMarkup')}</button>
          </div>
        </form>
      </div>

      <div class="panel-card">
        <h3 class="panel-title">${t(lang, 'adminSimulateTitle')}</h3>
        <div style="display:flex; gap:0.75rem; flex-wrap:wrap; align-items:center;">
          <select class="input-control" id="sim-target-select" style="flex:1 1 280px;">
            ${hotelOptions}
            ${flightOptions}
          </select>
          <button type="button" class="btn btn-secondary btn-sm sim-btn" data-sim="price_hike">${isAr ? 'رفع السعر +9%' : 'Supplier +9%'}</button>
          <button type="button" class="btn btn-secondary btn-sm sim-btn" data-sim="price_drop">${isAr ? 'خصم السعر -8%' : 'Supplier -8%'}</button>
          <button type="button" class="btn btn-danger btn-sm sim-btn" data-sim="sellout">${isAr ? 'محاكاة نفاد فوري (Sold Out)' : 'Simulate Sellout'}</button>
          <button type="button" class="btn btn-primary btn-sm sim-btn" data-sim="restock">${isAr ? 'إعادة إتاحة التوفر' : 'Restock Units'}</button>
        </div>
      </div>

      <div class="panel-card">
        <h3 class="panel-title">${isAr ? 'معاينة الأسعار وصافي الربح لكل مزود' : 'Supplier Cost vs. Live Client Rate'}</h3>
        <div class="compare-table-wrap">
          <table class="compare-table">
            <thead>
              <tr>
                <th>${isAr ? 'العرض / المزود' : 'Offer / Provider'}</th>
                <th>${isAr ? 'سعر المزود الأساسي' : 'Net Supplier'}</th>
                <th>${isAr ? 'هامش ربح الفايد' : 'Al-Fayed Margin'}</th>
                <th>${isAr ? 'السعر المعروض للعميل' : 'Client Live Price'}</th>
                <th>${isAr ? 'المتبقي' : 'Stock'}</th>
              </tr>
            </thead>
            <tbody>${liveRows}</tbody>
          </table>
        </div>
      </div>

      <div class="panel-card">
        <h3 class="panel-title">${t(lang, 'adminFeedTitle')}</h3>
        <div class="feed-list">${feedHtml}</div>
      </div>
    </div>
  `;

  root.querySelector('#admin-markup-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.currentTarget);
    const providers = {};
    for (const name of Object.keys(mc.providers || {})) {
      providers[name] = {
        enabled: fd.get(`prov_${name}_enabled`) === 'on',
        type: fd.get(`prov_${name}_type`),
        value: Number(fd.get(`prov_${name}_value`) || 0),
      };
    }

    const patch = {
      global: { type: fd.get('global_type'), value: Number(fd.get('global_value') || 0) },
      hotels: {
        enabled: fd.get('hotels_enabled') === 'on',
        type: fd.get('hotels_type'),
        value: Number(fd.get('hotels_value') || 0),
      },
      flights: {
        enabled: fd.get('flights_enabled') === 'on',
        type: fd.get('flights_type'),
        value: Number(fd.get('flights_value') || 0),
      },
      packageDiscountPercent: Number(fd.get('package_discount') || 6),
      providers,
    };

    try {
      const res = await saveMarkupConfig(patch);
      onSnapshot(res.snapshot);
      onToast(isAr ? 'تم نشر قواعد الهامش الجديدة لحظياً لكل المتصفحات' : 'Live margins pushed to all clients', 'success');
    } catch (err) {
      onToast(err.message, 'danger');
    }
  });

  root.querySelectorAll('.sim-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.sim;
      const val = root.querySelector('#sim-target-select')?.value || '';
      const [itemType, itemId] = val.split(':');
      try {
        const res = await triggerSimulation({ action, itemType, itemId });
        onSnapshot(res.snapshot);
        onToast(isAr ? 'تم تنفيذ المحاكاة اللحظية وبثها' : 'Real-time event broadcasted', 'info');
      } catch (err) {
        onToast(err.message, 'danger');
      }
    });
  });

  root.querySelector('#admin-reset-all-btn')?.addEventListener('click', async () => {
    try {
      const res = await triggerSimulation({ action: 'reset_all' });
      onSnapshot(res.snapshot);
      onToast(isAr ? 'تمت إعادة ضبط كافة المخزون والأسعار' : 'All inventory reset cleanly', 'success');
    } catch (err) {
      onToast(err.message, 'danger');
    }
  });

  root.querySelector('#admin-autopulse-toggle')?.addEventListener('change', async (ev) => {
    try {
      const res = await toggleAutoPulse(ev.currentTarget.checked);
      onSnapshot(res.snapshot);
    } catch (err) {
      onToast(err.message, 'danger');
    }
  });
}

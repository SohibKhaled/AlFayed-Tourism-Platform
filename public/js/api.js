/**
 * HTTP + SSE client wrapper for Al-Fayed Tourism real-time API.
 */

export async function apiRequest(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.messageEn || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function getBootstrap() {
  return apiRequest('/api/bootstrap');
}

export function fetchBundleQuote(payload) {
  return apiRequest('/api/bundle/quote', { method: 'POST', body: JSON.stringify(payload) });
}

export function lockInventory(payload) {
  return apiRequest('/api/locks', { method: 'POST', body: JSON.stringify(payload) });
}

export function lockBundle(payload) {
  return apiRequest('/api/locks/bundle', { method: 'POST', body: JSON.stringify(payload) });
}

export function releaseLock(lockId) {
  return apiRequest(`/api/locks/${encodeURIComponent(lockId)}/release`, { method: 'POST', body: '{}' });
}

export function confirmBooking(payload) {
  return apiRequest('/api/bookings', { method: 'POST', body: JSON.stringify(payload) });
}

export function confirmBundleBooking(payload) {
  return apiRequest('/api/bookings/bundle', { method: 'POST', body: JSON.stringify(payload) });
}

export function lookupBooking(ref) {
  return apiRequest(`/api/bookings/${encodeURIComponent(ref)}`);
}

export function cancelBooking(bookingId) {
  return apiRequest(`/api/bookings/${encodeURIComponent(bookingId)}/cancel`, { method: 'POST', body: '{}' });
}

export function saveMarkupConfig(patch) {
  return apiRequest('/api/admin/markup', { method: 'PUT', body: JSON.stringify(patch) });
}

export function triggerSimulation(payload) {
  return apiRequest('/api/admin/simulate', { method: 'POST', body: JSON.stringify(payload) });
}

export function toggleAutoPulse(enabled) {
  return apiRequest('/api/admin/auto-pulse', { method: 'POST', body: JSON.stringify({ enabled }) });
}

export function connectLiveStream({ onSnapshot, onConnectionChange }) {
  const source = new EventSource('/api/stream');
  source.addEventListener('open', () => onConnectionChange(true));
  source.addEventListener('snapshot', (ev) => {
    try {
      const snap = JSON.parse(ev.data);
      onConnectionChange(true);
      onSnapshot(snap);
    } catch {
      // Ignore malformed keepalive chunk
    }
  });
  source.addEventListener('error', () => {
    onConnectionChange(false);
  });
  return () => source.close();
}

import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.6.0/dist/maplibre-gl.mjs';

const SETTINGS_KEY = 'tacticalRadar.settings.v2';
const WORLD = { center: [0, 18], zoom: 1.35 };
const defaults = { proxyUrl: '', adsbKey: '' };
let settings = loadSettings(), deferredInstallPrompt, refreshTimer, requestController;
const state = { mode: 'all', aircraft: [], paused: false, mapReady: false, located: false };
const markers = new Map();
const ids = ['startup','startupStatus','startupLocateBtn','startupWorldBtn','globeScene','terminal','linkText','modeReadout','rangeReadout','airCount','milCount','positionReadout','coords','contactPanel','adsbFooter','sweep','settingsDialog','settingsForm','proxyUrlInput','adsbKeyInput','settingsStatus','installBtn'];
const els = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));

function loadSettings() { try { return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...defaults }; } }
function saveSettings(next) { settings = { ...defaults, ...next }; localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
function apiBase() { return String(settings.proxyUrl || '').trim().replace(/\/+$/, ''); }
function staticWithoutProxy() { return location.hostname.endsWith('github.io') && !apiBase(); }

const map = new maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/dark', center: WORLD.center, zoom: WORLD.zoom, minZoom: 1, attributionControl: true, pitchWithRotate: false, dragRotate: false, maxPitch: 0 });
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.on('load', () => { state.mapReady = true; tintMap(); updateReadouts(); });
map.on('moveend', () => { updateReadouts(); scheduleRefresh(180); });

function tintMap() {
  for (const layer of map.getStyle().layers || []) try {
    if (layer.type === 'background') map.setPaintProperty(layer.id, 'background-color', '#061009');
    if (layer.type === 'fill') { map.setPaintProperty(layer.id, 'fill-color', layer.id.toLowerCase().includes('water') ? '#04130b' : '#0b2415'); map.setPaintProperty(layer.id, 'fill-opacity', .86); }
    if (layer.type === 'line') { map.setPaintProperty(layer.id, 'line-color', '#245c37'); map.setPaintProperty(layer.id, 'line-opacity', layer.id.toLowerCase().includes('road') ? .42 : .65); }
    if (layer.type === 'symbol') { map.setPaintProperty(layer.id, 'text-color', '#72ad82'); map.setPaintProperty(layer.id, 'text-halo-color', '#061009'); map.setPaintProperty(layer.id, 'text-halo-width', 1); }
  } catch {}
}
function visibleRegion() {
  if (!state.mapReady) return null;
  const b = map.getBounds(), c = map.getCenter();
  const region = { west: Math.max(-180, b.getWest()), south: Math.max(-90, b.getSouth()), east: Math.min(180, b.getEast()), north: Math.min(90, b.getNorth()), lat: c.lat, lon: c.lng };
  const latNm = Math.abs(region.north - region.south) * 30;
  const lonNm = Math.abs(region.east - region.west) * 30 * Math.max(.15, Math.cos(c.lat * Math.PI / 180));
  region.radius = Math.ceil(Math.hypot(latNm, lonNm));
  return region;
}
function scheduleRefresh(delay = 0) { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshAircraft, delay); }
function updateReadouts() {
  const r = visibleRegion();
  els.modeReadout.textContent = `MODE ${state.mode.toUpperCase()}`;
  els.rangeReadout.textContent = r && r.radius <= 250 ? `VIEW ≈ ${r.radius} NM` : 'VIEW WORLD/REGION';
  els.positionReadout.textContent = state.located ? 'POS GPS LOCK' : 'POS WORLD VIEW';
  if (r) els.coords.textContent = `${Math.abs(r.lat).toFixed(4)} ${r.lat >= 0 ? 'N' : 'S'} / ${Math.abs(r.lon).toFixed(4)} ${r.lon >= 0 ? 'E' : 'W'}`;
  els.airCount.textContent = `AIR ${String(state.aircraft.length).padStart(3, '0')}`;
  els.milCount.textContent = `MIL ${String(state.aircraft.filter(a => a.military).length).padStart(3, '0')}`;
}
function renderMarkers() {
  for (const marker of markers.values()) marker.remove(); markers.clear();
  for (const a of state.aircraft) {
    const el = document.createElement('button'); el.className = `air-marker${a.military ? ' mil' : ''}`; el.type = 'button'; el.textContent = '▲'; el.title = a.callsign || a.registration || a.hex || 'Aircraft';
    el.style.border = '0'; el.style.background = 'transparent'; el.style.padding = '0'; el.style.transform = `rotate(${Number(a.track || 0)}deg)`;
    el.addEventListener('click', () => showContact(a));
    markers.set(a.id, new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([a.lon, a.lat]).addTo(map));
  }
  updateReadouts();
}
function esc(s) { return String(s ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c])); }
function fmt(v, suffix = '') { return v === null || v === undefined || v === '' ? '—' : `${v}${suffix}`; }
function showContact(d) {
  const title = d.callsign || d.registration || d.hex || 'AIRCRAFT', colour = d.military ? 'var(--mil)' : 'var(--civ)';
  els.contactPanel.innerHTML = `<div class="contact-title" style="color:${colour}"><strong>${esc(title)}</strong><span class="tag">${d.military ? 'MILITARY' : 'AIRCRAFT'}</span></div><div class="data-grid"><div class="datum"><small>TYPE</small><strong>${esc(d.type || d.description || '—')}</strong></div><div class="datum"><small>REGISTRATION</small><strong>${esc(d.registration || '—')}</strong></div><div class="datum"><small>ALTITUDE</small><strong>${fmt(d.altitude, ' ft')}</strong></div><div class="datum"><small>GROUND SPEED</small><strong>${fmt(d.speed, ' kt')}</strong></div><div class="datum"><small>TRACK</small><strong>${fmt(d.track, '°')}</strong></div><div class="datum"><small>SQUAWK</small><strong>${esc(d.squawk || '—')}</strong></div><div class="datum"><small>ICAO</small><strong>${esc(d.hex || '—')}</strong></div><div class="datum"><small>OPERATOR</small><strong>${esc(d.operator || '—')}</strong></div></div>`;
}
async function refreshAircraft() {
  if (!state.mapReady) return;
  const r = visibleRegion();
  if (!r || r.radius > 250) { requestController?.abort(); state.aircraft = []; renderMarkers(); els.linkText.textContent = 'ZOOM IN FOR TRAFFIC'; els.adsbFooter.textContent = 'Aircraft: zoom to a region (maximum 250 NM view radius)'; return; }
  if (staticWithoutProxy()) { state.aircraft = []; renderMarkers(); els.linkText.textContent = 'SET PROXY URL'; els.adsbFooter.textContent = 'Aircraft: proxy URL required on GitHub Pages'; return; }
  requestController?.abort(); requestController = new AbortController(); els.linkText.textContent = 'UPDATING';
  const query = new URLSearchParams({ west: r.west, south: r.south, east: r.east, north: r.north, mode: state.mode });
  try {
    const headers = settings.adsbKey ? { accept: 'application/json', 'x-adsb-key': settings.adsbKey } : { accept: 'application/json' };
    const response = await fetch(`${apiBase()}/api/aircraft?${query}`, { headers, signal: requestController.signal });
    if (!response.ok) throw new Error(`aircraft-${response.status}`);
    const data = await response.json(); state.aircraft = data.aircraft || []; renderMarkers(); els.adsbFooter.textContent = `Aircraft: ${data.source || 'ADS-B feed'} · visible region`; els.linkText.textContent = 'TRACKING';
  } catch (error) { if (error.name !== 'AbortError') { state.aircraft = []; renderMarkers(); els.linkText.textContent = 'FEED DEGRADED'; } }
}

function enterRadar(center, zoom) { els.startup.classList.add('leaving'); map.jumpTo({ center, zoom }); setTimeout(() => { els.startup.hidden = true; scheduleRefresh(); }, 700); }
function worldView() { state.located = false; map.flyTo({ center: WORLD.center, zoom: WORLD.zoom, duration: 1800, essential: true }); }
function locate(startup = false) {
  if (!navigator.geolocation) return locationFailed(startup, 'LOCATION SERVICE UNAVAILABLE');
  if (startup) runConnectionSequence(); else els.linkText.textContent = 'ACQUIRING POSITION';
  navigator.geolocation.getCurrentPosition(p => locationAcquired(p.coords.latitude, p.coords.longitude, startup), () => locationFailed(startup, 'LOCATION PERMISSION DENIED'), { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
}
function runConnectionSequence() {
  els.startupLocateBtn.disabled = true; els.startupWorldBtn.disabled = true; els.terminal.innerHTML = '';
  ['> ACQUIRING POSITION...', '> SEARCHING REGIONAL SATELLITE COVERAGE...', '> TRIANGULATING BROWSER POSITION...'].forEach((line, i) => setTimeout(() => els.terminal.insertAdjacentHTML('beforeend', `<div>${line}</div>`), i * 650));
}
function locationAcquired(lat, lon, startup) {
  state.located = true;
  if (startup) { els.terminal.insertAdjacentHTML('beforeend', '<div class="terminal-ok">> LINK ESTABLISHED</div>'); els.startupStatus.textContent = 'REGIONAL COVERAGE CONNECTED'; els.globeScene.style.setProperty('--target-x', `${Math.max(-24, Math.min(24, lon / 7.5))}deg`); els.globeScene.style.setProperty('--target-y', `${Math.max(-18, Math.min(18, -lat / 5))}deg`); els.startup.classList.add('targeting'); setTimeout(() => enterRadar([lon, lat], 7), 1300); }
  else map.flyTo({ center: [lon, lat], zoom: 7, duration: 2200, essential: true });
}
function locationFailed(startup, message) {
  state.located = false;
  if (startup) { els.terminal.insertAdjacentHTML('beforeend', `<div class="terminal-warn">> ${message} // WORLD VIEW FALLBACK</div>`); els.startupStatus.textContent = 'WORLD VIEW READY'; setTimeout(() => enterRadar(WORLD.center, WORLD.zoom), 850); }
  else { els.linkText.textContent = 'WORLD VIEW'; worldView(); }
}

els.startupLocateBtn.addEventListener('click', () => locate(true));
els.startupWorldBtn.addEventListener('click', () => enterRadar(WORLD.center, WORLD.zoom));
document.getElementById('locateBtn').addEventListener('click', () => locate());
document.getElementById('worldBtn').addEventListener('click', worldView);
for (const btn of document.querySelectorAll('#filters button')) btn.addEventListener('click', () => { state.mode = btn.dataset.mode; document.querySelectorAll('#filters button').forEach(b => b.classList.toggle('active', b === btn)); updateReadouts(); scheduleRefresh(); });
document.getElementById('sweepBtn').addEventListener('click', e => { state.paused = !state.paused; els.sweep.classList.toggle('paused', state.paused); e.currentTarget.textContent = state.paused ? '▶ RESUME SWEEP' : 'Ⅱ PAUSE SWEEP'; });
function openSettings() { els.proxyUrlInput.value = settings.proxyUrl || ''; els.adsbKeyInput.value = settings.adsbKey || ''; els.settingsStatus.textContent = settings.proxyUrl || settings.adsbKey ? 'SAVED CONFIGURATION LOADED' : 'NO LOCAL SETTINGS SAVED'; els.settingsDialog.showModal(); }
document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('closeSettingsBtn').addEventListener('click', () => els.settingsDialog.close());
for (const b of document.querySelectorAll('[data-reveal]')) b.addEventListener('click', () => { const input = document.getElementById(b.dataset.reveal), showing = input.type === 'text'; input.type = showing ? 'password' : 'text'; b.textContent = showing ? 'SHOW' : 'HIDE'; });
els.settingsForm.addEventListener('submit', e => { e.preventDefault(); const proxy = els.proxyUrlInput.value.trim(); if (proxy && !/^https?:\/\//i.test(proxy)) { els.settingsStatus.textContent = 'PROXY URL MUST START HTTP:// OR HTTPS://'; return; } saveSettings({ proxyUrl: proxy, adsbKey: els.adsbKeyInput.value.trim() }); els.settingsStatus.textContent = 'SAVED ON THIS DEVICE'; setTimeout(() => { els.settingsDialog.close(); scheduleRefresh(); }, 350); });
document.getElementById('clearSettingsBtn').addEventListener('click', () => { try { localStorage.removeItem(SETTINGS_KEY); } catch {} settings = { ...defaults }; els.proxyUrlInput.value = ''; els.adsbKeyInput.value = ''; els.settingsStatus.textContent = 'SAVED SETTINGS CLEARED'; });
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstallPrompt = e; els.installBtn.textContent = '⇩ INSTALL APP'; });
window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; els.installBtn.textContent = '✓ INSTALLED'; });
els.installBtn.addEventListener('click', async () => { if (deferredInstallPrompt) { deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; return; } alert('To install: open your browser menu and choose “Install app” or “Add to Home screen”. On iPhone/iPad use Share → Add to Home Screen.'); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
updateReadouts();
setInterval(() => { if (!document.hidden && els.startup.hidden) refreshAircraft(); }, 10000);

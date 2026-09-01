import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.6.0/dist/maplibre-gl.mjs';

const DEFAULT_POSITION = { lat: 53.3811, lon: -1.4701, source: 'UK DEFAULT' };
const SETTINGS_KEY = 'tacticalRadar.settings.v1';
const defaultSettings = { proxyUrl: '', aisKey: '', adsbKey: '' };
let settings = loadSettings();
let deferredInstallPrompt = null;

const state = { center: { ...DEFAULT_POSITION }, mode: 'all', range: 100, aircraft: [], vessels: [], paused: false, mapReady: false };
const markers = new Map();
const ids = ['linkText','modeReadout','rangeReadout','airCount','milCount','shipCount','positionReadout','coords','contactPanel','aisFooter','adsbFooter','rangeSelect','sweep','settingsDialog','settingsForm','proxyUrlInput','aisKeyInput','adsbKeyInput','settingsStatus','installBtn'];
const els = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));

function loadSettings() {
  try { return { ...defaultSettings, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')) }; }
  catch { return { ...defaultSettings }; }
}
function saveSettings(next) {
  settings = { ...defaultSettings, ...next };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
function apiBase() { return String(settings.proxyUrl || '').trim().replace(/\/+$/, ''); }
function apiUrl(path) { return `${apiBase()}${path}`; }
function feedHeaders(kind) {
  const h = { 'accept': 'application/json' };
  if (kind === 'ais' && settings.aisKey) h['x-aisstream-key'] = settings.aisKey;
  if (kind === 'adsb' && settings.adsbKey) h['x-adsb-key'] = settings.adsbKey;
  return h;
}
function onStaticHostWithoutProxy() {
  return location.hostname.endsWith('github.io') && !apiBase();
}

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/dark',
  center: [state.center.lon, state.center.lat],
  zoom: 6.4,
  attributionControl: true,
  pitchWithRotate: false,
  dragRotate: false,
  maxPitch: 0
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

function tintMap() {
  const style = map.getStyle();
  for (const layer of style.layers || []) {
    try {
      if (layer.type === 'background') map.setPaintProperty(layer.id, 'background-color', '#061009');
      if (layer.type === 'fill') {
        const id = layer.id.toLowerCase();
        map.setPaintProperty(layer.id, 'fill-color', id.includes('water') ? '#04130b' : '#0b2415');
        map.setPaintProperty(layer.id, 'fill-opacity', 0.86);
      }
      if (layer.type === 'line') {
        map.setPaintProperty(layer.id, 'line-color', '#245c37');
        map.setPaintProperty(layer.id, 'line-opacity', layer.id.toLowerCase().includes('road') ? 0.42 : 0.65);
      }
      if (layer.type === 'symbol') {
        map.setPaintProperty(layer.id, 'text-color', '#72ad82');
        map.setPaintProperty(layer.id, 'text-halo-color', '#061009');
        map.setPaintProperty(layer.id, 'text-halo-width', 1);
        if (map.getPaintProperty(layer.id, 'icon-opacity') !== undefined) map.setPaintProperty(layer.id, 'icon-opacity', 0.25);
      }
    } catch {}
  }
}

map.on('load', () => {
  state.mapReady = true;
  tintMap();
  fitRange(false);
  refreshAll();
});

function bboxForRadius(lat, lon, radiusNm) {
  const latDelta = radiusNm / 60;
  const lonDelta = radiusNm / (60 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  return [[lon - lonDelta, lat - latDelta], [lon + lonDelta, lat + latDelta]];
}
function fitRange(animate = true) {
  if (!state.mapReady) return;
  map.fitBounds(bboxForRadius(state.center.lat, state.center.lon, state.range), { padding: 54, duration: animate ? 500 : 0, maxZoom: 11 });
}
function setCenter(lat, lon, source = 'GPS') {
  state.center = { lat, lon, source };
  updateReadouts();
  fitRange(true);
  refreshAll();
}

function updateReadouts() {
  els.modeReadout.textContent = `MODE ${state.mode.toUpperCase()}`;
  els.rangeReadout.textContent = `RANGE ${state.range} NM`;
  els.positionReadout.textContent = `POS ${state.center.source}`;
  const ns = state.center.lat >= 0 ? 'N' : 'S';
  const ew = state.center.lon >= 0 ? 'E' : 'W';
  els.coords.textContent = `${Math.abs(state.center.lat).toFixed(4)} ${ns} / ${Math.abs(state.center.lon).toFixed(4)} ${ew}`;
  els.airCount.textContent = `AIR ${String(state.aircraft.length).padStart(3,'0')}`;
  els.milCount.textContent = `MIL ${String(state.aircraft.filter(a => a.military).length).padStart(3,'0')}`;
  els.shipCount.textContent = `SHIP ${String(state.vessels.length).padStart(3,'0')}`;
}

function markerKey(kind, id) { return `${kind}:${id}`; }
function clearMarkers() { for (const m of markers.values()) m.remove(); markers.clear(); }
function renderMarkers() {
  clearMarkers();
  for (const a of state.aircraft) {
    const el = document.createElement('button');
    el.className = `air-marker${a.military ? ' mil' : ''}`;
    el.type = 'button'; el.textContent = '▲'; el.title = a.callsign || a.registration || a.hex || 'Aircraft';
    el.style.border = '0'; el.style.background = 'transparent'; el.style.padding = '0';
    el.style.transform = `rotate(${Number(a.track || 0)}deg)`;
    el.addEventListener('click', () => showContact('aircraft', a));
    const m = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([a.lon, a.lat]).addTo(map);
    markers.set(markerKey('air', a.id), m);
  }
  for (const v of state.vessels) {
    const el = document.createElement('button');
    el.className = 'ship-marker'; el.type = 'button'; el.textContent = '◆'; el.title = v.name || v.mmsi || 'Vessel';
    el.style.border='0'; el.style.background='transparent'; el.style.padding='0'; el.style.transform=`rotate(${Number(v.course || 0)}deg)`;
    el.addEventListener('click', () => showContact('vessel', v));
    const m = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([v.lon, v.lat]).addTo(map);
    markers.set(markerKey('ship', v.id), m);
  }
  updateReadouts();
}

function fmt(v, suffix='') { return v === null || v === undefined || v === '' ? '—' : `${v}${suffix}`; }
function esc(s){return String(s ?? '').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function showContact(kind, d) {
  if (kind === 'aircraft') {
    const title = d.callsign || d.registration || d.hex || 'AIRCRAFT';
    const colour = d.military ? 'var(--mil)' : 'var(--civ)';
    els.contactPanel.innerHTML = `<div class="contact-title" style="color:${colour}"><strong>${esc(title)}</strong><span class="tag">${d.military ? 'MILITARY' : 'AIRCRAFT'}</span></div><div class="data-grid">
      <div class="datum"><small>TYPE</small><strong>${esc(d.type || d.description || '—')}</strong></div><div class="datum"><small>REGISTRATION</small><strong>${esc(d.registration || '—')}</strong></div><div class="datum"><small>ALTITUDE</small><strong>${fmt(d.altitude,' ft')}</strong></div><div class="datum"><small>GROUND SPEED</small><strong>${fmt(d.speed,' kt')}</strong></div><div class="datum"><small>TRACK</small><strong>${fmt(d.track,'°')}</strong></div><div class="datum"><small>SQUAWK</small><strong>${esc(d.squawk || '—')}</strong></div><div class="datum"><small>ICAO</small><strong>${esc(d.hex || '—')}</strong></div><div class="datum"><small>OPERATOR</small><strong>${esc(d.operator || '—')}</strong></div></div>`;
  } else {
    els.contactPanel.innerHTML = `<div class="contact-title" style="color:var(--ship)"><strong>${esc(d.name || d.mmsi || 'VESSEL')}</strong><span class="tag">VESSEL</span></div><div class="data-grid"><div class="datum"><small>MMSI</small><strong>${esc(d.mmsi || '—')}</strong></div><div class="datum"><small>SPEED</small><strong>${fmt(d.speed,' kt')}</strong></div><div class="datum"><small>COURSE</small><strong>${fmt(d.course,'°')}</strong></div><div class="datum"><small>HEADING</small><strong>${fmt(d.heading,'°')}</strong></div></div>`;
  }
}

async function fetchAircraft() {
  if (state.mode === 'vessels') { state.aircraft = []; return; }
  if (onStaticHostWithoutProxy()) throw new Error('proxy-required');
  const mode = state.mode === 'all' ? 'all' : state.mode;
  const u = apiUrl(`/api/aircraft?lat=${encodeURIComponent(state.center.lat)}&lon=${encodeURIComponent(state.center.lon)}&radius=${state.range}&mode=${mode}`);
  const r = await fetch(u, { headers: feedHeaders('adsb') });
  if (!r.ok) throw new Error(`aircraft-${r.status}`);
  const j = await r.json(); state.aircraft = j.aircraft || [];
  els.adsbFooter.textContent = `Aircraft: ${j.source || 'ADS-B feed'}`;
}
async function fetchVessels() {
  if (state.mode !== 'all' && state.mode !== 'vessels') { state.vessels = []; return; }
  if (!settings.aisKey) { state.vessels = []; els.aisFooter.textContent = 'AIS: add key in Settings'; return; }
  if (onStaticHostWithoutProxy()) { state.vessels = []; els.aisFooter.textContent = 'AIS: proxy URL required'; return; }
  const r = await fetch(apiUrl(`/api/vessels?lat=${encodeURIComponent(state.center.lat)}&lon=${encodeURIComponent(state.center.lon)}&radius=${state.range}`), { headers: feedHeaders('ais') });
  if (!r.ok) throw new Error(`vessels-${r.status}`);
  const j = await r.json(); state.vessels = j.vessels || [];
  els.aisFooter.textContent = `AIS: ${j.state || 'connected'}`;
}
async function refreshAll() {
  els.linkText.textContent='UPDATING';
  if (onStaticHostWithoutProxy()) {
    state.aircraft=[]; state.vessels=[]; renderMarkers();
    els.linkText.textContent='SET PROXY URL';
    els.adsbFooter.textContent='Aircraft: proxy URL required on GitHub Pages';
    return;
  }
  const results = await Promise.allSettled([fetchAircraft(), fetchVessels()]);
  renderMarkers();
  els.linkText.textContent = results.some(r => r.status === 'rejected') ? 'FEED DEGRADED' : 'TRACKING';
}

for (const btn of document.querySelectorAll('#filters button')) btn.addEventListener('click', () => {
  state.mode = btn.dataset.mode;
  document.querySelectorAll('#filters button').forEach(b => b.classList.toggle('active', b === btn));
  refreshAll(); updateReadouts();
});
els.rangeSelect.addEventListener('change', () => { state.range = Number(els.rangeSelect.value); updateReadouts(); fitRange(true); refreshAll(); });
document.getElementById('recenterBtn').addEventListener('click', () => { map.easeTo({ center:[state.center.lon,state.center.lat],duration:450 }); fitRange(true); });
document.getElementById('sweepBtn').addEventListener('click', e => { state.paused=!state.paused; els.sweep.classList.toggle('paused',state.paused); e.currentTarget.textContent=state.paused?'▶ RESUME SWEEP':'Ⅱ PAUSE SWEEP'; });
document.getElementById('locateBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return alert('Geolocation is not available in this browser.');
  navigator.geolocation.getCurrentPosition(p => setCenter(p.coords.latitude,p.coords.longitude,'GPS LOCK'), () => alert('Location permission was not granted.'), { enableHighAccuracy:true,timeout:10000,maximumAge:60000 });
});

function openSettings() {
  els.proxyUrlInput.value = settings.proxyUrl || '';
  els.aisKeyInput.value = settings.aisKey || '';
  els.adsbKeyInput.value = settings.adsbKey || '';
  els.settingsStatus.textContent = settings.aisKey || settings.proxyUrl || settings.adsbKey ? 'SAVED CONFIGURATION LOADED' : 'NO LOCAL KEYS SAVED';
  if (typeof els.settingsDialog.showModal === 'function') els.settingsDialog.showModal(); else els.settingsDialog.setAttribute('open','');
}
function closeSettings() { if (typeof els.settingsDialog.close === 'function') els.settingsDialog.close(); else els.settingsDialog.removeAttribute('open'); }
document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('closeSettingsBtn').addEventListener('click', closeSettings);
for (const b of document.querySelectorAll('[data-reveal]')) b.addEventListener('click', () => {
  const input = document.getElementById(b.dataset.reveal);
  const showing = input.type === 'text'; input.type = showing ? 'password' : 'text'; b.textContent = showing ? 'SHOW' : 'HIDE';
});
els.settingsForm.addEventListener('submit', e => {
  e.preventDefault();
  try {
    const proxy = els.proxyUrlInput.value.trim();
    if (proxy && !/^https?:\/\//i.test(proxy)) { els.settingsStatus.textContent='PROXY URL MUST START HTTP:// OR HTTPS://'; return; }
    saveSettings({ proxyUrl: proxy, aisKey: els.aisKeyInput.value.trim(), adsbKey: els.adsbKeyInput.value.trim() });
    els.settingsStatus.textContent='SAVED ON THIS DEVICE';
    els.aisFooter.textContent = settings.aisKey ? 'AIS: configured' : 'AIS: add key in Settings';
    setTimeout(() => { closeSettings(); refreshAll(); }, 350);
  } catch { els.settingsStatus.textContent='BROWSER STORAGE IS NOT AVAILABLE'; }
});
document.getElementById('clearSettingsBtn').addEventListener('click', () => {
  try { localStorage.removeItem(SETTINGS_KEY); } catch {}
  settings={...defaultSettings}; els.proxyUrlInput.value=''; els.aisKeyInput.value=''; els.adsbKeyInput.value=''; els.settingsStatus.textContent='SAVED KEYS CLEARED';
  state.vessels=[]; renderMarkers();
});

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstallPrompt=e; els.installBtn.textContent='⇩ INSTALL APP'; });
window.addEventListener('appinstalled', () => { deferredInstallPrompt=null; els.installBtn.textContent='✓ INSTALLED'; });
els.installBtn.addEventListener('click', async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt=null; return;
  }
  alert('To install: open your browser menu and choose “Install app” or “Add to Home screen”. On iPhone/iPad use Share → Add to Home Screen.');
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
updateReadouts();
els.aisFooter.textContent = settings.aisKey ? 'AIS: configured' : 'AIS: add key in Settings';
setInterval(refreshAll, 8000);

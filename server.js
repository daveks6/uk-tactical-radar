import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 8080);
const ADSB_BASE = 'https://api.adsb.lol/v2';
const MAX_RADIUS_NM = 250;
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);

app.disable('x-powered-by');
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && allowedOrigins.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-ADSB-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(root, { maxAge: '1h', extensions: ['html'] }));

const cache = new Map();
async function cachedJson(key, url, ttlMs = 4000) {
  const now = Date.now(), hit = cache.get(key);
  if (hit && now - hit.time < ttlMs) return hit.data;
  const response = await fetch(url, { headers: { 'user-agent': 'worldwide-tactical-radar/0.3' } });
  if (!response.ok) throw new Error(`Upstream ${response.status}`);
  const data = await response.json();
  cache.set(key, { time: now, data });
  return data;
}
function num(v, fallback = NaN) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function haversineNm(lat1, lon1, lat2, lon2) {
  const r = 3440.065, rad = d => d * Math.PI / 180, dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}
function normaliseAircraft(ac) {
  const lat = num(ac.lat), lon = num(ac.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { id: ac.hex || ac.icao || `${lat},${lon}`, hex: ac.hex || '', callsign: String(ac.flight || ac.callsign || '').trim(), registration: ac.r || ac.reg || '', type: ac.t || ac.type || '', description: ac.desc || '', operator: ac.ownOp || '', lat, lon, altitude: ac.alt_baro ?? ac.alt_geom ?? null, speed: ac.gs ?? null, track: ac.track ?? ac.true_heading ?? null, squawk: ac.squawk ?? '', military: false };
}
function inBounds(a, b) { return a.lat >= b.south && a.lat <= b.north && a.lon >= b.west && a.lon <= b.east; }

app.get('/api/aircraft', async (req, res) => {
  try {
    const bounds = { west: clamp(num(req.query.west), -180, 180), south: clamp(num(req.query.south), -90, 90), east: clamp(num(req.query.east), -180, 180), north: clamp(num(req.query.north), -90, 90) };
    if (Object.values(bounds).some(v => !Number.isFinite(v)) || bounds.west >= bounds.east || bounds.south >= bounds.north) return res.status(400).json({ error: 'valid west, south, east and north bounds are required' });
    const mode = ['all', 'military', 'civilian'].includes(req.query.mode) ? req.query.mode : 'all';
    const lat = (bounds.south + bounds.north) / 2, lon = (bounds.west + bounds.east) / 2;
    const radius = Math.ceil(haversineNm(lat, lon, bounds.north, bounds.east));
    if (radius > MAX_RADIUS_NM) return res.status(422).json({ error: 'visible region is too large; zoom in', maxRadiusNm: MAX_RADIUS_NM });
    const point = await cachedJson(`point:${lat.toFixed(2)}:${lon.toFixed(2)}:${radius}`, `${ADSB_BASE}/point/${lat}/${lon}/${Math.max(1, radius)}`);
    let aircraft = (point.ac || []).map(normaliseAircraft).filter(Boolean).filter(a => inBounds(a, bounds));
    const military = await cachedJson('military-global', `${ADSB_BASE}/mil`, 5000);
    const militaryHexes = new Set((military.ac || []).map(a => String(a.hex || '').toLowerCase()).filter(Boolean));
    aircraft = aircraft.map(a => ({ ...a, military: militaryHexes.has(String(a.hex).toLowerCase()) }));
    if (mode === 'military') aircraft = aircraft.filter(a => a.military);
    if (mode === 'civilian') aircraft = aircraft.filter(a => !a.military);
    res.json({ source: 'adsb.lol', mode, bounds, radius, aircraft });
  } catch (error) { res.status(502).json({ error: 'Aircraft feed unavailable', detail: String(error.message || error) }); }
});
app.get('/api/status', (_req, res) => res.json({ aircraft: 'adsb.lol', coverage: 'visible-region', maxRadiusNm: MAX_RADIUS_NM }));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Tactical Radar running on http://localhost:${PORT}`));

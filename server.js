import 'dotenv/config';
import express from 'express';
import { WebSocket } from 'ws';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 8080);
const ADSB_BASE = 'https://api.adsb.lol/v2';
const MAX_ADSB_RADIUS_NM = 250;
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);

app.disable('x-powered-by');
app.use((req,res,next)=>{
  const origin=req.headers.origin;
  if (allowedOrigins.includes('*')) res.setHeader('Access-Control-Allow-Origin','*');
  else if (origin && allowedOrigins.includes(origin)) res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, X-AISStream-Key, X-ADSB-Key');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

const cache = new Map();
async function cachedJson(key, url, ttlMs = 4000) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.time < ttlMs) return hit.data;
  const res = await fetch(url, { headers: { 'user-agent': 'uk-tactical-radar-pwa/0.2' } });
  if (!res.ok) throw new Error(`Upstream ${res.status}`);
  const data = await res.json(); cache.set(key, { time: now, data }); return data;
}
function num(v, fallback = NaN) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function haversineNm(lat1, lon1, lat2, lon2) {
  const rNm=3440.065,toRad=d=>d*Math.PI/180,dLat=toRad(lat2-lat1),dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*rNm*Math.asin(Math.sqrt(a));
}
function normaliseAircraft(ac, military = false) {
  const lat=num(ac.lat),lon=num(ac.lon); if(!Number.isFinite(lat)||!Number.isFinite(lon)) return null;
  return { id:ac.hex||ac.icao||`${lat},${lon}`,hex:ac.hex||'',callsign:String(ac.flight||ac.callsign||'').trim(),registration:ac.r||ac.reg||'',type:ac.t||ac.type||'',description:ac.desc||'',operator:ac.ownOp||'',lat,lon,altitude:ac.alt_baro??ac.alt_geom??null,speed:ac.gs??null,track:ac.track??ac.true_heading??null,squawk:ac.squawk??'',category:ac.category??'',seen:ac.seen??null,military };
}

app.get('/api/aircraft', async (req,res)=>{
  try{
    const lat=num(req.query.lat),lon=num(req.query.lon),radius=Math.max(1,Math.min(MAX_ADSB_RADIUS_NM,num(req.query.radius,100)));
    const mode=['all','military','civilian'].includes(req.query.mode)?req.query.mode:'all';
    if(!Number.isFinite(lat)||!Number.isFinite(lon)) return res.status(400).json({error:'lat and lon are required'});
    if(mode==='military'){
      const data=await cachedJson('military-global',`${ADSB_BASE}/mil`,5000);
      const aircraft=(data.ac||[]).map(a=>normaliseAircraft(a,true)).filter(Boolean).filter(a=>haversineNm(lat,lon,a.lat,a.lon)<=radius);
      return res.json({source:'adsb.lol',mode,radius,aircraft});
    }
    const point=await cachedJson(`point:${lat.toFixed(2)}:${lon.toFixed(2)}:${radius}`,`${ADSB_BASE}/point/${lat}/${lon}/${radius}`,4000);
    let aircraft=(point.ac||[]).map(a=>normaliseAircraft(a,false)).filter(Boolean);
    if(mode==='civilian'){
      const mil=await cachedJson('military-global',`${ADSB_BASE}/mil`,5000);
      const militaryHexes=new Set((mil.ac||[]).map(a=>String(a.hex||'').toLowerCase()).filter(Boolean));
      aircraft=aircraft.filter(a=>!militaryHexes.has(String(a.hex).toLowerCase()));
    }
    res.json({source:'adsb.lol',mode,radius,aircraft});
  }catch(err){res.status(502).json({error:'Aircraft feed unavailable',detail:String(err.message||err)});}
});

// One in-memory AIS subscription is maintained per unique user-supplied key.
// Keys are never logged or written to disk; the map is indexed by a SHA-256 fingerprint only.
const aisClients=new Map();
function keyFingerprint(key){return crypto.createHash('sha256').update(key).digest('hex');}
function newAisClient(key){
  const id=keyFingerprint(key);
  const client={id,key,state:'connecting',socket:null,vessels:new Map(),backoff:1000,lastUsed:Date.now(),timer:null};
  aisClients.set(id,client); connectAis(client); return client;
}
function storeAisMessage(client,msg){
  const type=msg?.MessageType,meta=msg?.MetaData||{},body=msg?.Message?.[type]||{};
  const mmsi=String(meta.MMSI||body.UserID||''),lat=num(meta.Latitude??body.Latitude),lon=num(meta.Longitude??body.Longitude);
  if(!mmsi||!Number.isFinite(lat)||!Number.isFinite(lon)) return;
  client.vessels.set(mmsi,{id:mmsi,mmsi,name:String(meta.ShipName||'').trim(),lat,lon,speed:body.Sog??null,course:body.Cog??null,heading:body.TrueHeading??null,messageType:type,updatedAt:Date.now()});
}
function connectAis(client){
  if(client.socket) return;
  client.state='connecting';
  const ws=new WebSocket('wss://stream.aisstream.io/v0/stream',{perMessageDeflate:true}); client.socket=ws;
  ws.on('open',()=>{
    client.state='live';client.backoff=1000;
    ws.send(JSON.stringify({APIKey:client.key,BoundingBoxes:[[[49.0,-11.5],[61.5,4.0]]],FilterMessageTypes:['PositionReport','StandardClassBPositionReport','ExtendedClassBPositionReport']}));
  });
  ws.on('message',data=>{try{storeAisMessage(client,JSON.parse(data.toString('utf8')));}catch{}});
  ws.on('error',()=>{client.state='error';});
  ws.on('close',()=>{
    client.socket=null; if(!aisClients.has(client.id)) return;
    client.state='reconnecting'; const delay=Math.min(30000,client.backoff+Math.floor(Math.random()*500)); client.backoff=Math.min(30000,client.backoff*2);
    clearTimeout(client.timer); client.timer=setTimeout(()=>connectAis(client),delay);
  });
}
function getAisClient(req){
  const supplied=String(req.headers['x-aisstream-key']||'').trim();
  const key=supplied||String(process.env.AISSTREAM_API_KEY||'').trim(); if(!key) return null;
  const id=keyFingerprint(key); const client=aisClients.get(id)||newAisClient(key); client.lastUsed=Date.now(); return client;
}
setInterval(()=>{
  const now=Date.now(),vesselCutoff=now-30*60*1000,clientCutoff=now-60*60*1000;
  for(const [id,c] of aisClients){
    for(const [mmsi,v] of c.vessels) if(v.updatedAt<vesselCutoff)c.vessels.delete(mmsi);
    if(c.lastUsed<clientCutoff){clearTimeout(c.timer);try{c.socket?.close();}catch{} aisClients.delete(id);}
  }
},60_000).unref();

app.get('/api/vessels',(req,res)=>{
  const lat=num(req.query.lat),lon=num(req.query.lon),radius=Math.max(1,Math.min(500,num(req.query.radius,100)));
  if(!Number.isFinite(lat)||!Number.isFinite(lon)) return res.status(400).json({error:'lat and lon are required'});
  const client=getAisClient(req); if(!client) return res.status(401).json({error:'AISStream API key required',state:'disabled',vessels:[]});
  const result=[...client.vessels.values()].filter(v=>haversineNm(lat,lon,v.lat,v.lon)<=radius);
  res.json({source:'aisstream.io',state:client.state,radius,vessels:result});
});
app.get('/api/status',(_req,res)=>res.json({aircraft:'adsb.lol',ais:'per-user-key',activeAisClients:aisClients.size}));
app.get('/health',(_req,res)=>res.json({ok:true}));
app.listen(PORT,()=>console.log(`Tactical Radar running on http://localhost:${PORT}`));

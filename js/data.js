export const ROOT = new URL('../', import.meta.url);
export const finite = value => typeof value === 'number' && Number.isFinite(value);
const validId = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

export function timestamp(value) {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/i.test(value)) return NaN;
  return Date.parse(value);
}

export function validateRegistry(doc) {
  if (!Array.isArray(doc.sensors) || !doc.sensors.length) throw new Error('Sensor registry is empty');
  const ids = new Set();
  for (const s of doc.sensors) {
    if (!validId.test(s.id) || ids.has(s.id)) throw new Error('Invalid or duplicate sensor ID');
    ids.add(s.id);
    if (typeof s.building !== 'string' || typeof s.floor !== 'string' ||
        !['x','y','z'].every(k => finite(s.position?.[k]))) throw new Error(`Invalid position: ${s.id}`);
  }
  return doc.sensors;
}

export function validateSnapshot(doc) {
  if (doc.schema_version !== 1 || !Array.isArray(doc.sensors) || !finite(timestamp(doc.updated_at)))
    throw new Error('Invalid live.json schema or timestamp');
  if (!['real','simulated'].includes(doc.source)) throw new Error('Snapshot source must be real or simulated');
  const seen = new Set();
  for (const row of doc.sensors) {
    if (!validId.test(row.sensor_id) || seen.has(row.sensor_id) || typeof row.online !== 'boolean')
      throw new Error('Invalid sensor ID or online status');
    seen.add(row.sensor_id);
    if (row.online && (!finite(timestamp(row.received_at)) || !finite(row.temperature) ||
        row.temperature < -80 || row.temperature > 100 || !finite(row.humidity) || row.humidity < 0 || row.humidity > 100))
      throw new Error(`Invalid reading: ${row.sensor_id}`);
  }
  if (doc.stale_after_seconds !== undefined && (!finite(doc.stale_after_seconds) || doc.stale_after_seconds < 1))
    throw new Error('Invalid expiry interval');
  if (doc.history) {
    if (doc.history.base !== `data/history/${doc.source}` || !Array.isArray(doc.history.months) ||
        !doc.history.months.every(m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m))) throw new Error('Invalid history index');
  }
  return doc;
}

export function historyRows(rows) {
  if (!Array.isArray(rows)) throw new Error('History must be an array');
  const unique = new Map();
  for (const row of rows) {
    const t = typeof row?.[0] === 'number' ? row[0] : timestamp(row?.[0]);
    if (!finite(t)) continue;
    if (row[1] === null && row[2] === null) unique.set(t, [t,null,null]);
    else if (finite(row[1]) && finite(row[2]) && row[1] >= -80 && row[1] <= 100 && row[2] >= 0 && row[2] <= 100)
      unique.set(t, [t,row[1],row[2]]);
  }
  return [...unique.values()].sort((a,b) => a[0]-b[0]);
}

export function lastAt(rows, time) {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const m = (lo+hi) >>> 1; if (rows[m][0] <= time) lo = m+1; else hi = m; }
  return lo ? rows[lo-1] : null;
}

export function readingAt(sensor, time, rows, snapshot, live = false, fallbackStale = 900) {
  const stale = Math.max(snapshot?.stale_after_seconds || fallbackStale, !live && snapshot?.source==='simulated'?4500:0) * 1000;
  if (live) {
    const v = snapshot?.sensors.find(v => v.sensor_id === sensor.id);
    const t = timestamp(v?.received_at);
    const published = timestamp(snapshot?.updated_at);
    const online = !!v?.online && finite(t) && finite(published) && time-t <= stale && time-published <= stale && t-time <= 300000;
    return {online, temperature: online ? v.temperature : null, humidity: online ? v.humidity : null,
            timestamp: finite(t) ? t : null, status: online ? thresholdStatus(sensor,v.temperature,v.humidity) : 'offline'};
  }
  const row = lastAt(rows,time);
  const online = !!row && row[1] !== null && row[2] !== null && time-row[0] <= stale;
  return {online, temperature: online ? row[1] : null, humidity: online ? row[2] : null,
          timestamp: row?.[0] ?? null, status: online ? thresholdStatus(sensor,row[1],row[2]) : 'offline'};
}

export function thresholdStatus(sensor, temperature, humidity) {
  let result = 'normal';
  for (const [key,value] of [['temperature',temperature],['humidity',humidity]]) {
    const t = sensor.thresholds?.[key] || (key === 'temperature' ? [10,18,27,35] : [15,30,65,85]);
    if (value < t[0] || value > t[3]) return 'critical';
    if (value < t[1] || value > t[2]) result = 'warning';
  }
  return result;
}

export function calendarStart(time, period) {
  const d = new Date(time);
  if (period === 'day') return time-86400000;
  if (period === 'week') { d.setDate(d.getDate()-7); return +d; }
  const day = d.getDate(); d.setDate(1);
  if (period === 'month') d.setMonth(d.getMonth()-1);
  else d.setFullYear(d.getFullYear()-1);
  const last = new Date(d.getFullYear(),d.getMonth()+1,0).getDate();
  d.setDate(Math.min(day,last));
  return +d;
}

export function monthKeys(start,end) {
  const d = new Date(start); d.setUTCDate(1); d.setUTCHours(0,0,0,0);
  const result = [];
  while (+d <= end && result.length < 120) { result.push(d.toISOString().slice(0,7)); d.setUTCMonth(d.getUTCMonth()+1); }
  return result;
}

const schoolTime = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',hour:'numeric',minute:'numeric',second:'numeric',hourCycle:'h23',weekday:'short'});
export function demoReading(sensor,time) {
  const parts = Object.fromEntries(schoolTime.formatToParts(time).map(p => [p.type,p.value]));
  const hour = +parts.hour + +parts.minute/60 + +parts.second/3600;
  const day = time/86400000;
  const seed = [...sensor.id].reduce((v,c,i) => v+(i+1)*c.charCodeAt(0),0);
  const phase = seed%19/19*Math.PI*2;
  const occupied = !['Sat','Sun'].includes(parts.weekday) && hour >= 7 && hour < 18;
  let temperature = 21.1+1.2*Math.sin((hour-10)/24*Math.PI*2)+0.65*Math.sin(day/365.2425*Math.PI*2-1.1)
    +(seed%7-3)*0.38+(occupied?0.9:-0.5)+0.22*Math.sin(day*11.3+phase)+0.1*Math.sin(day*37+phase);
  if (sensor.id.endsWith('004')) temperature += 4.5;
  const water = 8.9+0.55*Math.sin(day/9+phase)+(occupied?0.6:0);
  const saturation = 6.112*Math.exp(17.62*temperature/(243.12+temperature));
  const humidity = Math.max(22,Math.min(72,water*(273.15+temperature)/(216.7*saturation)*100));
  const online = !(sensor.id.endsWith('008') && Math.floor(time/1800000)%7 === 0);
  return {sensor_id:sensor.id,online,received_at:online?new Date(time).toISOString():null,
          temperature:online?+temperature.toFixed(2):null,humidity:online?+humidity.toFixed(2):null};
}

export function demoHistories(sensors,now) {
  const result = new Map(sensors.map(s => [s.id,[]]));
  const end = Math.floor(now/300000)*300000;
  const start = end-366*86400000;
  for (let t=start;t<=end;) {
    for (const s of sensors) {
      const v = demoReading(s,t);
      result.get(s.id).push([t,v.temperature,v.humidity]);
    }
    t += t < end-2*86400000 ? 3600000 : 300000;
  }
  return result;
}

function inferRepository(config) {
  let {owner,repo,branch='sensor-data'} = config.github || {};
  const host = location.hostname.toLowerCase();
  if (!owner && host.endsWith('.github.io')) {
    owner = host.slice(0,-10);
    repo = location.pathname.split('/').filter(Boolean)[0] || host;
  }
  if (!owner && !repo) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) ||
      !/^[A-Za-z0-9_./-]+$/.test(branch) || branch.includes('..')) throw new Error('Invalid GitHub configuration');
  return {owner,repo,branch};
}

export class DataStore extends EventTarget {
  constructor(sensors,config) {
    super(); this.sensors=sensors; this.config=config; this.mode='repo'; this.repo=inferRepository(config);
    this.snapshot=null; this.rows=new Map(sensors.map(s => [s.id,[]])); this.cache=new Map(); this.epoch=0;
    this.error=''; this.historyError=''; this.busy=false; this.lastCheck=null;
  }
  url(path,revision='') {
    const url = this.repo ? new URL(`https://raw.githubusercontent.com/${this.repo.owner}/${this.repo.repo}/${this.repo.branch.split('/').map(encodeURIComponent).join('/')}/${path}`) : new URL(path,ROOT);
    if (revision) url.searchParams.set('_',revision);
    return url;
  }
  async fetchJSON(url) {
    const response = await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(20000)});
    if (!response.ok) { const e = new Error(`HTTP ${response.status}`); e.status=response.status; throw e; }
    return response.json();
  }
  update() { this.dispatchEvent(new Event('update')); }
  async sync() {
    if (this.mode !== 'repo' || (this.busy && this.syncEpoch===this.epoch)) return;
    this.busy=true;
    const epoch=this.epoch; this.syncEpoch=epoch;
    try {
      const next=validateSnapshot(await this.fetchJSON(this.url('data/live.json',String(Math.floor(Date.now()/30000)))));
      if (this.epoch !== epoch) return;
      if (this.snapshot && next.source === this.snapshot.source && timestamp(next.updated_at)<timestamp(this.snapshot.updated_at)) return;
      if (next.source !== this.snapshot?.source) { this.rows=new Map(this.sensors.map(s => [s.id,[]])); this.cache.clear(); }
      const old=this.snapshot;
      this.snapshot=next; this.error=''; this.lastCheck=Date.now();
      for (const s of this.sensors) {
        const v=next.sensors.find(v => v.sensor_id===s.id);
        if (!v) continue;
        const prev=old?.sensors.find(v => v.sensor_id===s.id);
        const point=v.online?[timestamp(v.received_at),v.temperature,v.humidity]:prev?.online?[timestamp(next.updated_at),null,null]:null;
        if (point) this.rows.set(s.id,historyRows([...this.rows.get(s.id),point]));
      }
    } catch (e) {
      if (this.epoch !== epoch) return;
      if (e.status===404 && this.repo && !this.snapshot) {
        try {
          const initial=validateSnapshot(await this.fetchJSON(new URL('data/live.json',ROOT)));
          if (this.epoch===epoch) this.snapshot=initial;
        } catch { /* Keep the explicit offline initial state. */ }
        this.error='Waiting for the first Pi upload to sensor-data.';
      } else this.error=`Feed unavailable (${e.message}). Last readings expire automatically.`;
    } finally { if (this.syncEpoch===epoch) this.busy=false; if (this.epoch===epoch) this.update(); }
  }
  async ensureHistory(start,end) {
    if (this.mode !== 'repo' || !this.snapshot?.history) return;
    const epoch=this.epoch, meta=this.snapshot.history, source=this.snapshot.source;
    const months=monthKeys(start,end).filter(m => meta.months.includes(m));
    const current=new Date().toISOString().slice(0,7);
    let failed=false;
    for (const month of months) {
      const revision=month===current?meta.revision:'archived';
      const key=`${meta.base}/${month}`;
      if (this.cache.get(key)===revision || this.cache.get(key)==='loading') continue;
      const previous=this.cache.get(key); this.cache.set(key,'loading');
      try {
        const doc=await this.fetchJSON(this.url(`${key}.json`,revision));
        if (this.epoch!==epoch || this.snapshot?.source!==source) return;
        if (doc.source!==source || doc.month!==month || typeof doc.sensors!=='object') throw new Error('Invalid archive');
        const parsed=new Map();
        for (const s of this.sensors) if (doc.sensors[s.id]) parsed.set(s.id,historyRows(doc.sensors[s.id]));
        for (const [sid,rows] of parsed) this.rows.set(sid,historyRows([...this.rows.get(sid),...rows]));
        this.cache.set(key,revision);
      } catch (e) {
        if (this.epoch!==epoch || this.snapshot?.source!==source) return;
        if (previous) this.cache.set(key,previous); else this.cache.delete(key);
        failed=true; this.historyError=`Some history is unavailable (${e.message}).`;
      }
    }
    if (this.epoch===epoch) { if (!failed) this.historyError=''; this.update(); }
  }
  setMode(mode) {
    if (this.mode===mode) return;
    this.epoch++; this.mode=mode; this.error=''; this.historyError=''; this.cache.clear();
    this.snapshot=null; this.rows=new Map(this.sensors.map(s => [s.id,[]]));
    if (mode==='demo') { this.rows=demoHistories(this.sensors,Date.now()); this.tickDemo(); }
    else this.sync();
    this.update();
  }
  tickDemo() {
    if (this.mode!=='demo') return;
    const now=Date.now();
    this.snapshot={schema_version:1,source:'simulated',updated_at:new Date(now).toISOString(),stale_after_seconds:4500,
      gateway_id:'browser-demo',sensors:this.sensors.map(s => demoReading(s,now))};
    for (const s of this.sensors) {
      const v=this.snapshot.sensors.find(v => v.sensor_id===s.id);
      this.rows.set(s.id,historyRows([...this.rows.get(s.id),[now,v.temperature,v.humidity]]));
    }
    this.update();
  }
  reading(sensor,time,live) { return readingAt(sensor,time,this.rows.get(sensor.id)||[],this.snapshot,live,this.config.offlineAfterSeconds); }
}

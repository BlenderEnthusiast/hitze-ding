import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarStart,monthKeys,historyRows,lastAt,readingAt,validateSnapshot,demoReading,DataStore} from '../js/data.js';
const sensor={id:'ENV-001',thresholds:{temperature:[10,18,27,35],humidity:[15,30,65,85]}};
const now=Date.parse('2026-11-09T12:00:00Z');
const snapshot={schema_version:1,updated_at:'2026-11-09T12:00:00Z',source:'real',stale_after_seconds:900,sensors:[{sensor_id:sensor.id,online:true,received_at:'2026-11-09T12:00:00Z',temperature:22,humidity:45}]};
test('live readings expire even if the last online flag remains true',()=>{
  assert.equal(readingAt(sensor,now+899000,[],snapshot,true).online,true);
  const expired=readingAt(sensor,now+901000,[],snapshot,true);
  assert.equal(expired.online,false);assert.equal(expired.temperature,null);
});
test('a fresh gateway cannot renew an old sensor observation',()=>{
  const old=structuredClone(snapshot);old.sensors[0].received_at='2026-11-09T10:00:00Z';
  assert.equal(readingAt(sensor,now,[],old,true).online,false);
  const stopped=structuredClone(snapshot);stopped.updated_at='2026-11-09T10:00:00Z';
  assert.equal(readingAt(sensor,now,[],stopped,true).online,false);
});
test('history chooses the actual preceding sample and respects offline events',()=>{
  const rows=[[now,21,40],[now+300000,23,50],[now+400000,null,null]];
  assert.equal(readingAt(sensor,now+200000,rows,snapshot,false).temperature,21);
  assert.equal(readingAt(sensor,now-1,rows,snapshot,false).online,false);
  assert.equal(readingAt(sensor,now+400000,rows,snapshot,false).online,false);
  assert.deepEqual(lastAt(rows,now+300000),rows[1]);
});
test('history sorting, duplicate timestamps and invalid rows',()=>{
  const rows=historyRows([['2026-11-09T12:00:00Z',20,45],['2026-11-09T11:00:00Z',19,43],['2026-11-09T12:00:00Z',21,46],['2026-11-09T13:00:00',100,101]]);
  assert.equal(rows.length,2);assert.equal(rows[1][1],21);assert.ok(rows[0][0]<rows[1][0]);
});
test('malformed live snapshots never replace the last valid state',()=>{
  assert.equal(validateSnapshot(snapshot),snapshot);
  for(const change of [v=>v.sensors[0].humidity=101,v=>v.sensors[0].online='false',v=>v.sensors.push(v.sensors[0]),v=>v.source='unknown']){
    const v=structuredClone(snapshot);change(v);assert.throws(()=>validateSnapshot(v));
  }
});
test('calendar month and leap-year boundaries clamp to a valid day',()=>{
  const march=new Date(2026,2,31,12);const feb=new Date(calendarStart(+march,'month'));
  assert.equal(feb.getMonth(),1);assert.equal(feb.getDate(),28);
  const leap=new Date(calendarStart(+new Date(2024,1,29,12),'year'));assert.equal(leap.getDate(),28);
  assert.deepEqual(monthKeys(Date.parse('2025-12-31T23:00:00Z'),Date.parse('2026-02-01T00:00:00Z')),['2025-12','2026-01','2026-02']);
});
test('simulated values stay physically plausible through a year',()=>{
  const temperatures=[],humidity=[];
  for(let d=0;d<366;d+=3){const v=demoReading(sensor,now+d*86400000);assert.equal(v.online,true);assert.ok(v.temperature>15&&v.temperature<30);assert.ok(v.humidity>20&&v.humidity<75);temperatures.push(v.temperature);humidity.push(v.humidity);}
  assert.ok(Math.max(...temperatures)-Math.min(...temperatures)>1);
  assert.ok(Math.max(...humidity)-Math.min(...humidity)>3);
});
test('Pages repository is inferred and the data branch is read without credentials',()=>{
  globalThis.location={hostname:'blenderenthusiast.github.io',pathname:'/stratum/'};
  const store=new DataStore([sensor],{github:{branch:'sensor-data'}});
  assert.equal(store.url('data/live.json').href,'https://raw.githubusercontent.com/blenderenthusiast/stratum/sensor-data/data/live.json');
  globalThis.location={hostname:'example.org',pathname:'/'};
  const custom=new DataStore([sensor],{github:{owner:'someone',repo:'school',branch:'sensor-data'}});
  assert.equal(custom.url('data/live.json').href,'https://raw.githubusercontent.com/someone/school/sensor-data/data/live.json');
});
test('switching source while an archive loads cannot mix real and simulated history',async()=>{
  globalThis.location={hostname:'localhost',pathname:'/'};
  const store=new DataStore([sensor],{});
  store.snapshot={...snapshot,history:{base:'data/history/real',months:['2026-11'],revision:'r1'}};
  let resolve;
  store.fetchJSON=()=>new Promise(r=>{resolve=r;});
  const pending=store.ensureHistory(now-100000,now);
  store.snapshot={...snapshot,source:'simulated',history:{base:'data/history/simulated',months:[],revision:'r2'}};
  resolve({source:'real',month:'2026-11',sensors:{'ENV-001':[['2026-11-09T12:00:00Z',22,45]]}});
  await pending;assert.equal(store.rows.get(sensor.id).length,0);
});

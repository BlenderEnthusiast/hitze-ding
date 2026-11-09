import {ROOT,DataStore,validateRegistry,calendarStart,timestamp} from './data.js';
import {Viewer} from './viewer.js';
import {FloorPlanViewer} from './fallback.js';
import {drawGraph,drawTimeline,nearestSample,timelineTicks} from './charts.js';

const $=id=>document.getElementById(id),clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const set=(id,text)=>{const el=$(id);if(el.textContent!==text)el.textContent=text;};
const fmt=value=>Number.isFinite(value)?value.toFixed(1):'—';

async function initialize() {
  const [config,registry,catalog]=await Promise.all(['config/settings.json','data/sensors.json','models/manifest.json'].map(async path=>{
    const response=await fetch(new URL(path,ROOT));if(!response.ok)throw new Error(`${path}: HTTP ${response.status}`);return response.json();
  }));
  const sensors=validateRegistry(registry),store=new DataStore(sensors,config);
  let zone=config.timezone||'Europe/Berlin';try{new Intl.DateTimeFormat('en-GB',{timeZone:zone});}catch{zone='UTC';}
  const fullDate=new Intl.DateTimeFormat('en-GB',{timeZone:zone,day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const shortDate=new Intl.DateTimeFormat('en-GB',{timeZone:zone,day:'2-digit',month:'short'});
  const clock=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const state={scope:{},sensor:null,period:'day',start:calendarStart(Date.now(),'day'),end:Date.now(),time:Date.now(),live:true,playing:false,snap:false,hover:null,overlay:'off',follow:true};
  const visible=new Map(catalog.buildings.flatMap(b=>b.floors.map(f=>[`${b.id}/${f.id}`,true])));
  let viewer=null,historyKey='',tickStep=7200000,renderPending=false,sensorListKey='';
  const requestRender=()=>{if(renderPending)return;renderPending=true;requestAnimationFrame(()=>{renderPending=false;render();});};
  const selectedSensors=()=>sensors.filter(s=>(!state.scope.building||s.building===state.scope.building)&&(!state.scope.floor||s.floor===state.scope.floor)&&visible.get(`${s.building}/${s.floor}`)!==false);
  const stale=()=>Math.max(store.snapshot?.stale_after_seconds||config.offlineAfterSeconds||900,store.snapshot?.source==='simulated'?4500:0)*1000;
  const date=time=>Number.isFinite(time)?fullDate.format(time):'—';

  function ensureHistory() {
    const key=`${store.epoch}:${store.snapshot?.history?.base}:${store.snapshot?.history?.revision}:${Math.floor(state.start/900000)}:${Math.floor(state.end/900000)}`;
    if(key===historyKey)return;historyKey=key;store.ensureHistory(state.start,state.end);
  }
  function select(scope,sensor=null) {
    state.scope=scope;state.sensor=sensor;state.hover=null;
    viewer?.setScope(scope,sensor,visible);buildOutliner();requestRender();ensureHistory();
    requestAnimationFrame(()=>{$('inspector-scroll').scrollTop=0;});
  }
  try {viewer=new Viewer($('scene'),catalog,sensors,config,s=>select({building:s.building,floor:s.floor},s));viewer.setScope({},null,visible);}
  catch(e){
    const canvas=$('scene'),replacement=canvas.cloneNode();canvas.replaceWith(replacement);
    viewer=new FloorPlanViewer(replacement,catalog,sensors,config,s=>select({building:s.building,floor:s.floor},s),f=>select({building:f.building,floor:f.id}));
    viewer.setScope({},null,visible);
  }
  function toggleVisibility(keys) {
    const turnOn=keys.every(k=>visible.get(k)===false);for(const k of keys)visible.set(k,turnOn);
    viewer?.setScope(state.scope,state.sensor,visible);buildOutliner();requestRender();
  }
  function buildOutliner() {
    const root=$('outliner');root.replaceChildren();
    function row(name,depth,scope,keys,icon,count) {
      const selected=!state.sensor&&state.scope.building===scope.building&&state.scope.floor===scope.floor;
      const r=document.createElement('div');r.className=`tree-row depth${depth}${selected?' selected':''}`;r.tabIndex=0;r.setAttribute('role','button');
      r.setAttribute('aria-label',`Select ${name}`);r.setAttribute('aria-pressed',String(selected));
      r.innerHTML=`<span class="tree-chevron">${depth<2?'⌄':'·'}</span><span class="tree-icon">${icon}</span><span class="tree-name">${escape(name)}</span><span class="tree-count">${count}</span>`;
      const eye=document.createElement('button'),shown=keys.some(k=>visible.get(k)!==false);eye.className=`eye${shown?'':' off'}`;eye.textContent=shown?'◉':'○';eye.title=shown?'Hide geometry':'Show geometry';eye.setAttribute('aria-label',`${shown?'Hide':'Show'} ${name}`);eye.setAttribute('aria-pressed',String(shown));
      eye.addEventListener('click',e=>{e.stopPropagation();toggleVisibility(keys);});r.append(eye);
      r.addEventListener('click',()=>select(scope));r.addEventListener('keydown',e=>{if(e.target!==r)return;if(e.key==='Enter'){e.preventDefault();select(scope);}if(e.code==='Space'){e.preventDefault();toggleVisibility(keys);}});root.append(r);
    }
    row('All buildings',0,{},[...visible.keys()],'◇',catalog.buildings.length);
    for(const b of catalog.buildings) {
      row(b.id,1,{building:b.id},b.floors.map(f=>`${b.id}/${f.id}`),'▦',b.floors.length);
      for(const f of b.floors)row(f.id.replaceAll('_',' '),2,{building:b.id,floor:f.id},[`${b.id}/${f.id}`],'▱',sensors.filter(s=>s.building===b.id&&s.floor===f.id).length);
    }
  }
  set('floor-count',`${visible.size} FLOORS`);set('sensor-count',`${sensors.length} TOTAL`);buildOutliner();

  function metric(id,value,unit) {$(id).innerHTML=`${fmt(value)}<small> ${unit}</small>`;}
  function stats(id,values) {$(id).innerHTML=`<span><b>MIN</b>${fmt(values?.min)}</span><span><b>AVG</b>${fmt(values?.mean)}</span><span><b>MAX</b>${fmt(values?.max)}</span>`;}
  function render() {
    const time=state.live?Date.now():state.time;state.time=time;
    const values=new Map(sensors.map(s=>[s.id,store.reading(s,time,state.live)]));
    const included=selectedSensors(),fresh=included.map(s=>values.get(s.id)).filter(v=>v.online),online=sensors.filter(s=>values.get(s.id)?.online).length;
    const snapshot=store.snapshot,simulated=store.mode==='demo'||snapshot?.source==='simulated';
    const title=state.sensor?.name||state.sensor?.id||(state.scope.floor?state.scope.floor.replaceAll('_',' '):state.scope.building||'All buildings');
    const scopeLabel=state.scope.floor?`${state.scope.building} / ${state.scope.floor.replaceAll('_',' ')}`:state.scope.building||'All buildings';
    set('scope-breadcrumb',scopeLabel);set('scope-caption',state.scope.floor?scopeLabel.toUpperCase():state.scope.building?`${state.scope.building.toUpperCase()} OVERVIEW`:'CAMPUS OVERVIEW');
    set('geometry-caption',state.scope.floor?`${included.length} fixed sensor positions`:`${visible.size} floors · ${catalog.buildings.length} buildings`);
    set('selection-name',title);set('selection-kind',state.sensor?'SENSOR':state.scope.floor?'FLOOR':state.scope.building?'BUILDING':'CAMPUS');
    set('selection-detail',state.sensor?`${state.sensor.id} · ${state.sensor.building} / ${state.sensor.floor.replaceAll('_',' ')}${state.sensor.room?` · Room ${state.sensor.room}`:''}`:state.scope.floor?'Click a sensor marker or choose a sensor below.':`${included.length} sensors in this selection`);
    const value=state.sensor?values.get(state.sensor.id):null;
    const temperature=value?.temperature??(!state.sensor&&fresh.length?fresh.reduce((a,v)=>a+v.temperature,0)/fresh.length:null);
    const humidity=value?.humidity??(!state.sensor&&fresh.length?fresh.reduce((a,v)=>a+v.humidity,0)/fresh.length:null);
    metric('temperature-value',temperature,'°C');metric('humidity-value',humidity,'%');
    const status=state.sensor?value?.status:fresh.length?fresh.some(v=>v.status==='critical')?'critical':fresh.some(v=>v.status==='warning')?'warning':'normal':'offline';
    $('selection-status').className=`status-chip ${status}`;set('selection-status',state.sensor?(status==='normal'?'Online':status[0].toUpperCase()+status.slice(1)):`${fresh.length}/${included.length} online`);
    set('temperature-sub',state.sensor?(value?.online?'Latest received observation':'Sensor offline'):fresh.length?'Mean of online sensors':'No current readings');
    set('humidity-sub',state.sensor?(value?.online?'Latest received observation':'Sensor offline'):fresh.length?'Mean of online sensors':'No current readings');
    set('received',state.sensor?value?.timestamp?`${value.online?'Received':'Last sample'} · ${date(value.timestamp)}`:'No reading received for this sensor':snapshot?`Gateway update · ${date(timestamp(snapshot.updated_at))}`:'No gateway update received');
    $('sensor-detail').hidden=!state.sensor;$('scope-detail').hidden=!!state.sensor;
    if(state.sensor) {
      const rows=store.rows.get(state.sensor.id)||[];
      stats('temperature-stats',drawGraph($('temperature-chart'),rows,'temperature',state.start,state.end,time,state.hover,stale(),zone));
      stats('humidity-stats',drawGraph($('humidity-chart'),rows,'humidity',state.start,state.end,time,state.hover,stale(),zone));
      if(state.hover)set('sample-tooltip',`${date(state.hover[0])} · ${fmt(state.hover[1])} °C · ${fmt(state.hover[2])} % RH`);
      else set('sample-tooltip','Hover over a graph to inspect an actual sample.');
      if(value?.online&&humidity>0){const gamma=Math.log(humidity/100)+17.62*temperature/(243.12+temperature);set('dew-point',`Dew point ${fmt(243.12*gamma/(17.62-gamma))} °C · ${rows.filter(r=>r[0]>=state.start&&r[0]<=state.end&&r[1]!==null).length.toLocaleString()} observations in interval`);}
      else set('dew-point','A current temperature and humidity reading is needed for dew point.');
    } else {
      set('scope-sensor-count',String(included.length));const list=$('sensor-list');
      const signature=JSON.stringify(included.map(s=>[s.id,values.get(s.id)]));
      if(signature!==sensorListKey){sensorListKey=signature;list.replaceChildren();
      for(const s of included){const v=values.get(s.id),row=document.createElement('div');row.className='sensor-list-row';row.tabIndex=0;row.setAttribute('role','button');row.setAttribute('aria-label',`Inspect ${s.id}`);
        row.innerHTML=`<span class="status-dot ${v.status==='normal'?'':v.status}"></span><div>${escape(s.name||s.id)}<small>${escape(s.building)} · ${escape(s.floor.replaceAll('_',' '))}${s.room?` · ${escape(s.room)}`:''}</small></div><div class="sensor-list-values">${fmt(v.temperature)} °C<small>${fmt(v.humidity)} % RH</small></div>`;
        row.addEventListener('click',()=>select({building:s.building,floor:s.floor},s));row.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();select({building:s.building,floor:s.floor},s);}});list.append(row);
      }}
    }
    $('live').classList.toggle('active',state.live);$('live').setAttribute('aria-pressed',String(state.live));
    set('play',state.playing?'Ⅱ':'▷');$('play').setAttribute('aria-label',state.playing?'Pause history':'Play history');
    const rangeFormat=state.end-state.start>120*86400000?new Intl.DateTimeFormat('en-GB',{timeZone:zone,day:'2-digit',month:'short',year:'2-digit'}):shortDate;
    set('playhead-label',`${state.live?'NOW · ':''}${date(time)}`);set('range-label',`${rangeFormat.format(state.start)} — ${rangeFormat.format(state.end)}`);
    const timelineRows=state.sensor?store.rows.get(state.sensor.id)||[]:[];
    tickStep=drawTimeline($('timeline'),timelineRows,state.start,state.end,time,stale(),zone,state.live)||tickStep;
    set('timeline-source',simulated?(store.mode==='demo'?'SIMULATED · LOCAL DEMO':'SIMULATED · PUBLISHED TEST'):'REAL SENSOR OBSERVATIONS');
    set('inspector-source',simulated?'SIMULATED':state.live?'LIVE READINGS':'HISTORY');
    set('source-explanation',store.mode==='demo'?'Local demo · realistic simulated readings and one year of history. Nothing is uploaded from this mode.':snapshot?.source==='simulated'?'Published test feed · the sender is generating simulated observations. Change the sender to real sensor input when your hardware is ready.':'Repository feed · sensor observations update automatically. Missing or expired readings are marked offline.');
    $('data-label').innerHTML=`<span class="status-dot${online?'':' offline'}"></span>${simulated?(store.mode==='demo'?'SIMULATED / LOCAL':'SIMULATED / PI'):online?'LIVE SENSOR FEED':'NO ACTIVE SENSORS'}`;
    set('online-count',`${online} sensor${online===1?'':'s'} online`);
    const error=store.error||store.historyError;
    $('notice').hidden=!error&&store.mode!=='demo';$('notice').classList.toggle('error',!!error);
    set('notice',error||(store.mode==='demo'?'Local demo — all values and history in this mode are simulated.':'') );
    set('connection-status',store.mode==='demo'?'Local simulation · no upload':store.error?store.error:snapshot?`${snapshot.source==='simulated'?'Test feed':'Repository feed'} · ${online}/${sensors.length} online · checks every ${config.pollSeconds||30}s`:'Waiting for the first gateway update');
    set('clock',clock.format(Date.now()));set('scene-status',`${[...visible.values()].filter(Boolean).length}/${visible.size} floors visible`);
    viewer?.updateValues(values);viewer?.updateMap(state.overlay);
  }

  function setTime(time) {state.time=Math.min(Date.now(),time);state.live=false;state.hover=null;requestRender();}
  function resetRange() {state.end=Date.now();state.start=calendarStart(state.end,state.period);state.follow=true;historyKey='';ensureHistory();requestRender();}
  $('periods').addEventListener('click',e=>{const period=e.target.dataset.period;if(!period)return;state.period=period;for(const b of $('periods').querySelectorAll('button'))b.classList.toggle('active',b.dataset.period===period);resetRange();});
  $('source').addEventListener('change',()=>{state.live=true;state.playing=false;historyKey='';store.setMode($('source').value);resetRange();});
  $('refresh').addEventListener('click',()=>store.mode==='demo'?store.tickDemo():store.sync());
  $('overlay').addEventListener('change',()=>{state.overlay=$('overlay').value;requestRender();});
  $('live').addEventListener('click',()=>{state.live=true;state.playing=false;resetRange();});
  $('play').addEventListener('click',()=>{if(!state.playing&&state.live)setTime(state.start);state.playing=!state.playing;requestRender();});
  $('step-back').addEventListener('click',()=>setTime(state.time-(state.end-state.start)/100));
  $('step-forward').addEventListener('click',()=>setTime(state.time+(state.end-state.start)/100));
  $('snap').addEventListener('click',()=>{state.snap=!state.snap;$('snap').classList.toggle('active',state.snap);$('snap').setAttribute('aria-pressed',String(state.snap));});
  $('grid').addEventListener('click',()=>{const show=!$('grid').classList.contains('active');$('grid').classList.toggle('active',show);$('grid').setAttribute('aria-pressed',String(show));viewer?.toggleGrid(show);});
  $('frame').addEventListener('click',()=>viewer?.frame());
  for(const button of document.querySelectorAll('[data-view]'))button.addEventListener('click',()=>viewer?.view(button.dataset.view));
  $('help').addEventListener('click',()=>$('help-dialog').showModal());$('close-help').addEventListener('click',()=>$('help-dialog').close());
  window.addEventListener('keydown',e=>{
    if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)||$('help-dialog').open)return;
    if(e.code==='Home'){e.preventDefault();if(e.target===$('timeline'))resetRange();else viewer?.frame();}
    const axis={Numpad1:'front',Numpad3:'side',Numpad7:'top'}[e.code];if(axis){e.preventDefault();viewer?.view(axis);}
    if(e.code==='Numpad5'){e.preventDefault();viewer?.toggleProjection();}
    if(e.code==='NumpadDecimal'&&state.sensor){e.preventDefault();viewer?.focusSensor(state.sensor);}
  });
  let drag=null;
  const timeline=$('timeline');
  const timeAt=(e,canvas=timeline,left=16,right=16)=>{const rect=canvas.getBoundingClientRect();return state.start+clamp((e.clientX-rect.left-left)/(rect.width-left-right),0,1)*(state.end-state.start);};
  const seek=e=>{let time=timeAt(e);if(state.snap)time=Math.round(time/tickStep)*tickStep;setTime(time);};
  timeline.addEventListener('contextmenu',e=>e.preventDefault());
  timeline.addEventListener('pointerdown',e=>{timeline.setPointerCapture(e.pointerId);drag={x:e.clientX,start:state.start,end:state.end,pan:e.button!==0};if(!drag.pan)seek(e);});
  timeline.addEventListener('pointermove',e=>{if(!drag)return;if(drag.pan){const shift=(e.clientX-drag.x)/(timeline.clientWidth-32)*(drag.end-drag.start);state.start=drag.start-shift;state.end=drag.end-shift;state.follow=false;requestRender();}else seek(e);});
  const endDrag=()=>{if(drag){drag=null;ensureHistory();}};timeline.addEventListener('pointerup',endDrag);timeline.addEventListener('pointercancel',endDrag);
  timeline.addEventListener('wheel',e=>{e.preventDefault();const anchor=timeAt(e),oldSpan=state.end-state.start,newSpan=clamp(oldSpan*Math.exp(e.deltaY*.0015),3600000,366*86400000);state.start=anchor-(anchor-state.start)/oldSpan*newSpan;state.end=state.start+newSpan;state.follow=false;requestRender();clearTimeout(timeline.loadTimeout);timeline.loadTimeout=setTimeout(ensureHistory,300);},{passive:false});
  for(const id of ['temperature-chart','humidity-chart']) {
    $(id).addEventListener('pointermove',e=>{if(!state.sensor)return;state.hover=nearestSample(store.rows.get(state.sensor.id)||[],timeAt(e,$(id),29,6));requestRender();});
    $(id).addEventListener('pointerleave',()=>{state.hover=null;requestRender();});
    $(id).addEventListener('click',()=>{if(state.hover)setTime(state.hover[0]);});
  }

  let layout={};try{layout=JSON.parse(localStorage.getItem('stratum-layout')||'{}');}catch{}
  const variables={'--right-width':[288,650],'--timeline-height':[158,500],'--outliner-height':[130,550]};
  for(const [key,value] of Object.entries(layout))if(variables[key]&&Number.isFinite(value))document.documentElement.style.setProperty(key,`${clamp(value,...variables[key])}px`);
  function splitter(id,property,read) {
    const el=$(id);let active=false;
    function apply(value){const [min,max]=variables[property];layout[property]=clamp(value,min,max);document.documentElement.style.setProperty(property,`${layout[property]}px`);requestRender();}
    el.addEventListener('pointerdown',e=>{active=true;el.setPointerCapture(e.pointerId);document.body.classList.add('resizing');});
    el.addEventListener('pointermove',e=>{if(active)apply(read(e));});
    const finish=()=>{if(!active)return;active=false;document.body.classList.remove('resizing');try{localStorage.setItem('stratum-layout',JSON.stringify(layout));}catch{}};
    el.addEventListener('pointerup',finish);el.addEventListener('pointercancel',finish);
    el.addEventListener('keydown',e=>{const delta=['ArrowRight','ArrowDown'].includes(e.key)?20:['ArrowLeft','ArrowUp'].includes(e.key)?-20:0;if(!delta)return;e.preventDefault();apply(parseFloat(getComputedStyle(document.documentElement).getPropertyValue(property))+delta);});
  }
  splitter('main-split','--right-width',e=>Math.min(innerWidth-400,innerWidth-e.clientX));
  splitter('timeline-split','--timeline-height',e=>$('left-pane').getBoundingClientRect().bottom-e.clientY);
  splitter('inspector-split','--outliner-height',e=>e.clientY-$('right-pane').getBoundingClientRect().top);
  new ResizeObserver(requestRender).observe($('workspace'));
  store.addEventListener('update',()=>{ensureHistory();requestRender();});
  await store.sync();requestRender();
  setInterval(()=>{if(store.mode==='repo')store.sync();else store.tickDemo();},Math.max(10,config.pollSeconds||30)*1000);
  setInterval(()=>{if(state.live&&state.follow){state.end=Date.now();state.start=calendarStart(state.end,state.period);}requestRender();},1000);
  let previous=performance.now();
  function playback(now){const elapsed=Math.min(200,now-previous);previous=now;if(state.playing){state.live=false;state.time+=elapsed*+$('speed').value;if(state.time>=Math.min(state.end,Date.now())){state.time=Math.min(state.end,Date.now());state.playing=false;}requestRender();}requestAnimationFrame(playback);}
  requestAnimationFrame(playback);
}

initialize().catch(e=>{console.error('Stratum startup:',e);$('notice').hidden=false;$('notice').classList.add('error');$('notice').textContent=`Could not start Stratum: ${e.message}. Serve the complete folder over HTTP or GitHub Pages.`;$('connection-status').textContent='Application setup needs attention';});

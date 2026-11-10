export function overlayPlan(metric,floors,sensors,values) {
  const layers=metric==='off'?[]:floors.filter(f=>f.map).map(floor=>({floor,sites:sensors
    .filter(s=>s.building===floor.building&&s.floor===floor.id&&values.get(s.id)?.online)
    .map(s=>({x:s.position.x,z:-s.position.y,value:values.get(s.id)[metric]}))})).filter(l=>l.sites.length);
  const readings=layers.flatMap(l=>l.sites.map(s=>s.value));
  return {metric,layers,min:readings.length?Math.min(...readings):null,max:readings.length?Math.max(...readings):null};
}

export function legend(plan,message) {
  const get=id=>document.getElementById(id),humidity=plan.metric==='humidity';
  get('map-legend').hidden=plan.metric==='off';
  get('legend-title').textContent=humidity?'REL. HUMIDITY':'TEMPERATURE';
  get('legend-ramp').classList.toggle('humidity',humidity);
  const unit=humidity?' %':' °C';
  get('legend-low').textContent=plan.min===null?'—':plan.min.toFixed(1)+unit;
  get('legend-high').textContent=plan.max===null?'—':plan.max.toFixed(1)+unit;
  get('map-note').textContent=message;
}

export class FloorOverlays {
  constructor(worker,result,remove,status) {
    this.worker=worker;this.result=result;this.remove=remove;this.status=status;
    this.entries=new Map();this.sequence=0;
    worker.onmessage=({data})=>{
      const entry=[...this.entries.values()].find(e=>e.id===data.id);
      if(!entry)return;
      entry.pending=false;
      if(data.error){entry.error=data.error;entry.signature='';this.remove(entry.key);}
      else {entry.approximate=!data.converged;this.result(data,entry);}
      this.report();
    };
  }
  clear(){for(const key of this.entries.keys())this.remove(key);this.entries.clear();}
  report(){
    if(!this.plan)return;
    const entries=[...this.entries.values()];
    const error=entries.find(e=>e.error)?.error;
    const message=error?`Map unavailable: ${error}`:entries.some(e=>e.pending)?'Preparing visible floor overlays…':
      !entries.length?'No fresh readings on visible floors.':`${entries.length} floor overlay${entries.length===1?'':'s'} · ${entries.some(e=>e.approximate)?'approximate solve':'wall-aware spatial estimate'}`;
    this.status(this.plan,message);
  }
  update(metric,floors,sensors,values,load,ratios) {
    this.plan=overlayPlan(metric,floors,sensors,values);
    const wanted=new Set(this.plan.layers.map(l=>l.floor.key));
    for(const key of this.entries.keys())if(!wanted.has(key)){this.remove(key);this.entries.delete(key);}
    for(const {floor,sites} of this.plan.layers){
      const signature=JSON.stringify([metric,sites,this.plan.min,this.plan.max]);
      if(this.entries.get(floor.key)?.signature===signature)continue;
      const entry={id:++this.sequence,key:floor.key,metric,min:this.plan.min,max:this.plan.max,signature,pending:true};
      this.entries.set(floor.key,entry);
      Promise.resolve().then(()=>load(floor)).then(map=>{
        if(this.entries.get(floor.key)!==entry)return;
        entry.map=map;
        this.worker.postMessage({id:entry.id,map,sites,metric,ratio:ratios?.[metric]||.035});
      }).catch(e=>{
        if(this.entries.get(floor.key)!==entry)return;
        entry.pending=false;entry.error=e.message;entry.signature='';this.remove(entry.key);this.report();
      });
    }
    this.report();
  }
}

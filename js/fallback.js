import {ROOT} from './data.js';
import {decodeRLE,ramp} from './field.js';
import {FloorOverlays,legend} from './overlays.js';
import {CAMERA_DURATION_MS,WHEEL_SENSITIVITY,easeInOut,dampZoom,wheelPixels,reducedMotion} from './motion.js';
const $=id=>document.getElementById(id);
const colors={normal:'#9cdbbd',warning:'#dfbb74',critical:'#ed877f',offline:'#77848e'};

// Canvas floor plans keep the monitor usable when WebGL2 is unavailable.
export class FloorPlanViewer {
  constructor(canvas,catalog,sensors,config,onSelect,onFloor) {
    this.canvas=canvas;this.ctx=canvas.getContext('2d');this.sensors=sensors;this.config=config;this.onSelect=onSelect;this.onFloor=onFloor;
    this.floors=catalog.buildings.flatMap(b=>b.floors.map(f=>({...f,building:b.id,key:`${b.id}/${f.id}`})));
    this.cache=new Map();this.scope={};this.visible=new Map();this.values=new Map();this.zoom=1;this.pan=[0,0];this.metric='off';this.job=0;this.grid=true;this.cards=[];this.hits=[];
    this.worker=new Worker(new URL('./heatmap-worker.js',import.meta.url),{type:'module'});
    this.overlayCanvases=new Map();
    this.overlays=new FloorOverlays(this.worker,(r,e)=>this.mapResult(r,e),key=>{this.overlayCanvases.delete(key);this.draw();},legend);
    this.worker.onerror=()=>{$('map-note').textContent='Map worker unavailable.';};
    $('viewport-title').textContent='Floor plan';canvas.setAttribute('aria-label','Interactive top-down floor plan');
    document.querySelector('.gizmo').hidden=true;
    document.querySelector('.viewport-hint').textContent='Click a floor to select · Click a sensor to inspect · Scroll to zoom · Middle drag to pan';
    $('scene-loading').classList.remove('error');$('scene-loading').textContent='2D floor plan · 3D unavailable in this browser';
    let drag=null;
    canvas.addEventListener('contextmenu',e=>e.preventDefault());
    canvas.addEventListener('pointerdown',e=>{this.viewMotion=null;this.zoomGoal=null;drag={x:e.clientX,y:e.clientY,pan:[...this.pan],button:e.button};canvas.setPointerCapture(e.pointerId);});
    canvas.addEventListener('pointermove',e=>{if(drag&&drag.button!==0){this.pan=[drag.pan[0]+e.clientX-drag.x,drag.pan[1]+e.clientY-drag.y];this.draw();}});
    canvas.addEventListener('pointerup',e=>{
      if(!drag)return;const click=drag.button===0&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<5;drag=null;if(!click)return;
      const rect=canvas.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;
      const hit=this.hits.find(h=>Math.hypot(x-h.x,y-h.y)<18);
      if(hit){this.onSelect(hit.sensor);return;}
      const card=this.cards.find(c=>x>=c.x&&x<=c.x+c.w&&y>=c.y&&y<=c.y+c.h);if(card)this.onFloor?.(card.floor);
    });
    canvas.addEventListener('pointercancel',()=>{drag=null;});
    canvas.addEventListener('wheel',e=>{
      e.preventDefault();this.viewMotion=null;
      this.zoomGoal=Math.max(.5,Math.min(5,(this.zoomGoal??this.zoom)*Math.exp(-wheelPixels(e,canvas.clientHeight)*WHEEL_SENSITIVITY)));
      if(reducedMotion()){this.zoom=this.zoomGoal;this.zoomGoal=null;this.draw();}
      else this.requestMotion();
    },{passive:false});
    new ResizeObserver(()=>this.draw()).observe(canvas.parentElement);
  }
  setScope(scope,selected,visible) {
    const changed=this.scope.building!==scope.building||this.scope.floor!==scope.floor;
    this.scope=scope;this.selected=selected;this.visible=visible;
    this.desired=this.floors.filter(f=>(!scope.building||f.building===scope.building)&&(!scope.floor||f.id===scope.floor)&&visible.get(f.key)!==false);
    if(changed){this.frame();this.overlays.clear();}
    for(const f of this.desired)this.load(f);
    this.draw();
  }
  async load(floor) {
    if(this.cache.has(floor.key))return;
    this.cache.set(floor.key,null);
    if(!floor.map){this.draw();return;}
    try {
      const response=await fetch(new URL(floor.map.split('/').map(encodeURIComponent).join('/'),ROOT));if(!response.ok)throw new Error('Floor plan unavailable');
      const map=await response.json(),size=map.cols*map.rows,mask=decodeRLE(map.domain_rle,size),walls=decodeRLE(map.walls_rle,size);
      const canvas=document.createElement('canvas');canvas.width=map.cols;canvas.height=map.rows;
      const ctx=canvas.getContext('2d'),image=ctx.createImageData(map.cols,map.rows);
      for(let i=0;i<size;i++)if(mask[i])image.data.set(walls[i]?[175,189,188,255]:[64,79,83,255],i*4);
      ctx.putImageData(image,0,0);this.cache.set(floor.key,{map,canvas});this.signature='';this.draw();this.updateMap(this.metric);
    }catch(e){this.cache.set(floor.key,{error:e.message});this.draw();}
  }
  frame(){
    this.zoomGoal=null;
    if(reducedMotion()){this.zoom=1;this.pan=[0,0];this.viewMotion=null;this.draw();return;}
    this.viewMotion={start:performance.now(),zoom:this.zoom,pan:[...this.pan]};this.requestMotion();
  }
  requestMotion(){
    if(this.motionPending)return;
    this.motionPending=true;let previous=performance.now();
    const step=now=>{
      const elapsed=Math.min(64,Math.max(0,now-previous));previous=now;
      if(this.viewMotion){
        const m=this.viewMotion,p=Math.min(1,Math.max(0,(now-m.start)/CAMERA_DURATION_MS)),t=easeInOut(p);
        this.zoom=Math.exp(Math.log(m.zoom)*(1-t));this.pan=m.pan.map(v=>v*(1-t));
        if(p===1){this.zoom=1;this.pan=[0,0];this.viewMotion=null;}
      }else if(this.zoomGoal!==null&&this.zoomGoal!==undefined){
        this.zoom=dampZoom(this.zoom,this.zoomGoal,elapsed);if(this.zoom===this.zoomGoal)this.zoomGoal=null;
      }
      this.draw();
      if(this.viewMotion||this.zoomGoal!=null)requestAnimationFrame(step);else this.motionPending=false;
    };
    requestAnimationFrame(step);
  }
  focusSensor(){this.draw();}
  view(){this.frame();}
  toggleProjection(){}
  toggleGrid(value){this.grid=value;this.draw();}
  updateValues(values){this.values=values;this.draw();}
  updateMap(metric) {
    this.metric=metric;$('scene-loading').hidden=metric!=='off';
    this.overlays.update(metric,this.desired||[],this.sensors,this.values,async floor=>{
      const prepared=this.cache.get(floor.key);
      if(prepared?.map)return prepared.map;
      const response=await fetch(new URL(floor.map.split('/').map(encodeURIComponent).join('/'),ROOT));
      if(!response.ok)throw new Error('Floor raster not found');return response.json();
    },this.config.wallConductivity);
  }
  mapResult(result,j) {
    const canvas=document.createElement('canvas');canvas.width=j.map.cols;canvas.height=j.map.rows;
    const ctx=canvas.getContext('2d'),image=ctx.createImageData(canvas.width,canvas.height);
    for(let i=0;i<result.field.length;i++)if(Number.isFinite(result.field[i])){const t=j.max-j.min>1e-9?(result.field[i]-j.min)/(j.max-j.min):.5;image.data.set([...ramp(t,j.metric),Math.round(255*(this.config.mapOpacity||.58))],i*4);}
    ctx.putImageData(image,0,0);this.overlayCanvases.set(j.key,canvas);
    this.draw();
  }
  draw() {
    const canvas=this.canvas,ctx=this.ctx;if(!ctx)return;
    const w=canvas.clientWidth,h=canvas.clientHeight,dpr=Math.min(devicePixelRatio||1,2);if(!w||!h)return;
    if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);this.hits=[];this.cards=[];
    if(this.grid){ctx.strokeStyle='#35434a60';ctx.lineWidth=.7;for(let x=0;x<w;x+=32){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}for(let y=0;y<h;y+=32){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}}
    const floors=this.desired||[],cols=floors.length>1&&w>550?2:1,rows=Math.max(1,Math.ceil(floors.length/cols));
    const cw=Math.min((w-70)/cols,650),ch=Math.min((h-115)/rows,430),left=(w-cw*cols)/2,top=(h-ch*rows)/2-7;
    floors.forEach((floor,i)=>{
      const x=left+(i%cols)*cw+13,y=top+Math.floor(i/cols)*ch+12,bw=cw-26,bh=ch-24;
      this.cards.push({x,y,w:bw,h:bh,floor});
      ctx.fillStyle='#1b2429';ctx.strokeStyle='#4b5b604f';ctx.lineWidth=1;ctx.fillRect(x,y,bw,bh);ctx.strokeRect(x,y,bw,bh);
      ctx.fillStyle='#91aaa5';ctx.font='10px "Segoe UI",sans-serif';ctx.textAlign='center';ctx.fillText(`${floor.building.toUpperCase()}  /  ${floor.id.replaceAll('_',' ').toUpperCase()}`,x+bw/2,y+22);ctx.textAlign='left';
      const prepared=this.cache.get(floor.key);if(!prepared?.map){ctx.fillStyle='#758e98';ctx.fillText(prepared?.error||'Preparing floor plan…',x+20,y+bh/2);return;}
      const {map}=prepared,scale=Math.min((bw-55)/map.cols,(bh-68)/map.rows)*this.zoom;
      const px=x+bw/2-map.cols*scale/2+this.pan[0],py=y+bh/2-map.rows*scale/2+12+this.pan[1];
      ctx.save();ctx.beginPath();ctx.rect(x+2,y+32,bw-4,bh-34);ctx.clip();ctx.imageSmoothingEnabled=true;
      ctx.drawImage(prepared.canvas,px,py,map.cols*scale,map.rows*scale);
      if(this.overlayCanvases.has(floor.key))ctx.drawImage(this.overlayCanvases.get(floor.key),px,py,map.cols*scale,map.rows*scale);
      for(const s of this.sensors.filter(s=>s.building===floor.building&&s.floor===floor.id)) {
        const sx=px+((s.position.x-map.origin[0])/map.step+.5)*scale,sy=py+((-s.position.y-map.origin[1])/map.step+.5)*scale;
        const value=this.values.get(s.id),color=colors[value?.status||'offline'];this.hits.push({sensor:s,x:sx,y:sy});
        ctx.strokeStyle=color;ctx.lineWidth=2;ctx.fillStyle='#1c2a2a';ctx.beginPath();ctx.arc(sx,sy,this.selected?.id===s.id?10:8,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle=color;ctx.beginPath();ctx.arc(sx,sy,3,0,Math.PI*2);ctx.fill();
        ctx.font='10px "Segoe UI",sans-serif';ctx.fillStyle='#182428e8';const label=`${s.id}${value?.online?` · ${value.temperature.toFixed(1)}°`:''}`,width=ctx.measureText(label).width;ctx.fillRect(sx+14,sy-9,width+12,20);ctx.fillStyle=color;ctx.fillText(label,sx+20,sy+5);
      }
      ctx.restore();
    });
  }
}

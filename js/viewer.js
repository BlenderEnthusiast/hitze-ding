import * as THREE from '../vendor/three/three.module.js';
import {OrbitControls} from '../vendor/three/addons/controls/OrbitControls.js';
import {GLTFLoader} from '../vendor/three/addons/loaders/GLTFLoader.js';
import {ROOT} from './data.js';
import {ramp} from './field.js';
import {FloorOverlays,legend} from './overlays.js';
import {CAMERA_DURATION_MS,WHEEL_SENSITIVITY,easeInOut,dampZoom,wheelPixels,reducedMotion} from './motion.js';

const asset=path=>new URL(path.split('/').map(encodeURIComponent).join('/'),ROOT);
const colors={normal:0x9cdbbd,warning:0xdfbb74,critical:0xef887f,offline:0x77848e};
function dispose(root) {
  const geometries=new Set(),materials=new Set(),textures=new Set();
  root.traverse(o=>{
    if(o.geometry) geometries.add(o.geometry);
    for(const m of o.material?(Array.isArray(o.material)?o.material:[o.material]):[]) {
      materials.add(m); for(const v of Object.values(m)) if(v?.isTexture) textures.add(v);
    }
  });
  for(const t of textures) t.dispose(); for(const m of materials) m.dispose(); for(const g of geometries) g.dispose();
}

export class Viewer {
  constructor(canvas,catalog,sensors,config,onSelect) {
    this.canvas=canvas;this.sensors=sensors;this.config=config;this.onSelect=onSelect;
    this.floors=catalog.buildings.flatMap(b=>b.floors.map(f=>({...f,building:b.id,key:`${b.id}/${f.id}`})));
    this.loaded=new Map();this.pending=new Set();this.failures=new Set();this.desired=new Set();this.mapCache=new Map();
    this.scope={};this.selected=null;this.values=new Map();this.dirty=true;this.job=0;this.mapSignature='';this.metric='off';
    this.scene=new THREE.Scene();this.scene.fog=new THREE.FogExp2(0x242d32,0.004);
    const context=canvas.getContext('webgl2',{antialias:true,alpha:true,powerPreference:'high-performance'});
    if(!context)throw new Error('WebGL2 is unavailable');
    this.renderer=new THREE.WebGLRenderer({canvas,context,antialias:true,alpha:true,powerPreference:'high-performance'});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.18;
    this.perspective=new THREE.PerspectiveCamera(40,1,0.025,10000);
    this.orthographic=new THREE.OrthographicCamera(-10,10,10,-10,0.025,10000);
    this.camera=this.perspective;this.camera.position.set(29,27,32);this.makeControls();
    canvas.addEventListener('wheel',event=>{
      event.preventDefault();event.stopImmediatePropagation();
      this.queueZoom(wheelPixels(event,canvas.clientHeight));
    },{capture:true,passive:false});
    canvas.addEventListener('pointerdown',()=>{this.flight=null;this.wheelZoom=null;},{capture:true});
    this.scene.add(new THREE.HemisphereLight(0xe6efff,0x72786a,2.6));
    const sun=new THREE.DirectionalLight(0xfff0dd,3.2);sun.position.set(-15,30,15);this.scene.add(sun);
    const fill=new THREE.DirectionalLight(0xafcfe8,1.5);fill.position.set(20,15,-20);this.scene.add(fill);
    this.grid=new THREE.GridHelper(100,100,0x546661,0x3e4b51);this.grid.material.transparent=true;this.grid.material.opacity=.34;this.grid.position.y=-.3;this.scene.add(this.grid);
    this.axes=new THREE.AxesHelper(2);this.axes.position.set(0,-.28,0);this.scene.add(this.axes);
    this.markers=new THREE.Group();this.scene.add(this.markers);this.markerObjects=new Map();this.labels=new Map();
    const dot=document.createElement('canvas');dot.width=128;dot.height=128;
    const ctx=dot.getContext('2d');ctx.strokeStyle='#fff';ctx.lineWidth=9;ctx.beginPath();ctx.arc(64,64,42,0,Math.PI*2);ctx.stroke();ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(64,64,15,0,Math.PI*2);ctx.fill();
    this.markerTexture=new THREE.CanvasTexture(dot);
    for(const sensor of sensors) {
      const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:this.markerTexture,color:colors.offline,depthTest:false,depthWrite:false,transparent:true}));
      const p=sensor.position;sprite.position.set(p.x,p.z,-p.y);sprite.scale.set(.5,.5,.5);sprite.userData.sensor=sensor;sprite.renderOrder=20;this.markers.add(sprite);this.markerObjects.set(sensor.id,sprite);
      const label=document.createElement('div');label.className='sensor-label';label.hidden=true;label.textContent=sensor.id;document.querySelector('#sensor-labels').append(label);this.labels.set(sensor.id,label);
    }
    this.loader=new GLTFLoader();this.raycaster=new THREE.Raycaster();
    let down=null;
    canvas.addEventListener('pointerdown',e=>{down={x:e.clientX,y:e.clientY,button:e.button};});
    canvas.addEventListener('pointerup',e=>{
      if(!down||down.button!==0||Math.hypot(e.clientX-down.x,e.clientY-down.y)>5) return;
      const rect=canvas.getBoundingClientRect();this.raycaster.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1),this.camera);
      const objects=[...this.markerObjects.values()].filter(s=>s.visible);
      this.raycaster.far=Infinity;
      const hits=this.raycaster.intersectObjects(objects,false);
      const hit=hits.find(h=>!this.isOccluded(h.object.position));if(hit)this.onSelect(hit.object.userData.sensor);
    });
    canvas.addEventListener('contextmenu',e=>e.preventDefault());
    canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();this.status('Graphics context lost. Reload the page to restore the viewport.',true);});
    this.worker=new Worker(new URL('./heatmap-worker.js',import.meta.url),{type:'module'});
    this.mapPlanes=new Map();
    this.overlays=new FloorOverlays(this.worker,(r,e)=>this.mapResult(r,e),key=>{const plane=this.mapPlanes.get(key);if(plane){this.scene.remove(plane);dispose(plane);this.mapPlanes.delete(key);this.dirty=true;}},legend);
    this.worker.onerror=()=>this.status('The map worker could not start.',true);
    this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(canvas.parentElement);
    this.resize();this.animate=now=>{this.loop(now);requestAnimationFrame(this.animate);};requestAnimationFrame(this.animate);
  }
  makeControls(target) {
    this.controls?.dispose();this.controls=new OrbitControls(this.camera,this.canvas);this.controls.enableDamping=true;this.controls.dampingFactor=.065;
    this.controls.rotateSpeed=.8;this.controls.panSpeed=.85;this.controls.zoomSpeed=.65;
    this.controls.minDistance=.35;this.controls.maxDistance=3000;this.controls.maxPolarAngle=Math.PI*.95;
    this.controls.minZoom=.05;this.controls.maxZoom=100;
    this.controls.mouseButtons={LEFT:-1,MIDDLE:THREE.MOUSE.ROTATE,RIGHT:THREE.MOUSE.PAN};
    if(target) this.controls.target.copy(target);
    this.controls.addEventListener('start',()=>{this.flight=null;this.wheelZoom=null;this.dirty=true;});
    this.controls.addEventListener('change',()=>{this.dirty=true;});
  }
  status(message,error=false) {
    const el=document.querySelector('#scene-loading');el.textContent=message;el.hidden=!message;el.classList.toggle('error',error);
  }
  resize() {
    const w=this.canvas.clientWidth,h=this.canvas.clientHeight;if(!w||!h)return;
    this.renderer.setSize(w,h,false);this.perspective.aspect=w/h;this.perspective.updateProjectionMatrix();
    this.setOrthoSpan(this.orthoSpan||12);this.dirty=true;
  }
  setOrthoSpan(span) {
    this.orthoSpan=span;const aspect=this.perspective.aspect;
    this.orthographic.left=-span*aspect;this.orthographic.right=span*aspect;
    this.orthographic.top=span;this.orthographic.bottom=-span;this.orthographic.updateProjectionMatrix();
  }
  visibleFloors() { return this.floors.filter(f=>this.desired.has(f.key)); }
  setScope(scope,selected,visible) {
    const scopeChanged=this.scope.building!==scope.building||this.scope.floor!==scope.floor;
    const selectionChanged=this.selected!==selected;
    this.scope=scope;this.selected=selected;
    const desired=new Set(this.floors.filter(f=>(!scope.building||f.building===scope.building)&&(!scope.floor||f.id===scope.floor)&&visible.get(f.key)!==false).map(f=>f.key));
    this.desired=desired;
    for(const [key,root] of this.loaded) if(!desired.has(key)) { this.scene.remove(root);dispose(root);this.loaded.delete(key); }
    this.loadMore();
    for(const s of this.sensors) {
      this.markerObjects.get(s.id).visible=desired.has(`${s.building}/${s.floor}`);
      this.markerObjects.get(s.id).material.depthTest=!scope.floor;
      this.labels.get(s.id).hidden=!this.markerObjects.get(s.id).visible;
    }
    if(scopeChanged||selectionChanged) { this.clearMap();this.mapSignature='';if(selected)this.focusSensor(selected);else this.frame(); }
    this.updateValues(this.values);this.dirty=true;
  }
  async loadMore() {
    const next=this.floors.find(f=>this.desired.has(f.key)&&!this.loaded.has(f.key)&&!this.pending.has(f.key)&&!this.failures.has(f.key));
    if(!next) { if(!this.pending.size&&!this.failures.size)this.status('');return; }
    if(this.pending.size>=2)return;
    this.pending.add(next.key);this.status(`Loading ${next.building} / ${next.id.replaceAll('_',' ')}…`);this.loadMore();
    const root=new THREE.Group();root.name=next.key;
    try {
      for(const path of next.files) {const gltf=await this.loader.loadAsync(asset(path).href);root.add(gltf.scene);}
      if(this.desired.has(next.key)) {this.scene.add(root);root.updateMatrixWorld(true);this.loaded.set(next.key,root);}else dispose(root);
    } catch(e) {dispose(root);this.failures.add(next.key);this.status(`Could not load ${next.key}: ${e.message}`,true);}
    finally {this.pending.delete(next.key);this.dirty=true;this.loadMore();}
  }
  bounds() {
    const box=new THREE.Box3();for(const f of this.visibleFloors())box.union(new THREE.Box3(new THREE.Vector3(...f.bounds[0]),new THREE.Vector3(...f.bounds[1])));
    if(box.isEmpty())box.set(new THREE.Vector3(-3,0,-3),new THREE.Vector3(3,3,3));return box;
  }
  fly(target,position,span=this.orthoSpan||12) {
    this.wheelZoom=null;
    const fromTarget=this.controls.target.clone(),fromPosition=this.camera.position.clone();
    const fromSpan=(this.orthoSpan||12)/(this.camera.isOrthographicCamera?this.camera.zoom:1);
    // Start the new flight from the visible pose, without old drag momentum.
    this.makeControls(fromTarget);
    if(this.camera.isOrthographicCamera){this.camera.zoom=1;this.setOrthoSpan(fromSpan);}
    if(reducedMotion()) {
      this.flight=null;this.controls.target.copy(target);this.camera.position.copy(position);
      this.setOrthoSpan(span);this.controls.update();this.dirty=true;return;
    }
    this.flight={start:performance.now(),fromTarget,fromPosition,fromSpan,
      target:target.clone(),position:position.clone(),span};this.dirty=true;
  }
  frame(fixedDirection=null) {
    const box=this.bounds(),center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3());
    const radius=size.length()/2;const distance=radius/Math.sin(THREE.MathUtils.degToRad(20))*1.15/Math.min(1,this.perspective.aspect);
    const direction=fixedDirection?fixedDirection.clone().normalize():this.camera.position.clone().sub(this.controls.target).normalize();if(direction.length()<.1)direction.set(1,.9,1).normalize();
    this.fly(center,center.clone().addScaledVector(direction,distance),radius*1.2);
  }
  focusSensor(sensor) {
    const p=sensor.position,target=new THREE.Vector3(p.x,p.z,-p.y),direction=this.camera.position.clone().sub(this.controls.target).normalize();
    this.fly(target,target.clone().addScaledVector(direction,3.8),2);
  }
  view(axis) {
    if(axis==='perspective') {if(this.camera.isOrthographicCamera)this.toggleProjection();this.frame(new THREE.Vector3(18,18,20));return;}
    const center=this.selected?this.markerObjects.get(this.selected.id).position.clone():this.bounds().getCenter(new THREE.Vector3());
    const distance=this.camera.position.distanceTo(this.controls.target);
    const direction={top:new THREE.Vector3(0,1,.0001),front:new THREE.Vector3(0,0,1),side:new THREE.Vector3(1,0,0)}[axis];
    this.fly(center,center.clone().addScaledVector(direction,distance));
  }
  toggleProjection() {
    this.flight=null;this.wheelZoom=null;
    const old=this.camera,target=this.controls.target.clone();this.camera=old.isPerspectiveCamera?this.orthographic:this.perspective;
    this.camera.position.copy(old.position);this.camera.quaternion.copy(old.quaternion);
    if(this.camera.isOrthographicCamera)this.orthoSpan=old.position.distanceTo(target)*Math.tan(THREE.MathUtils.degToRad(20));
    this.makeControls(target);this.resize();this.dirty=true;
  }
  toggleGrid(value) {this.grid.visible=value;this.axes.visible=value;this.dirty=true;}
  updateValues(values) {
    this.values=values;
    for(const sensor of this.sensors) {
      const value=values.get(sensor.id),sprite=this.markerObjects.get(sensor.id),label=this.labels.get(sensor.id);
      sprite.material.color.setHex(colors[value?.status||'offline']);
      label.className=`sensor-label${value?.online?'':' offline'}${this.selected?.id===sensor.id?' selected':''}`;
      label.textContent=value?.online?`${sensor.id} · ${value.temperature.toFixed(1)}°`:sensor.id;
    }
    this.dirty=true;
  }
  clearMap() {this.overlays.clear();}
  updateMap(metric) {
    this.metric=metric;
    this.overlays.update(metric,this.visibleFloors(),this.sensors,this.values,async floor=>{
      let map=this.mapCache.get(floor.key);
      if(!map){const response=await fetch(asset(floor.map));if(!response.ok)throw new Error('Floor raster not found');map=await response.json();this.mapCache.set(floor.key,map);}
      return map;
    },this.config.wallConductivity);
  }
  mapResult(result,current) {
    const {map,min,max,metric}=current,rgba=new Uint8Array(result.field.length*4);
    for(let i=0;i<result.field.length;i++)if(Number.isFinite(result.field[i])) {
      const t=max-min>1e-9?(result.field[i]-min)/(max-min):.5;
      const color=ramp(t,metric);rgba.set([...color,255],i*4);
    }
    const texture=new THREE.DataTexture(rgba,map.cols,map.rows,THREE.RGBAFormat);
    texture.magFilter=THREE.LinearFilter;texture.minFilter=THREE.LinearFilter;texture.colorSpace=THREE.SRGBColorSpace;texture.needsUpdate=true;
    const material=new THREE.MeshBasicMaterial({map:texture,transparent:true,opacity:this.config.mapOpacity||.58,depthWrite:false,side:THREE.DoubleSide,toneMapped:false});
    const plane=new THREE.Mesh(new THREE.PlaneGeometry(map.cols*map.step,map.rows*map.step),material);plane.rotation.x=Math.PI/2;
    plane.position.set(map.origin[0]+(map.cols-1)*map.step/2,map.render_height,map.origin[1]+(map.rows-1)*map.step/2);plane.renderOrder=5;this.scene.add(plane);this.mapPlanes.set(current.key,plane);this.dirty=true;
  }
  isOccluded(position) {
    if(this.scope.floor)return false;
    const point=position.clone().project(this.camera);
    this.raycaster.setFromCamera(new THREE.Vector2(point.x,point.y),this.camera);
    const distance=position.clone().sub(this.raycaster.ray.origin).dot(this.raycaster.ray.direction);
    this.raycaster.far=Math.max(0,distance-.05);
    const hidden=this.raycaster.intersectObjects([...this.loaded.values()],true).length>0;
    this.raycaster.far=Infinity;
    return hidden;
  }
  queueZoom(delta) {
    this.flight=null;
    const ortho=this.camera.isOrthographicCamera;
    const current=ortho?this.camera.zoom:this.camera.position.distanceTo(this.controls.target);
    const target=(this.wheelZoom?.target||current)*Math.exp(delta*WHEEL_SENSITIVITY*(ortho?-1:1));
    this.wheelZoom={target:Math.max(ortho?this.controls.minZoom:this.controls.minDistance,
      Math.min(ortho?this.controls.maxZoom:this.controls.maxDistance,target))};
    if(reducedMotion())this.applyZoom(this.wheelZoom.target);
    this.dirty=true;
  }
  applyZoom(value) {
    if(this.camera.isOrthographicCamera){this.camera.zoom=value;this.camera.updateProjectionMatrix();}
    else {
      const direction=this.camera.position.clone().sub(this.controls.target).normalize();
      this.camera.position.copy(this.controls.target).addScaledVector(direction,value);
    }
    if(this.wheelZoom?.target===value)this.wheelZoom=null;
  }
  advanceMotion(now) {
    const elapsed=Math.min(64,Math.max(0,now-(this.lastMotionTime??now-1000/60)));this.lastMotionTime=now;
    if(this.flight) {
      const flight=this.flight,progress=Math.min(1,Math.max(0,(now-flight.start)/CAMERA_DURATION_MS)),t=easeInOut(progress);
      this.camera.position.lerpVectors(flight.fromPosition,flight.position,t);
      this.controls.target.lerpVectors(flight.fromTarget,flight.target,t);
      this.setOrthoSpan(Math.exp(Math.log(flight.fromSpan)+(Math.log(flight.span)-Math.log(flight.fromSpan))*t));
      if(progress===1){this.camera.position.copy(flight.position);this.controls.target.copy(flight.target);this.setOrthoSpan(flight.span);this.flight=null;}
      this.dirty=true;
    } else if(this.wheelZoom) {
      const current=this.camera.isOrthographicCamera?this.camera.zoom:this.camera.position.distanceTo(this.controls.target);
      this.applyZoom(dampZoom(current,this.wheelZoom.target,elapsed));
      this.dirty=true;
    }
  }
  loop(now=performance.now()) {
    this.advanceMotion(now);
    this.controls.update();if(!this.dirty)return;
    this.camera.updateMatrixWorld();this.scene.updateMatrixWorld(true);
    const w=this.canvas.clientWidth,h=this.canvas.clientHeight,forward=this.camera.getWorldDirection(new THREE.Vector3());
    for(const [id,sprite] of this.markerObjects) {
      const label=this.labels.get(id);if(!sprite.visible){label.hidden=true;continue;}
      const depth=sprite.position.clone().sub(this.camera.position).dot(forward);
      const size=this.camera.isPerspectiveCamera?depth*2*Math.tan(THREE.MathUtils.degToRad(20))*27/Math.max(1,h):(this.camera.top-this.camera.bottom)/this.camera.zoom*27/Math.max(1,h);
      sprite.scale.setScalar(Math.max(.03,size));
      const p=sprite.position.clone().project(this.camera);label.hidden=depth<=0||Math.abs(p.x)>1||Math.abs(p.y)>1||p.z>1||this.isOccluded(sprite.position);
      label.style.left=`${(p.x+1)/2*w}px`;label.style.top=`${(1-p.y)/2*h}px`;
    }
    this.renderer.render(this.scene,this.camera);this.dirty=false;
  }
}

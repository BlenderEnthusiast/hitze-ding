import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three/three.module.js';
import {Viewer} from '../js/viewer.js';
import {FloorOverlays,overlayPlan} from '../js/overlays.js';

const floors=[{key:'A/1',building:'A',id:'1',map:'one'},{key:'A/2',building:'A',id:'2',map:'two'}];
const sensors=floors.map((f,i)=>({id:String(i),building:f.building,floor:f.id,position:{x:i,y:0,z:1}}));
const values=new Map([['0',{online:true,temperature:20,humidity:40}],['1',{online:true,temperature:28,humidity:60}]]);

test('all visible floors receive independent overlay jobs and a shared range',()=>{
  const plan=overlayPlan('temperature',floors,sensors,values);
  assert.equal(plan.layers.length,2);assert.equal(plan.min,20);assert.equal(plan.max,28);
  assert.equal(overlayPlan('humidity',floors,sensors,values).max,60);
  assert.equal(overlayPlan('off',floors,sensors,values).layers.length,0);
  assert.equal(overlayPlan('temperature',[floors[0]],sensors,values).layers.length,1);
});

test('hidden floors and stale worker results cannot restore an overlay',async()=>{
  const messages=[],shown=[],removed=[];
  const worker={postMessage:m=>messages.push(m)};
  const manager=new FloorOverlays(worker,(r,e)=>shown.push(e.key),k=>removed.push(k),()=>{});
  manager.update('temperature',floors,sensors,values,async()=>({cols:1}),{});
  await new Promise(r=>setTimeout(r,0));assert.equal(messages.length,2);
  manager.update('temperature',[floors[0]],sensors,values,async()=>({cols:1}),{});
  await new Promise(r=>setTimeout(r,0));
  worker.onmessage({data:{id:messages[1].id,converged:true}});
  assert.deepEqual(shown,[]);assert.ok(removed.includes('A/2'));
  worker.onmessage({data:{id:messages.at(-1).id,converged:true}});
  assert.deepEqual(shown,['A/1']);
  manager.clear();worker.onmessage({data:{id:messages[0].id,converged:true}});
  assert.equal(shown.length,1);
});

test('sensor visibility follows its floor, with depth testing only outside floor mode',()=>{
  const viewer=Object.create(Viewer.prototype);
  Object.assign(viewer,{scope:{},selected:null,floors,sensors,loaded:new Map(),values,
    markerObjects:new Map(sensors.map(s=>[s.id,{material:{}}])),labels:new Map(sensors.map(s=>[s.id,{}])),
    loadMore(){},clearMap(){},frame(){},focusSensor(){},updateValues(){}});
  viewer.setScope({},null,new Map());
  for(const s of viewer.markerObjects.values()){assert.equal(s.visible,true);assert.equal(s.material.depthTest,true);}
  viewer.setScope({building:'A',floor:'1'},null,new Map());
  assert.equal(viewer.markerObjects.get('0').visible,true);
  assert.equal(viewer.markerObjects.get('0').material.depthTest,false);
  assert.equal(viewer.markerObjects.get('1').visible,false);
  viewer.setScope({},null,new Map([['A/2',false]]));
  assert.equal(viewer.markerObjects.get('1').visible,false);
});

test('wall occlusion works with perspective and orthographic cameras; floor mode bypasses it',()=>{
  for(const camera of [new THREE.PerspectiveCamera(40,1,.1,100),new THREE.OrthographicCamera(-5,5,5,-5,.1,100)]){
    camera.position.set(0,0,10);camera.lookAt(0,0,0);camera.updateMatrixWorld();
    const wall=new THREE.Mesh(new THREE.BoxGeometry(3,3,.2),new THREE.MeshBasicMaterial());wall.position.z=5;wall.updateMatrixWorld();
    const viewer=Object.create(Viewer.prototype);Object.assign(viewer,{scope:{},camera,raycaster:new THREE.Raycaster(),loaded:new Map([['wall',wall]])});
    assert.equal(viewer.isOccluded(new THREE.Vector3(0,0,0)),true);
    assert.equal(viewer.isOccluded(new THREE.Vector3(0,0,7)),false);
    viewer.scope={floor:'1'};assert.equal(viewer.isOccluded(new THREE.Vector3(0,0,0)),false);
  }
});

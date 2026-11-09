import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three/three.module.js';
import {Viewer} from '../js/viewer.js';
import {CAMERA_DURATION_MS,dampZoom} from '../js/motion.js';

function cameraViewer(ortho=false) {
  const viewer=Object.create(Viewer.prototype);
  viewer.perspective=new THREE.PerspectiveCamera(40,1,.025,10000);
  viewer.orthographic=new THREE.OrthographicCamera(-12,12,12,-12,.025,10000);
  viewer.camera=ortho?viewer.orthographic:viewer.perspective;
  viewer.camera.position.set(0,10,20);viewer.orthoSpan=12;
  viewer.controls={target:new THREE.Vector3(),minDistance:.35,maxDistance:3000,minZoom:.05,maxZoom:100,update(){}};
  viewer.makeControls=target=>viewer.controls.target.copy(target);
  return viewer;
}

test('camera flights ease in, take 1.4 seconds, and finish at the exact focus',()=>{
  const v=cameraViewer(),origin=v.camera.position.clone(),position=new THREE.Vector3(4,3,4),target=new THREE.Vector3(3,1,-2);
  v.fly(target,position,2);v.flight.start=0;
  assert.ok(v.camera.position.equals(origin));
  v.advanceMotion(CAMERA_DURATION_MS/4);
  assert.ok(v.camera.position.distanceTo(origin)<origin.distanceTo(position)*.1);
  v.advanceMotion(CAMERA_DURATION_MS/2);
  assert.ok(v.camera.position.distanceTo(origin.clone().lerp(position,.5))<1e-10);
  v.advanceMotion(CAMERA_DURATION_MS);
  assert.equal(v.flight,null);assert.ok(v.camera.position.equals(position));assert.ok(v.controls.target.equals(target));assert.equal(v.orthoSpan,2);
});

test('30, 60 and 144 Hz camera updates follow the same flight and interruption stays continuous',()=>{
  const poses=[];
  for(const hz of [30,60,144]){
    const v=cameraViewer();v.fly(new THREE.Vector3(1,1,1),new THREE.Vector3(3,3,3),2);v.flight.start=0;
    for(let t=0;t<700;t+=1000/hz)v.advanceMotion(t);
    v.advanceMotion(700);poses.push(v.camera.position.clone());
    const current=v.camera.position.clone();v.fly(new THREE.Vector3(8,0,0),new THREE.Vector3(9,4,8));
    assert.ok(v.camera.position.equals(current));
    v.advanceMotion(v.flight.start+CAMERA_DURATION_MS);assert.ok(v.camera.position.equals(new THREE.Vector3(9,4,8)));
  }
  assert.ok(poses.every(p=>p.distanceTo(poses[0])<1e-10));
});

test('orthographic focus preserves the starting scale and eases it instead of snapping',()=>{
  const v=cameraViewer(true);v.camera.zoom=3;v.fly(new THREE.Vector3(),new THREE.Vector3(0,3,4),2);v.flight.start=0;
  assert.equal(v.camera.zoom,1);assert.equal(v.orthoSpan,4);
  v.advanceMotion(700);assert.ok(v.orthoSpan>2&&v.orthoSpan<4);
  v.advanceMotion(CAMERA_DURATION_MS);assert.equal(v.orthoSpan,2);
});

test('wheel zoom accumulates gently, settles without overshooting and respects bounds',()=>{
  const v=cameraViewer(),start=v.camera.position.length();v.queueZoom(-100);
  assert.equal(v.camera.position.length(),start);
  const first=v.wheelZoom.target;assert.ok(first>start*.96&&first<start);
  v.queueZoom(-100);const target=v.wheelZoom.target;assert.ok(target<first);
  let previous=start;
  for(let t=0;t<=2500;t+=1000/60){v.advanceMotion(t);const value=v.camera.position.length();assert.ok(value<=previous+1e-10&&value>=target-1e-10);previous=value;}
  assert.equal(v.wheelZoom,null);assert.ok(Math.abs(v.camera.position.length()-target)<1e-10);
  v.queueZoom(-100000);assert.equal(v.wheelZoom.target,v.controls.minDistance);
  const results=[30,60,144].map(hz=>{let current=10;for(let i=0;i<hz;i++)current=dampZoom(current,30,1000/hz);return current;});
  assert.ok(results.every(r=>Math.abs(r-results[0])<1e-10));
});

test('reduced-motion preference applies focus and wheel zoom immediately',()=>{
  const old=globalThis.matchMedia;globalThis.matchMedia=()=>({matches:true});
  try {
    const v=cameraViewer(),position=new THREE.Vector3(0,4,4);v.fly(new THREE.Vector3(1,1,1),position,2);
    assert.equal(v.flight,null);assert.ok(v.camera.position.equals(position));
    const before=v.camera.position.distanceTo(v.controls.target);v.queueZoom(-100);
    assert.equal(v.wheelZoom,null);assert.ok(v.camera.position.distanceTo(v.controls.target)<before);
  } finally {if(old)globalThis.matchMedia=old;else delete globalThis.matchMedia;}
});

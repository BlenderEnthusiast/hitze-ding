import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {basisKey,buildBasis,blendBasis} from '../js/basis.js';
import {solveField} from '../js/field.js';
const map={cols:11,rows:1,step:1,origin:[0,0],domain_rle:[1,11],walls_rle:[0,5,1,1,0,5]};
const sites=[{x:0,z:0,value:19},{x:10,z:0,value:27}];
test('precalculated weights reproduce a direct wall-aware solve for changing readings',()=>{
  for(const ratio of [.035,.005]){
    const basis=buildBasis(map,sites,ratio);assert.equal(basis.converged,true);
    for(const values of [[19,27],[24,20],[43,65],[22,22]]){
      const inputs=sites.map((s,i)=>({...s,value:values[i]}));
      const cached=blendBasis(basis,inputs),fresh=solveField(map,inputs,ratio);
      for(let i=0;i<cached.field.length;i++)assert.ok(Math.abs(cached.field[i]-fresh.field[i])<.0001);
    }
  }
});
test('cache keys ignore values and invalidate for sensor availability, geometry and material changes',()=>{
  const key=basisKey(map,sites,.035);
  assert.equal(key,basisKey(map,sites.map(s=>({...s,value:99})),.035));
  assert.notEqual(key,basisKey(map,sites.slice(0,1),.035));
  assert.notEqual(key,basisKey({...map,walls_rle:[0,11]},sites,.035));
  assert.notEqual(key,basisKey(map,sites,.005));
});
test('duplicate pins retain averaging and disconnected regions remain transparent',()=>{
  const m={...map,cols:5,domain_rle:[1,2,0,1,1,2],walls_rle:[0,5]};
  const inputs=[{x:0,z:0,value:10},{x:0,z:0,value:30}];
  const result=blendBasis(buildBasis(m,inputs,.035),inputs);
  assert.equal(result.field[0],20);assert.equal(result.field[1],20);
  assert.ok(Number.isNaN(result.field[3]));
});
test('bundled precomputed binaries match their geometry and sensor metadata',()=>{
  const root=new URL('../',import.meta.url),catalog=JSON.parse(fs.readFileSync(new URL('models/manifest.json',root)));
  const sensors=JSON.parse(fs.readFileSync(new URL('data/sensors.json',root))).sensors;
  const config=JSON.parse(fs.readFileSync(new URL('config/settings.json',root)));
  for(const b of catalog.buildings)for(const f of b.floors){
    if(!f.map)continue;
    const m=JSON.parse(fs.readFileSync(new URL(f.map,root)));
    const sites=sensors.filter(s=>s.building===b.id&&s.floor===f.id).map(s=>({x:s.position.x,z:-s.position.y,value:22}));
    for(const metric of ['temperature','humidity']){
      const info=m.basis[metric],meta=JSON.parse(fs.readFileSync(new URL(info.metadata,root)));
      assert.equal(meta.key,basisKey(m,sites,config.wallConductivity[metric]));
      assert.equal(fs.statSync(new URL(info.weights,root)).size,meta.count*meta.size*4);
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {solveField,decodeRLE,ramp} from '../js/field.js';
const encode=values=>{const a=[];for(const v of values){if(a.length&&a.at(-2)===v)a[a.length-1]++;else a.push(v,1);}return a;};
const map=(cols,rows,walls=[],domain=[])=>({cols,rows,step:1,origin:[0,0],domain_rle:encode(Array.from({length:cols*rows},(_,i)=>domain.length?domain[i]:1)),walls_rle:encode(Array.from({length:cols*rows},(_,i)=>walls.includes(i)?1:0))});
test('homogeneous strip agrees with the analytic linear solution',()=>{
  const result=solveField(map(11,1),[{x:0,z:0,value:10},{x:10,z:0,value:30}],1);
  assert.equal(result.converged,true);
  for(let i=0;i<11;i++)assert.ok(Math.abs(result.field[i]-(10+2*i))<1e-4);
});
test('a wall increases thermal resistance and preserves flux balance',()=>{
  const result=solveField(map(11,1,[5]),[{x:0,z:0,value:10},{x:10,z:0,value:30}],.035);
  assert.ok(result.field[5]-result.field[4]>5*(result.field[1]-result.field[0]));
  const k=2*.035/(1+.035),airFlux=result.field[1]-result.field[0],wallFlux=(result.field[5]-result.field[4])*k;
  assert.ok(Math.abs(airFlux-wallFlux)<1e-4);
});
test('one pin gives a constant connected field and no values outside footprint',()=>{
  const result=solveField(map(5,1,[],[1,1,0,1,1]),[{x:0,z:0,value:22}],.035);
  assert.equal(result.field[0],22);assert.equal(result.field[1],22);
  assert.ok(Number.isNaN(result.field[2]));assert.ok(Number.isNaN(result.field[3]));assert.ok(Number.isNaN(result.field[4]));
});
test('2D solution matches pins, converges and remains within observed extrema',()=>{
  const result=solveField(map(30,20,Array.from({length:15},(_,r)=>r*30+15)),[{x:2,z:3,value:19},{x:27,z:17,value:27}],.035);
  assert.equal(result.converged,true);assert.equal(result.field[3*30+2],19);assert.equal(result.field[17*30+27],27);
  for(const v of result.field)assert.ok(v>=19&&v<=27);
});
test('duplicate raster pins average, missing pins remain transparent',()=>{
  const result=solveField(map(3,1),[{x:0,z:0,value:20},{x:0,z:0,value:24}]);assert.equal(result.field[1],22);
  assert.ok([...solveField(map(3,1),[]).field].every(Number.isNaN));
});
test('color endpoints and malformed masks',()=>{
  assert.deepEqual(ramp(0,'temperature'),[55,116,241]);assert.deepEqual(ramp(.5,'temperature'),[78,206,139]);assert.deepEqual(ramp(1,'temperature'),[245,79,72]);
  assert.deepEqual(ramp(0,'humidity'),[71,203,143]);assert.deepEqual(ramp(1,'humidity'),[58,116,245]);
  assert.throws(()=>decodeRLE([1,99],3));assert.throws(()=>decodeRLE([1,1],3));
});

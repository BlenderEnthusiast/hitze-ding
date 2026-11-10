import {solveField} from './field.js';
export function basisKey(map,sites,ratio) {
  const {cols,rows,step,origin,domain_rle,walls_rle}=map;
  return JSON.stringify([1,{cols,rows,step,origin,domain_rle,walls_rle},sites.map(s=>[s.x,s.z]),ratio]);
}
export function buildBasis(map,sites,ratio) {
  const n=map.cols*map.rows,weights=new Float32Array(n*sites.length);let converged=true;
  for(let j=0;j<sites.length;j++) {
    const result=solveField(map,sites.map((s,i)=>({...s,value:i===j?1:0})),ratio);
    weights.set(result.field,j*n);converged&&=result.converged;
  }
  return {weights,count:sites.length,size:n,converged};
}
export function blendBasis(basis,sites) {
  if(sites.length!==basis.count)throw new Error('Sensor basis count mismatch');
  const field=new Float32Array(basis.size),min=Math.min(...sites.map(s=>s.value)),max=Math.max(...sites.map(s=>s.value));
  for(let i=0;i<basis.size;i++) {
    let total=0,value=0;
    for(let j=0;j<sites.length;j++) {
      const weight=basis.weights[j*basis.size+i];
      if(!Number.isFinite(weight)){total=0;break;}
      total+=weight;value+=weight*sites[j].value;
    }
    field[i]=total>1e-9?Math.max(min,Math.min(max,value/total)):NaN;
  }
  return {field,iterations:0,converged:basis.converged};
}

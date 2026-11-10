export function decodeRLE(encoded,size) {
  if (!Array.isArray(encoded) || encoded.length%2 || size>500000) throw new Error('Invalid floor raster');
  const result=new Uint8Array(size); let cursor=0;
  for (let i=0;i<encoded.length;i+=2) {
    const [value,count]=[encoded[i],encoded[i+1]];
    if (![0,1].includes(value) || !Number.isInteger(count) || count<1 || cursor+count>size) throw new Error('Invalid raster run');
    result.fill(value,cursor,cursor+count); cursor+=count;
  }
  if (cursor!==size) throw new Error('Incomplete floor raster');
  return result;
}

// Finite-volume discretization of div(k grad(u)) = 0. Harmonic face
// conductances conserve flux; exterior edges are insulated; sensor cells
// impose Dirichlet readings. Disconnected areas without readings stay empty.
export function solveField(map,sites,wallRatio=0.035) {
  const {cols,rows,step,origin}=map, n=cols*rows;
  if (!Number.isInteger(cols)||!Number.isInteger(rows)||cols<1||rows<1||n>500000||!(step>0)) throw new Error('Invalid map dimensions');
  const domain=decodeRLE(map.domain_rle,n),walls=decodeRLE(map.walls_rle,n);
  if (!(wallRatio>0 && wallRatio<=1)) throw new Error('Invalid wall conductivity');
  const pins=new Map();
  for (const s of sites) {
    if (![s.x,s.z,s.value].every(Number.isFinite)) continue;
    const x=(s.x-origin[0])/step,z=(s.z-origin[1])/step;
    let nearest=-1,distance=Infinity;
    for (let i=0;i<n;i++) if (domain[i]&&!walls[i]) {
      const d=(i%cols-x)**2+(Math.floor(i/cols)-z)**2;
      if (d<distance) { distance=d; nearest=i; }
    }
    if (nearest<0) continue;
    const existing=pins.get(nearest)||[]; existing.push(s.value); pins.set(nearest,existing);
  }
  const field=new Float32Array(n); field.fill(NaN);
  if (!pins.size) return {field,iterations:0,converged:true,pins:[]};
  const active=new Uint8Array(n),queue=new Int32Array(n); let first=0,last=0;
  for (const i of pins.keys()) { active[i]=1; queue[last++]=i; }
  while (first<last) {
    const i=queue[first++],c=i%cols,r=Math.floor(i/cols);
    for (const j of [c?i-1:-1,c+1<cols?i+1:-1,r?i-cols:-1,r+1<rows?i+cols:-1])
      if (j>=0 && domain[j] && !active[j]) { active[j]=1; queue[last++]=j; }
  }
  const fixed=new Float64Array(n),free=new Uint8Array(active),diag=new Float64Array(n),ex=new Float64Array(n),ez=new Float64Array(n);
  let sum=0;
  for (const [i,values] of pins) { fixed[i]=values.reduce((a,b)=>a+b,0)/values.length; free[i]=0; sum+=fixed[i]; }
  const average=sum/pins.size;
  const k=i=>walls[i]?wallRatio:1;
  for (let i=0;i<n;i++) if (active[i]) {
    for (const [j,out] of [[i%cols+1<cols?i+1:-1,ex],[i+cols<n?i+cols:-1,ez]]) if (j>=0&&active[j]) {
      const a=k(i),b=k(j),v=2*a*b/(a+b); out[i]=v; diag[i]+=v; diag[j]+=v;
    }
  }
  function operator(v,out) {
    for (let i=0;i<n;i++) out[i]=diag[i]*v[i];
    for (let i=0;i<n;i++) {
      if (ex[i]) { out[i]-=ex[i]*v[i+1]; out[i+1]-=ex[i]*v[i]; }
      if (ez[i]) { out[i]-=ez[i]*v[i+cols]; out[i+cols]-=ez[i]*v[i]; }
    }
    for (let i=0;i<n;i++) if (!free[i]) out[i]=0;
  }
  const x=new Float64Array(n),r=new Float64Array(n),p=new Float64Array(n),ad=new Float64Array(n),rhs=new Float64Array(n);
  operator(fixed,rhs);
  for (let i=0;i<n;i++) { rhs[i]=-rhs[i]; if (free[i]) x[i]=average; }
  operator(x,ad);
  let rz=0;
  for (let i=0;i<n;i++) if (free[i]) { r[i]=rhs[i]-ad[i]; p[i]=r[i]/diag[i]; rz+=r[i]*p[i]; }
  const tolerance=Math.max(rz*1e-12,1e-18); let iterations=0;
  for (;iterations<4000&&rz>tolerance;iterations++) {
    operator(p,ad); let denominator=0;
    for (let i=0;i<n;i++) denominator+=p[i]*ad[i];
    if (!(denominator>0)) break;
    const alpha=rz/denominator;
    let next=0;
    for (let i=0;i<n;i++) if (free[i]) { x[i]+=alpha*p[i]; r[i]-=alpha*ad[i]; next+=r[i]*r[i]/diag[i]; }
    const beta=next/rz;
    for (let i=0;i<n;i++) p[i]=free[i]?r[i]/diag[i]+beta*p[i]:0;
    rz=next;
  }
  const values=[...pins.values()].flat(),min=Math.min(...values),max=Math.max(...values);
  for (let i=0;i<n;i++) if (active[i]) field[i]=Math.max(min,Math.min(max,x[i]+fixed[i]));
  return {field,iterations,converged:rz<=tolerance,
          pins:[...pins].map(([i,v])=>({i,value:v.reduce((a,b)=>a+b,0)/v.length}))};
}

export function ramp(t,metric) {
  t=Math.max(0,Math.min(1,t));
  const mix=(a,b,v)=>a.map((n,i)=>Math.round(n+(b[i]-n)*v));
  if (metric==='humidity') return mix([71,203,143],[58,116,245],t);
  return t<0.5?mix([55,116,241],[78,206,139],t*2):mix([78,206,139],[245,79,72],(t-0.5)*2);
}

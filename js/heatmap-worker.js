import {basisKey,buildBasis,blendBasis} from './basis.js';
const cache=new Map(),root=new URL('../',import.meta.url);
async function prepare(data,key) {
  const prepared=data.map.basis?.[data.metric];
  if(prepared)try {
    const response=await fetch(new URL(prepared.metadata,root));if(!response.ok)throw new Error('No metadata');
    const meta=await response.json();
    if(meta.key!==key||meta.size!==data.map.cols*data.map.rows||meta.count!==data.sites.length)throw new Error('Outdated basis');
    const weights=await fetch(new URL(prepared.weights,root));if(!weights.ok)throw new Error('No weights');
    const buffer=await weights.arrayBuffer();if(buffer.byteLength!==meta.size*meta.count*4)throw new Error('Incomplete basis');
    return {weights:new Float32Array(buffer),size:meta.size,count:meta.count,converged:meta.converged};
  }catch{ /* Changed geometry or offline sensors need their own cached basis. */ }
  return buildBasis(data.map,data.sites,data.ratio);
}
self.onmessage=async({data})=>{
  try {
    const key=basisKey(data.map,data.sites,data.ratio);
    let entry=cache.get(key);
    if(!entry){
      entry={promise:prepare(data,key),bytes:0};cache.set(key,entry);
      entry.promise.then(b=>{
        entry.bytes=b.weights.byteLength;
        let bytes=[...cache.values()].reduce((n,e)=>n+e.bytes,0);
        for(const [old,e] of cache){if(bytes<=96*1024*1024)break;if(old!==key){cache.delete(old);bytes-=e.bytes;}}
      }).catch(()=>{if(cache.get(key)===entry)cache.delete(key);});
    }else{cache.delete(key);cache.set(key,entry);}
    const result=blendBasis(await entry.promise,data.sites);
    self.postMessage({id:data.id,...result},[result.field.buffer]);
  }catch(e){self.postMessage({id:data.id,error:e.message});}
};

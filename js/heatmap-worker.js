import {solveField} from './field.js';
self.onmessage=({data})=>{
  try {
    const result=solveField(data.map,data.sites,data.ratio);
    self.postMessage({id:data.id,...result},[result.field.buffer]);
  } catch(e) { self.postMessage({id:data.id,error:e.message}); }
};

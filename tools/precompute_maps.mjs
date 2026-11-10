import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {basisKey,buildBasis} from '../js/basis.js';
const root=path.resolve(process.argv[2]||path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const catalog=read('models/manifest.json'),sensors=read('data/sensors.json').sensors,config=read('config/settings.json');
for(const building of catalog.buildings)for(const floor of building.floors){
  if(!floor.map)continue;
  const map=read(floor.map),sites=sensors.filter(s=>s.building===building.id&&s.floor===floor.id).map(s=>({x:s.position.x,z:-s.position.y,value:0}));
  if(!sites.length)continue;
  const prepared={};
  for(const metric of ['temperature','humidity']){
    const ratio=config.wallConductivity?.[metric]||.035,key=basisKey(map,sites,ratio);
    const prefix=floor.map.replace(/\.json$/,`.${metric}`),metadata=prefix+'.basis.json',weights=prefix+'.basis.bin';
    if(fs.existsSync(path.join(root,metadata))&&fs.existsSync(path.join(root,weights))){
      const old=read(metadata);
      if(old.key===key&&fs.statSync(path.join(root,weights)).size===sites.length*map.cols*map.rows*4){prepared[metric]={metadata,weights};console.log(`Reused ${building.id}/${floor.id}: ${metric}`);continue;}
    }
    console.log(`Precalculating ${building.id}/${floor.id}: ${metric}, ${sites.length} sensors…`);
    const basis=buildBasis(map,sites,ratio);
    if(!basis.converged)throw new Error(`Basis did not converge: ${building.id}/${floor.id}/${metric}`);
    const tmp=path.join(root,weights+'.tmp');fs.writeFileSync(tmp,Buffer.from(basis.weights.buffer));fs.renameSync(tmp,path.join(root,weights));
    fs.writeFileSync(path.join(root,metadata),JSON.stringify({key,count:basis.count,size:basis.size,converged:true}));prepared[metric]={metadata,weights};
  }
  map.basis=prepared;fs.writeFileSync(path.join(root,floor.map),JSON.stringify(map));
}
console.log('Finished. Upload the whole data/maps/ folder with the website.');

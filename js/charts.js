const mint='#9cdbbd',blue='#86ace2',muted='#728790',grid='#303b43';
export function canvasSize(canvas) {
  const width=canvas.clientWidth,height=canvas.clientHeight,dpr=Math.min(devicePixelRatio||1,2);
  if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)){canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);}
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
  ctx.font='9px "Segoe UI",sans-serif';return {ctx,width,height};
}

function trace(ctx,rows,index,x,y,stale,color,baseline,fill=true) {
  let segment=[],previous=null;
  function flush() {
    if(!segment.length)return;
    if(fill&&segment.length>1){const grad=ctx.createLinearGradient(0,0,0,baseline);grad.addColorStop(0,color+'25');grad.addColorStop(1,color+'00');ctx.fillStyle=grad;ctx.beginPath();ctx.moveTo(segment[0][0],baseline);for(const p of segment)ctx.lineTo(...p);ctx.lineTo(segment.at(-1)[0],baseline);ctx.closePath();ctx.fill();}
    ctx.strokeStyle=color;ctx.lineWidth=1.35;ctx.beginPath();for(let i=0;i<segment.length;i++){const p=segment[i];if(i)ctx.lineTo(...p);else ctx.moveTo(...p);}ctx.stroke();
    if(segment.length===1){ctx.fillStyle=color;ctx.beginPath();ctx.arc(...segment[0],1.5,0,Math.PI*2);ctx.fill();}
    segment=[];
  }
  for(const row of rows) {
    if(row[index]===null||(previous!==null&&row[0]-previous>stale)){flush();previous=null;}
    if(row[index]!==null){segment.push([x(row[0]),y(row[index])]);previous=row[0];}
  }
  flush();
}

export function drawGraph(canvas,rows,metric,start,end,playhead,hover,stale,zone) {
  const {ctx,width:w,height:h}=canvasSize(canvas);if(w<10||h<10)return;
  const index=metric==='temperature'?1:2,color=index===1?mint:blue;
  const visible=rows.filter(r=>r[0]>=start&&r[0]<=end);
  const valid=visible.filter(r=>r[index]!==null);
  let low=index===1?15:30,high=index===1?30:70;
  if(valid.length){low=Math.min(...valid.map(r=>r[index]));high=Math.max(...valid.map(r=>r[index]));const pad=Math.max(index===1?.6:2,(high-low)*.16);low-=pad;high+=pad;}
  const left=29,right=w-6,top=9,bottom=h-22;
  const x=t=>left+(t-start)/(end-start)*(right-left),y=v=>bottom-(v-low)/(high-low)*(bottom-top);
  ctx.textAlign='right';ctx.fillStyle=muted;
  for(let i=0;i<3;i++){const yy=top+(bottom-top)*i/2,value=high-(high-low)*i/2;ctx.strokeStyle=grid;ctx.lineWidth=.65;ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.stroke();ctx.fillText(value.toFixed(index===1?1:0),left-5,yy+3);}
  const format=new Intl.DateTimeFormat('en-GB',end-start<=2*86400000?{timeZone:zone,hour:'2-digit',minute:'2-digit'}:{timeZone:zone,day:'2-digit',month:'short'});
  ctx.fillStyle=muted;
  for(let i=0;i<3;i++){const t=start+(end-start)*i/2;ctx.textAlign=i===0?'left':i===2?'right':'center';ctx.fillText(format.format(t),x(t),h-5);}
  ctx.save();ctx.beginPath();ctx.rect(left,top,right-left,bottom-top+2);ctx.clip();
  trace(ctx,visible,index,x,y,stale,color,bottom,true);
  if(playhead>=start&&playhead<=end){ctx.strokeStyle='#93b3a65c';ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(x(playhead),top);ctx.lineTo(x(playhead),bottom);ctx.stroke();ctx.setLineDash([]);}
  if(hover&&hover[0]>=start&&hover[0]<=end&&hover[index]!==null){ctx.strokeStyle='#bbc9ce';ctx.setLineDash([2,3]);ctx.beginPath();ctx.moveTo(x(hover[0]),top);ctx.lineTo(x(hover[0]),bottom);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=color;ctx.beginPath();ctx.arc(x(hover[0]),y(hover[index]),3,0,Math.PI*2);ctx.fill();}
  ctx.restore();
  if(!valid.length){ctx.fillStyle='#7d939b';ctx.textAlign='center';ctx.fillText('No observations in this interval',(left+right)/2,(top+bottom)/2);}
  return {count:valid.length,min:valid.length?Math.min(...valid.map(r=>r[index])):null,max:valid.length?Math.max(...valid.map(r=>r[index])):null,mean:valid.length?valid.reduce((s,r)=>s+r[index],0)/valid.length:null};
}

export function timelineTicks(start,end,width,zone) {
  const span=end-start,target=span/Math.max(3,Math.floor(width/90));
  const steps=[60000,300000,900000,1800000,3600000,7200000,14400000,21600000,43200000,86400000,2*86400000,7*86400000,14*86400000,30*86400000];
  const step=steps.find(s=>s>=target)||30*86400000,result=[];
  if(span>120*86400000) {
    const d=new Date(start);d.setUTCDate(1);d.setUTCHours(0,0,0,0);
    while(+d<=end){if(+d>=start)result.push(+d);d.setUTCMonth(d.getUTCMonth()+1);}
  } else for(let t=Math.ceil(start/step)*step;t<=end;t+=step)result.push(t);
  const format=new Intl.DateTimeFormat('en-GB',span<=2*86400000?{timeZone:zone,hour:'2-digit',minute:'2-digit'}:span>120*86400000?{timeZone:zone,month:'short',year:'2-digit'}:{timeZone:zone,day:'2-digit',month:'short'});
  return {ticks:result,step,format};
}

export function drawTimeline(canvas,rows,start,end,playhead,stale,zone,live) {
  const {ctx,width:w,height:h}=canvasSize(canvas);if(w<10||h<10)return;
  const left=16,right=w-16,x=t=>left+(t-start)/(end-start)*(right-left);
  const {ticks,format,step}=timelineTicks(start,end,w,zone);
  ctx.textAlign='center';
  for(const t of ticks){const xx=x(t);ctx.strokeStyle=grid;ctx.lineWidth=.7;ctx.beginPath();ctx.moveTo(xx,23);ctx.lineTo(xx,h);ctx.stroke();ctx.fillStyle=muted;ctx.fillText(format.format(t),Math.max(28,Math.min(w-28,xx)),15);for(let k=1;k<4;k++){const xx2=x(t+step*k/4);if(xx2<right){ctx.strokeStyle='#2c363b';ctx.beginPath();ctx.moveTo(xx2,23);ctx.lineTo(xx2,28);ctx.stroke();}}}
  const visible=rows.filter(r=>r[0]>=start&&r[0]<=end);
  for(const [index,color] of [[1,mint],[2,blue]]) {
    const valid=visible.filter(r=>r[index]!==null);
    if(!valid.length)continue;
    const low=Math.min(...valid.map(r=>r[index])),high=Math.max(...valid.map(r=>r[index]));
    const y=v=>h-10-(v-low)/Math.max(.001,high-low)*Math.max(5,h-47);
    trace(ctx,visible,index,x,y,stale,color,h-8,false);
  }
  if(!visible.length){ctx.fillStyle='#526973';ctx.textAlign='center';ctx.fillText('Choose a sensor to explore its observations',w/2,Math.max(40,h/2+8));}
  if(playhead>=start&&playhead<=end){const xx=x(playhead);ctx.fillStyle=live?mint:'#d2dcd6';ctx.strokeStyle=ctx.fillStyle;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(xx,24);ctx.lineTo(xx,h);ctx.stroke();ctx.beginPath();ctx.moveTo(xx-5,23);ctx.lineTo(xx+5,23);ctx.lineTo(xx,30);ctx.closePath();ctx.fill();}
  return step;
}

export function nearestSample(rows,time) {
  if(!rows.length)return null;
  let lo=0,hi=rows.length;
  while(lo<hi){const m=(lo+hi)>>>1;if(rows[m][0]<time)lo=m+1;else hi=m;}
  const candidates=[rows[lo],rows[lo-1]].filter(r=>r&&r[1]!==null&&r[2]!==null);
  return candidates.sort((a,b)=>Math.abs(a[0]-time)-Math.abs(b[0]-time))[0]||null;
}

export const CAMERA_DURATION_MS = 1400;
export const ZOOM_RESPONSE_MS = 180;
export const WHEEL_SENSITIVITY = 0.00032;

export function easeInOut(t) {
  t=Math.max(0,Math.min(1,t));
  return t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
}

export function dampZoom(current,target,elapsed) {
  const error=Math.log(target/current);
  if(Math.abs(error)<.0001)return target;
  return current*Math.exp(error*(1-Math.exp(-Math.max(0,elapsed)/ZOOM_RESPONSE_MS)));
}

export function wheelPixels(event,height) {
  const pixels=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?height:1)*(event.ctrlKey?10:1);
  return Math.max(-600,Math.min(600,pixels));
}

export const reducedMotion=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;

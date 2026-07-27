import { ANCHORS } from "./palette";
import { STORAGE_KEY } from "./palette-storage";

/**
 * Applies the saved palette before the browser paints.
 *
 * The palette lives in localStorage, which does not exist during server rendering, so the
 * HTML always arrives wearing the shipped brand. Correcting that in an effect would show
 * every returning visitor a cream flash before their palette lands — and on the landing
 * page that flash is the whole screen, including a WebGL scene. An inline script in <head>
 * runs synchronously while the HTML is still parsing, before React is involved at all, so
 * the custom properties are already set on <html> when the first pixel is drawn.
 * See node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md.
 *
 * The variable list is generated from ANCHORS rather than written out, so the script and
 * the picker cannot drift. Everything read out of storage is re-validated here: the boot
 * script runs before any of our other code, so it cannot assume the value was written by
 * a version of the picker that agrees with this one.
 */

const BOOT = `(function(){try{
var raw=localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
if(!raw)return;
var s=JSON.parse(raw);
if(!s||typeof s!=="object")return;
var el=document.documentElement;
if(s.scheme==="light"||s.scheme==="dark"||s.scheme==="auto")el.setAttribute("data-li-scheme",s.scheme);
var p=s.palette;
if(!p||typeof p!=="object")return;
var vars=${JSON.stringify(ANCHORS.map((a) => [a.key, a.cssVar]))},i,v,ok=[];
for(i=0;i<vars.length;i++){
v=p[vars[i][0]];
if(typeof v!=="string"||!/^#[0-9a-f]{6}$/i.test(v))return;
ok.push([vars[i][1],v]);
}
for(i=0;i<ok.length;i++)el.style.setProperty(ok[i][0],ok[i][1]);
}catch(e){}})()`;

export function PaletteBoot() {
  // The content is a build-time constant assembled from this repo's own tokens — no
  // request data reaches it, so there is nothing here for a caller to inject into.
  return <script dangerouslySetInnerHTML={{ __html: BOOT }} />;
}

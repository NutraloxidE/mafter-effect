// ライブ再生中に調整レイヤー(enabled)の効果が消えるか計測。static solid の領域を、
// (1)一時停止・調整ON (2)一時停止・調整OFF (3)再生継続3秒後・調整ON で比較。
// 再生ONが停止OFFに近い(=効果消失)なら「ライブ再生でのバグ」= キャッシュ無関係。
import { chromium } from "playwright";
const APP_URL=`https://localhost:${process.env.VERIFY_PORT ?? "5173"}/`;
const browser=await chromium.launch({executablePath:"/opt/pw-browsers/chromium"});
const page=await browser.newPage({viewport:{width:1200,height:800},ignoreHTTPSErrors:true});
const errs=[];page.on("pageerror",e=>errs.push(String(e)));
await page.goto(APP_URL,{waitUntil:"networkidle"});
await page.evaluate(()=>indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({waitUntil:"networkidle"});await page.waitForTimeout(800);
const ev=(fn,arg)=>page.evaluate(fn,arg);
const built=await ev(a=>{
  const s=window.__mafterEditorStore.getState();const W=640,H=360;
  const setPos=(id,x,y)=>{const st=window.__mafterEditorStore.getState();const c=st.project.compositions.find(c=>c.id===st.currentCompId);const o=c.objects.find(o=>o.id===id);st.updateObject(id,{transform:{...o.transform,position:{value:{x,y,z:0},keyframes:[]}}});};
  const solid=(n,col,sz,z)=>{const id=s.addSolid(n);s.updateObject(id,{zOrder:z,components:[{type:"solid",props:{color:{value:col,keyframes:[]},size:{value:sz,keyframes:[]}}}]});return id;};
  const mainId=s.addTimelineComp("main 1",{width:W,height:H,fps:30,duration:120});s.setCurrentComp(mainId);
  solid("BG",{r:.6,g:.6,b:.62,a:1},{x:W,y:H,z:0},0);
  const sol=solid("Sol",{r:.1,g:.5,b:.9,a:1},{x:200,y:260,z:0},1); setPos(sol,180,180);
  const adj=(s.addLiveAdjustmentLayer?s.addLiveAdjustmentLayer("Adj"):s.addAdjustmentLayer("Adj"));s.updateObject(adj,{zOrder:2});
  const fxId=s.addEffect(adj,a.fx);
  s.setCurrentComp(mainId);s.setFrame(30);
  return {mainId,adj,fxId,sol,W};
},{fx:process.env.FX||"tint"});
console.log("effect:",process.env.FX||"tint");
const stage=await ev(a=>{const el=document.querySelector(`[data-object-id="${a.adj}"]`);const b=el.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height};},built);
async function setAdjEnabled(on){await ev(a=>window.__mafterEditorStore.getState().updateObject(a.adj,{enabled:a.on}),{adj:built.adj,on});await page.waitForTimeout(250);}
async function setFrame(f){await ev(a=>window.__mafterEditorStore.getState().setFrame(a.f),{f});await page.waitForTimeout(250);}
async function play(on){await ev(a=>window.__mafterEditorStore.getState().setPlaying(a.on),{on});}
async function shotSolid(){const buf=await page.screenshot({clip:{x:Math.max(0,stage.x),y:Math.max(0,stage.y),width:stage.w,height:stage.h}});return "data:image/png;base64,"+buf.toString("base64");}
async function solidColor(img){return ev(async a=>{const bmp=await createImageBitmap(await(await fetch(a.img)).blob());const cv=document.createElement("canvas");cv.width=bmp.width;cv.height=bmp.height;const g=cv.getContext("2d");g.drawImage(bmp,0,0);const sc=cv.width/a.W;const px=Math.round(180*sc),py=Math.round(180*sc),R=20;let r=0,gg=0,b=0,n=0;for(let y=py-R;y<py+R;y++)for(let x=px-R;x<px+R;x++){const i=(y*cv.width+x)*4;const d=g.getImageData(x,y,1,1).data;r+=d[0];gg+=d[1];b+=d[2];n++;}return [Math.round(r/n),Math.round(gg/n),Math.round(b/n)];},{img,W:built.W});}
// paused baselines
await setFrame(30); await setAdjEnabled(true); const pOn=await solidColor(await shotSolid());
await setAdjEnabled(false); const pOff=await solidColor(await shotSolid());
await setAdjEnabled(true);
// play for ~3.5s then sample WITHOUT stopping
await setFrame(30); await play(true); await page.waitForTimeout(3500);
const playOn=await solidColor(await shotSolid());
await play(false); await page.waitForTimeout(300);
const dist=(a,b)=>Math.abs(a[0]-b[0])+Math.abs(a[1]-b[1])+Math.abs(a[2]-b[2]);
console.log("solid色 (paused adjON):",pOn," (paused adjOFF):",pOff," (playing adjON 3.5s):",playOn);
console.log("paused効果量 |On-Off| =",dist(pOn,pOff));
console.log("再生中 vs paused-OFF 距離 =",dist(playOn,pOff),"(小さい=再生中に効果消失=live bug)");
console.log("再生中 vs paused-ON  距離 =",dist(playOn,pOn),"(小さい=再生中も効いている)");
console.log("pageErrors:",errs.length,errs.slice(0,2));
await browser.close();

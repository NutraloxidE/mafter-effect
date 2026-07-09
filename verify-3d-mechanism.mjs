// 根本原因の確認: perspective と transform を「同じ要素」に置くと z=0 の子は拡大されないが、
// perspective を親・transform(translateZ) を子に置くと拡大される、を純 DOM で実測する。
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

const out = await page.evaluate(() => {
  const P = 600; // perspective
  const mk = (css) => { const d = document.createElement("div"); d.style.cssText = css; return d; };
  const results = {};

  // 計測対象 = 200x200 のボックス。
  const box = () => mk("width:200px;height:200px;background:#fff;transform-style:preserve-3d");

  // RIG A（現状の編集機と同じ）: 同一要素に perspective + transform(translateZ(-d))。子は z=0。
  const wrapA = mk(`position:absolute;left:0;top:0;perspective:${P}px;perspective-origin:50% 50%;transform:translateZ(-${P}px);transform-style:preserve-3d`);
  const childA = box();
  wrapA.appendChild(childA);
  document.body.appendChild(wrapA);

  // RIG B（修正案）: perspective は親、translateZ は子（=オブジェクトに焼く）。
  const wrapB = mk(`position:absolute;left:400px;top:0;perspective:${P}px;perspective-origin:50% 50%;transform-style:preserve-3d`);
  const childB = box();
  childB.style.transform = `translateZ(-${P}px)`; // 子が z を持つ → perspective で縮小されるはず
  wrapB.appendChild(childB);
  document.body.appendChild(wrapB);

  // RIG C（修正案・dolly近づけ）: 子 translateZ を 0 に（=neutral, 等倍想定）。
  const wrapC = mk(`position:absolute;left:800px;top:0;perspective:${P}px;perspective-origin:50% 50%;transform-style:preserve-3d`);
  const childC = box();
  childC.style.transform = `translateZ(0px)`;
  wrapC.appendChild(childC);
  document.body.appendChild(wrapC);

  // RIG D（修正案・dolly近づけ）: 子 translateZ = +P/2（手前 → 拡大想定）。
  const wrapD = mk(`position:absolute;left:0px;top:300px;perspective:${P}px;perspective-origin:50% 50%;transform-style:preserve-3d`);
  const childD = box();
  childD.style.transform = `translateZ(${P / 2}px)`;
  wrapD.appendChild(childD);
  document.body.appendChild(wrapD);

  const w = (el) => Math.round(el.getBoundingClientRect().width * 10) / 10;
  results.rigA_sameElement_z0child = w(childA);  // 期待: 200（拡大されない＝バグ再現）
  results.rigB_parentPersp_childZminusP = w(childB); // 期待: 100（0.5倍）
  results.rigC_parentPersp_childZ0 = w(childC);   // 期待: 200（等倍）
  results.rigD_parentPersp_childZplusHalfP = w(childD); // 期待: 400（2倍, P/(P-P/2)=2）
  return results;
});

await page.screenshot({ path: "verify-3d-mechanism.png" });
await browser.close();
console.log(JSON.stringify(out, null, 2));

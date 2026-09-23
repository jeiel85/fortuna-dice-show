// 스모크 테스트: 헤드리스 Chrome(CDP)으로 index.html을 띄워
//  1) 핵심 규칙 단위 검사  2) 저장/복구·손상 세이브 처리  3) 최종 보스 승리 경로
//  4) 클래스별 자동 플레이(탐욕 봇)로 전체 흐름을 돌리며 런타임 에러·진행 멈춤을 잡는다.
// 실행: node tests/smoke.mjs   (Node 22+, Chrome/Chromium 필요. CHROME_PATH로 경로 지정 가능)
// 환경변수: SMOKE_BUDGET_S = 클래스당 자동 플레이 시간 예산(초, 기본 75)
//          SMOKE_CLASSES = 자동 플레이할 클래스 목록(쉼표 구분, 기본 warrior,thief,mage,gambler)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET = (+process.env.SMOKE_BUDGET_S || 75) * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const failures = [];
const fail = m => { failures.push(m); console.error('  ✗ ' + m) };
const ok = m => console.log('  ✓ ' + m);

// ---------- 정적 서버 ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  try { const body = await readFile(join(ROOT, path || 'index.html')); res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }); res.end(body) }
  catch { res.writeHead(404); res.end() }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/index.html`;

// ---------- Chrome ----------
const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => p && existsSync(p));
if (!chrome) { console.error('Chrome/Chromium을 찾을 수 없습니다. CHROME_PATH를 지정하세요.'); process.exit(2) }
// 포트는 Chrome이 직접 고르게 하고(0), 시작 로그의 "DevTools listening on ws://..."에서 읽는다
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--mute-audio',
  '--no-first-run', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'dice-smoke-'))}`, '--window-size=1280,760', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeLog = '';
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Chrome 디버깅 포트를 60초 안에 열지 못했습니다.\n' + chromeLog.slice(-2000))), 60000);
  proc.stderr.on('data', b => { chromeLog += b; const m = chromeLog.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//); if (m) { clearTimeout(timer); resolve(+m[1]) } });
  proc.on('exit', code => { clearTimeout(timer); reject(new Error(`Chrome이 종료됨 (code ${code})\n` + chromeLog.slice(-2000))) });
}).catch(e => { console.error(e.message); server.close(); process.exit(2) });
let targets = [];
for (let i = 0; i < 80 && !targets.some(t => t.type === 'page'); i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json() } catch { await sleep(250) } }
const pageTarget = targets.find(t => t.type === 'page');
if (!pageTarget) { console.error('Chrome 페이지 타깃을 찾지 못했습니다.'); proc.kill(); server.close(); process.exit(2) }
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let seq = 0; const pending = new Map(); const pageErrors = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  else if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') pageErrors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
};
const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) });
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result.result.value;
}
async function load() { await send('Page.navigate', { url: URL_ }); await sleep(900); await ev(`SET.sound=false;SET.speed=20;'ok'`) }

// ---------- 페이지에 주입할 테스트 봇 ----------
const HARNESS = String.raw`
window.W=ms=>new Promise(r=>setTimeout(r,ms));
window.clickSel=sel=>{const e=document.querySelector(sel);if(e&&!e.disabled){e.click();return true}return false};
window.scoreMove=(C,d,ci)=>{const c=C.cards[ci],def=IT[c.id],conds=def.slots(c.u);if(conds[0].t==='cd')return d.v*.7;
  if(c.placed.filter(Boolean).length+1<conds.length)return d.v*.5+.5;
  const p=preview('p',c,conds.map((_,i)=>c.placed[i]?c.placed[i].v:d.v)),inc=incoming();
  let s=p.dmg+(inc>C.pb?Math.min(p.block,inc-C.pb)*.9:p.block*.1)+Math.min(p.heal,S.maxhp-S.hp)*.7;for(const k in p.st)s+=p.st[k]*1.5;
  if(p.dice)s+=1.2+(def.id==='flip'?(d.v<=2?3:-3):0);if(def.id==='reroll')s=d.v<=2?2:-1;if(def.id==='coin')s=d.v<=3?2.5:-1;
  if(def.id==='minus'||def.id==='combine')s=-1;if(def.id==='split')s=d.v>=4?2:-1;if(p.gold)s+=p.gold*.5;return s};
window.autoTurn=async()=>{const C=S.combat;
  if(S.cls==='thief'&&C.steal>=STEAL)useSkill();
  if(S.cls==='mage'&&C.sk>0&&!C.hand.some(ci=>C.dice.some(d=>canPlace(ci,d.v)>=0)))useSkill();
  if((S.cls==='warrior'||S.cls==='gambler')&&C.sk>0){const low=C.dice.find(d=>d.v>=2&&d.v<=3);if(low){UI.mode=S.cls==='warrior'?'reroll':'allin';await skillOnDie(low.id)}}
  for(let g=0;g<60;g++){if(!alive(C)||UI.busy)return;let best=null;
    for(const d of C.dice)C.cards.forEach((c,ci)=>{if(canPlace(ci,d.v)<0)return;const s=scoreMove(C,d,ci);if(!best||s>best.s)best={s,d,ci}});
    if(!best||best.s<=0)break;placeDie(best.ci,best.d.id,null);await W(10)}
  if(alive(C)&&!UI.busy)endTurn()};
window.AUTO={on:false,result:null,async run(cls){this.on=true;this.result=null;S=null;wipeSave();VIEW='cls';render();newRun(cls);
  while(this.on){try{const s=S.screen;
    if(s==='gameover'||s==='victory'){this.result={end:s,floor:S.floor,lv:S.level,kills:S.st.kills,turns:S.st.turns};this.on=false;break}
    if(s==='floor')clickSel('[data-a="go"]');
    else if(s==='map'){const av=availNodes();const p=av.find(([r,i])=>S.hp<S.maxhp*.5&&['apple','shop'].includes(S.map[r][i].t))||pick(av);enterNode(p[0],p[1])}
    else if(s==='combat'){const C=S.combat;if(C&&C.phase==='player'&&!UI.busy)await autoTurn()}
    else if(s==='reward'){const x=S.ctx;let k=0;x.items.forEach((it,i)=>{if(IT[it.id].rar+it.u>IT[x.items[k].id].rar+x.items[k].u)k=i});
      if(S.eq.length>=maxEq()){const w=S.eq.reduce((m,it,i)=>IT[it.id].rar+it.u<IT[S.eq[m].id].rar+S.eq[m].u?i:m,0);S.bag.push(...S.eq.splice(w,1))}
      if(!clickSel('[data-pick="'+k+'"]'))clickSel('[data-a="skip"]')}
    else if(s==='shop'){const b=[...document.querySelectorAll('[data-buy]')].find(b=>!b.disabled);if(b&&Math.random()<.7)b.click();
      else if(!clickSel('[data-a="apple"]')){if(clickSel('[data-a="upg"]')){await W(50);clickSel('#modal [data-k]');await W(50)}clickSel('[data-a="leave"]')}}
    else if(s==='treasure'){if(!clickSel('[data-a="open"]'))clickSel('[data-pick="0"]')}
    else if(s==='apple')clickSel(S.hp<S.maxhp*.7?'[data-a="red"]':'[data-a="gold"]');
    else if(s==='forge'){if(clickSel('[data-a="up"]')){await W(50);clickSel('#modal [data-k]')}else clickSel('[data-a="leave"]')||clickSel('[data-a="rest"]')}
    else if(s==='event'){if(clickSel('[data-a="spin"]'))await W(4600);else if(clickSel('[data-a="up"]')){await W(50);clickSel('#modal [data-k]')}
      else if(!clickSel('[data-bet="20"]'))if(!clickSel('[data-a="blood"]'))clickSel('[data-a="leave"]')}
  }catch(e){console.error('AUTO '+(e.stack||e))}await W(40)}}};
window.sig=()=>S?[S.screen,S.floor,S.st.turns,S.st.kills,S.combat&&S.combat.turn,S.combat&&S.combat.dice.length,S.combat&&S.combat.E.hp,S.pos&&S.pos.r].join('|'):'none';
'ok'`;

try {
  await send('Page.enable'); await send('Runtime.enable');
  await load();
  if (pageErrors.length) fail('로드 중 에러: ' + pageErrors.join(' / ')); else ok('페이지 로드');

  console.log('\n[1] 규칙 단위 검사');
  const unit = await ev(`(()=>{const e=[];const t=(c,m)=>{if(!c)e.push(m)};
    t(condOk(ODD,3)&&!condOk(ODD,4),'홀수');t(condOk(EVEN,6)&&!condOk(EVEN,5),'짝수');t(condOk(MX(3),3)&&!condOk(MX(3),4),'최대');
    t(condOk(MN(5),5)&&!condOk(MN(5),4),'최소');t(condOk(EQ(6),6)&&!condOk(EQ(6),5),'정확히');t(condOk(RG(3,4),4)&&!condOk(RG(3,4),5),'범위');
    t(groupFits([A,SAME],[4,4])&&!groupFits([A,SAME],[4,5]),'같은 눈');t(groupFits([EVEN,EVEN],[2,6])&&!groupFits([EVEN,EVEN],[2,5]),'짝수 2개');
    const g=fillGroup([MN(5)],[{v:6},{v:3}]);t(g&&g[0].v===6,'적 AI 채우기');t(fillGroup([EQ(1)],[{v:6}])===null,'적 AI 불가');
    for(let v=1;v<=6;v++){const q=faceQ(v);const best=FACES.map(f=>({v:f.v,z:Q.rot(q,f.n)[2]})).sort((a,b)=>b.z-a.z)[0];t(best.v===v,'주사위 정면 눈 '+v)}
    t(Object.values(IT).filter(d=>!d.mon).length>=40,'장비 풀 40종 이상');
    return e})()`);
  unit.length ? unit.forEach(m => fail('규칙: ' + m)) : ok('조건·적 AI·주사위 면 방향·장비 수');

  console.log('\n[2] 저장/복구');
  await ev(HARNESS);
  const saveRes = await ev(`(async()=>{const e=[];wipeSave();newRun('thief');S.screen='map';render();enterNode(0,0);
    for(let i=0;i<200&&!(S.combat&&S.combat.phase==='player'&&!UI.busy);i++)await W(25);
    const C=S.combat,d=C.dice[0],ci=C.cards.findIndex((c,i)=>canPlace(i,d.v)>=0);if(ci>=0)placeDie(ci,d.id,null);
    const snap=JSON.stringify({hp:S.hp,e:C.E.hp,d:C.dice.map(x=>x.v),i:C.E.cards.map(c=>c.intent&&c.intent.map(g=>g.map(x=>x.v)))});
    const L=loadSave();if(!L)return['세이브 없음'];
    const re=JSON.stringify({hp:L.hp,e:L.combat.E.hp,d:L.combat.dice.map(x=>x.v),i:L.combat.E.cards.map(c=>c.intent&&c.intent.map(g=>g.map(x=>x.v)))});
    if(snap!==re)e.push('전투 상태 불일치 '+snap+' vs '+re);
    const good=localStorage.getItem(KEY);
    localStorage.setItem(KEY,'{깨진');if(loadSave()!==null||!loadNote)e.push('깨진 JSON을 거부하지 않음');
    const bad=JSON.parse(good);bad.v=99;localStorage.setItem(KEY,JSON.stringify(bad));if(loadSave()!==null)e.push('알 수 없는 버전을 거부하지 않음');
    const b2=JSON.parse(good);b2.eq=[{id:'nope',u:0}];localStorage.setItem(KEY,JSON.stringify(b2));if(loadSave()!==null)e.push('없는 장비 id를 거부하지 않음');
    const b3=JSON.parse(good);b3.combat.cards[0].id='nope';localStorage.setItem(KEY,JSON.stringify(b3));const L3=loadSave();if(!L3||L3.screen!=='map'||L3.combat)e.push('손상된 전투를 맵으로 복구하지 않음');
    localStorage.setItem(KEY,good);S=loadSave();resume();await W(300);
    if(!S.combat||S.combat.phase!=='player'||UI.busy)e.push('전투 이어하기 실패');
    return e})()`);
  saveRes.length ? saveRes.forEach(m => fail('저장: ' + m)) : ok('전투 중 저장·복구, 손상 세이브 거부/복구');

  console.log('\n[3] 최종 보스 승리 경로');
  const vic = await ev(`(async()=>{S=null;wipeSave();newRun('gambler');S.floor=6;S.pos={r:6,i:0};S.map[6][0].v=1;startCombat('boss','fortuna');
    for(let i=0;i<200&&!(S.combat&&S.combat.phase==='player'&&!UI.busy);i++)await W(25);S.combat.E.hp=1;
    for(let i=0;i<300&&S.screen==='combat';i++){if(S.combat&&S.combat.phase==='player'&&!UI.busy)await autoTurn();await W(30)}
    for(let i=0;i<100&&!document.querySelector('.panel .bigico');i++)await W(30);
    return {screen:S&&S.screen,saved:!!localStorage.getItem(KEY),wins:(getBest()||{}).wins,log:getLog().length}})()`);
  if (vic.screen === 'victory' && !vic.saved && vic.wins >= 1 && vic.log >= 1) ok('포르투나 격파 → 승리 화면, 세이브 삭제, 최고 기록·전투 기록 반영');
  else if (vic.screen === 'gameover') ok('(보스가 먼저 이겨 승리 경로 미확인 — 재시도 권장)');
  else fail('승리 경로: ' + JSON.stringify(vic));

  console.log('\n[4] 클래스별 자동 플레이');
  for (const cls of (process.env.SMOKE_CLASSES || 'warrior,thief,mage,gambler').split(',').map(x => x.trim()).filter(Boolean)) {
    const errs0 = pageErrors.length;
    await ev(`AUTO.run('${cls}');'ok'`);
    const t0 = Date.now(); let last = '', lastT = Date.now(), res = null;
    while (Date.now() - t0 < BUDGET) {
      await sleep(500);
      res = await ev('AUTO.result'); if (res) break;
      const s = await ev('sig()');
      if (s !== last) { last = s; lastT = Date.now() }
      else if (Date.now() - lastT > 25000) { fail(`${cls}: 25초 동안 진행 없음 (${s})`); break }
    }
    await ev('AUTO.on=false;"ok"');
    const errs = pageErrors.slice(errs0);
    if (errs.length) fail(`${cls}: 런타임 에러 ${errs.length}건 — ${errs[0]}`);
    else ok(`${cls}: ${res ? `${res.end === 'victory' ? '🏆 클리어' : '사망'} (${res.floor}층, Lv${res.lv}, ${res.kills}킬, ${res.turns}턴)` : `시간 예산 종료 (${last})`}`);
    await sleep(300);
  }
  if (pageErrors.length) console.log('\n페이지 에러 모음:\n' + [...new Set(pageErrors)].slice(0, 10).join('\n'));
} catch (e) { fail('테스트 실행 실패: ' + (e.stack || e)) }
finally { try { ws.close() } catch {} proc.kill(); server.close() }

console.log(failures.length ? `\n❌ 실패 ${failures.length}건` : '\n✅ 스모크 테스트 통과');
process.exit(failures.length ? 1 : 0);

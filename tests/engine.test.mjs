// 엔진 단위 테스트: index.html의 <script id="engine"> 블록만 떼어 Node vm에서 실행한다.
// 실행: node --test tests/engine.test.mjs   (브라우저 불필요)
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, readdirSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const SRC = html.match(/<script id="engine">([\s\S]*?)<\/script>/)[1];

// 새 엔진 인스턴스 (DOM·타이머 없는 빈 전역에서 실행)
function boot(seed = 1) {
  const ctx = vm.createContext({});
  vm.runInContext(SRC, ctx, { filename: 'engine.js' });
  const ev = code => vm.runInContext(code, ctx);
  ev(`var __events=[];setRng(seededRng(${seed}));onEvent((t,p)=>__events.push({t,...p}))`);
  return {
    ev,
    json: code => JSON.parse(ev(`JSON.stringify(${code})`)),
    events: type => JSON.parse(ev(`JSON.stringify(__events)`)).filter(e => !type || e.t === type),
    clearEvents: () => ev('__events.length=0'),
    // 다음 주사위 눈을 지정한다 (d6 한 번 = rng 한 번)
    dice: (...vals) => ev(`{const q=${JSON.stringify(vals.map(v => (v - .5) / 6))};let i=0;setRng(()=>i<q.length?q[i++]:.5)}`),
  };
}
// 런 + 전투를 만들고 플레이어 턴 상태로 둔다 (주사위는 테스트가 직접 넣음)
function fight(E, { cls = 'warrior', enemy = 'skel', kind = 'normal', eq, level = 1, dice = [] } = {}) {
  E.ev(`S=createRun('${cls}',0);S.level=${level};${eq ? `S.eq=${JSON.stringify(eq.map(id => ({ id: id.replace('+', ''), u: id.endsWith('+') ? 1 : 0 })))};` : ''}
    createCombat('${kind}','${enemy}');S.combat.phase='player';
    S.combat.dice=${JSON.stringify(dice.map((v, i) => ({ id: 100 + i, v })))};S.combat.nid=200;`);
  E.clearEvents();
}
const ci = (E, id) => E.ev(`S.combat.cards.findIndex(c=>c.id==='${id}')`);

test('엔진 블록은 브라우저·UI에 의존하지 않는다', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const banned = code.match(/\b(document|window|localStorage|sessionStorage|setTimeout|setInterval|requestAnimationFrame|fetch|navigator|AudioContext|SFX|Tray|FX|UI|render|floatAt|announce|toast)\b|Math\.random\(/g);
  assert.equal(banned, null, `금지된 참조: ${banned}`);
});

test('주사위 조건 · 묶음 판정 · 적 AI 채우기', () => {
  const E = boot();
  assert.equal(E.ev(`condOk(ODD,3)&&!condOk(ODD,4)&&condOk(EVEN,6)&&condOk(MX(3),3)&&!condOk(MX(3),4)&&condOk(MN(5),6)&&condOk(EQ(6),6)&&!condOk(EQ(6),5)&&condOk(RG(3,4),4)&&!condOk(RG(3,4),5)`), true);
  assert.equal(E.ev('groupFits([A,SAME],[4,4])'), true);
  assert.equal(E.ev('groupFits([A,SAME],[4,5])'), false);
  assert.equal(E.ev('groupFits([EVEN,EVEN],[6,2])'), true);
  assert.equal(E.ev('groupFits([EVEN,EVEN],[6,3])'), false);
  assert.deepEqual(E.json('fillGroup([MN(5)],[{v:6},{v:3}]).map(d=>d.v)'), [6]);
  assert.equal(E.ev('fillGroup([EQ(1)],[{v:6}])'), null);
  assert.deepEqual(E.json('fillGroup([A,SAME],[{v:6},{v:3},{v:3}]).map(d=>d.v)'), [3, 3]);
});

test('피해: 방어·관통·회피·가시·힘·약화', () => {
  const E = boot();
  fight(E);
  E.ev('S.combat.E.hp=30;S.combat.E.block=5;dealDmg("p","e",8,{})');
  assert.deepEqual(E.json('[S.combat.E.hp,S.combat.E.block]'), [27, 0]);
  assert.deepEqual(E.events().map(e => e.t), ['attack', 'blocked', 'hurt']);
  E.ev('S.combat.E.block=5;dealDmg("p","e",8,{pierce:true})');
  assert.deepEqual(E.json('[S.combat.E.hp,S.combat.E.block]'), [19, 5], '관통은 방어를 무시');
  E.ev('S.combat.E.st.dodge=1;dealDmg("p","e",50,{})');
  assert.deepEqual(E.json('[S.combat.E.hp,S.combat.E.st.dodge]'), [19, 0], '회피는 공격 1회를 무효화');
  E.ev('S.combat.E.block=0;S.combat.E.st.thorns=2;S.hp=40;dealDmg("p","e",1,{})');
  assert.equal(E.ev('S.hp'), 38, '가시는 공격자에게 반사');
  E.ev('S.combat.E.st.thorns=0;S.combat.E.hp=30;S.combat.pst.str=2;S.combat.pst.weak=1;dealDmg("p","e",8,{})');
  assert.equal(E.ev('S.combat.E.hp'), 25, '(8+힘2)/2 = 5');
});

test('적에게 거는 빙결·감전·화상은 예고에 즉시 적용', () => {
  const E = boot();
  fight(E, { enemy: 'ogre' });
  const gs = 0; // ogre: 대검(최소 5), 탑 방패, 물기+
  E.ev(`S.combat.E.cards[${gs}].intent=[[{id:'e1',v:6}]];S.combat.E.cards[2].intent=[[{id:'e2',v:3}]]`);
  E.ev('addStatus("e","freeze",1)');
  assert.equal(E.ev(`S.combat.E.cards[${gs}].intent`), null, '6이 1이 되어 "최소 5" 조건이 깨지면 행동 무산');
  assert.equal(E.events('fizzle').length, 1);
  E.ev('addStatus("e","burn",1)');
  assert.equal(E.ev('S.combat.E.cards[2].intent[0][0].burn'), 1);
  E.ev('addStatus("e","shock",1)');
  assert.deepEqual(E.json('[S.combat.E.cards[2].intent,S.combat.E.cards[2].off]'), [null, 1]);
});

test('적 AI는 조건이 까다로운 장비부터 채운다', () => {
  const E = boot();
  fight(E);
  // '아무 눈' 장비가 앞에 있어도 6은 '최소 5' 대검에 가야 둘 다 쓸 수 있다
  E.ev(`S.combat.E.cards=[mkCard('sword',0),mkCard('greatsword',0)];S.combat.E.dice=2`);
  E.dice(6, 2);
  E.ev('planIntents()');
  assert.deepEqual(E.json('S.combat.E.cards.map(c=>c.intent&&c.intent[0].map(d=>d.v))'), [[2], [6]]);
  // 포르투나의 변덕: 주사위 하나는 반드시 6
  fight(E, { enemy: 'fortuna', kind: 'boss' });
  E.dice(1, 1, 1, 1, 1);
  E.ev('planIntents()');
  assert.ok(E.json('S.combat.eroll.map(d=>d.v)').includes(6));
});

test('주사위 배치: 단일·여러 칸·같은 눈·카운트다운·화상·도구', () => {
  const E = boot();
  fight(E, { eq: ['greatsword', 'hammer', 'twin', 'ram', 'flip'], dice: [5, 4, 2, 6, 6, 1, 4, 4], enemy: 'ogre' });
  E.ev('S.combat.E.hp=200');
  // 대검(최소 5): 5+4
  assert.equal(E.ev(`putDie(${ci(E, 'greatsword')},100).ok`), true);
  assert.equal(E.ev('S.combat.E.hp'), 191);
  assert.equal(E.ev(`canPlace(${ci(E, 'greatsword')},6)`), -1, '턴당 1회');
  // 짝수 해머: 첫 칸만 채우면 대기, 두 칸이 차면 발동 (4+2+1)
  E.ev(`putDie(${ci(E, 'hammer')},101)`);
  assert.equal(E.ev('S.combat.E.hp'), 191);
  E.ev(`putDie(${ci(E, 'hammer')},102)`);
  assert.equal(E.ev('S.combat.E.hp'), 184);
  // 쌍검: 같은 눈만 두 번째 칸에 들어간다 (4×3)
  E.ev(`putDie(${ci(E, 'twin')},106)`);
  assert.equal(E.ev(`canPlace(${ci(E, 'twin')},5)`), -1);
  E.ev(`putDie(${ci(E, 'twin')},107)`);
  assert.equal(E.ev('S.combat.E.hp'), 172);
  // 파성추 카운트다운 12: 6 → 남음 6, 6 → 발동(16) 후 12로 리셋
  E.ev(`putDie(${ci(E, 'ram')},103)`);
  assert.equal(E.ev(`S.combat.cards[${ci(E, 'ram')}].cd`), 6);
  E.ev(`putDie(${ci(E, 'ram')},104)`);
  assert.deepEqual(E.json(`[S.combat.E.hp,S.combat.cards[${ci(E, 'ram')}].cd]`), [156, 12]);
  // 뒤집개: 1 → 새 주사위 6
  E.clearEvents();
  E.ev(`S.combat.dice.find(d=>d.id===105).burn=1;S.hp=50;putDie(${ci(E, 'flip')},105)`);
  assert.equal(E.ev('S.hp'), 48, '불탄 주사위는 체력 2');
  assert.deepEqual(E.events('dieAdded').map(e => e.die.v), [6]);
});

test('여러 칸 장비의 주사위 되돌리기 · 도적 충전', () => {
  const E = boot();
  fight(E, { cls: 'thief', eq: ['hammer'], dice: [4, 6] });
  E.ev('putDie(0,100)');
  assert.equal(E.ev('S.combat.steal'), 4);
  assert.deepEqual(E.json('takeBack(0,0)'), { id: 100, v: 4 });
  assert.deepEqual(E.json('S.combat.dice.map(d=>d.v).sort()'), [4, 6]);
});

test('턴 시작: 독·방어 초기화·빙결·감전·주사위 수·보스 분노', () => {
  const E = boot();
  fight(E, { enemy: 'dealer', kind: 'boss' });
  E.ev('S.hp=40;S.combat.pb=9;S.combat.pst={poison:3,freeze:2,shock:1};S.combat.E.hp=20');
  E.dice(6, 6, 6, 5, 4, 3); // 적 3개 + 내 3개
  E.ev('beginPlayerTurn()');
  assert.deepEqual(E.json('[S.hp,S.combat.pb,S.combat.pst.poison]'), [37, 0, 2]);
  assert.deepEqual(E.json('S.combat.dice.map(d=>d.v)'), [1, 1, 3], '가장 높은 2개가 1로');
  assert.equal(E.ev('S.combat.cards.filter(c=>c.off).length'), 1);
  assert.equal(E.ev('S.combat.E.st.str'), 1, '체력 절반 이하 보스는 분노');
  assert.equal(E.events('enrage').length, 1);
  for (const [cls, lv, n] of [['warrior', 1, 3], ['warrior', 3, 4], ['warrior', 6, 5], ['gambler', 1, 4]]) {
    fight(E, { cls, level: lv });
    E.ev('beginPlayerTurn()');
    assert.equal(E.ev('S.combat.dice.length'), n, `${cls} Lv${lv}`);
  }
  // 독으로 쓰러지면 굴리지 않고 끝난다
  fight(E);
  E.ev('S.hp=2;S.combat.phase="start";S.combat.pst.poison=5;beginPlayerTurn()');
  assert.deepEqual(E.json('[outcome(),S.combat.phase,S.combat.dice.length]'), ['lose', 'start', 0]);
});

test('적 턴: 여러 번 쓰는 장비도 새로고침 후 중복 실행하지 않는다', () => {
  // 한 번에 끝까지
  const A = boot(7);
  fight(A, { enemy: 'rat' }); // 할퀴기(최대 3, 턴당 2회, 피해 눈+1)
  A.dice(2, 3);
  A.ev('planIntents();S.hp=50;endPlayerTurn();enemyTurnBegin();for(let i=0;i<20&&nextEnemyAction();i++)enemyAct();enemyTurnEnd()');
  assert.equal(A.ev('S.hp'), 50 - (3 + 1) - (2 + 1));
  assert.equal(A.ev('S.combat.turn'), 2);
  // 첫 행동 직후 저장 → 새 엔진에서 불러와 이어가기
  const B = boot(7);
  fight(B, { enemy: 'rat' });
  B.dice(2, 3);
  B.ev('planIntents();S.hp=50;endPlayerTurn();enemyTurnBegin();enemyAct()');
  const saved = B.ev('JSON.stringify(S)');
  const C = boot(99);
  C.ev(`S=parseSave(${JSON.stringify(saved)}).s;for(let i=0;i<20&&nextEnemyAction();i++)enemyAct();enemyTurnEnd()`);
  assert.equal(C.ev('S.hp'), 43);
});

test('스킬: 훔치기·재굴림·페이지 넘기기', () => {
  const E = boot();
  fight(E, { cls: 'thief', enemy: 'ogre' });
  assert.equal(E.json('stealCard()').reason, 'charge');
  E.ev('S.combat.steal=10');
  const r = E.json('stealCard()');
  assert.equal(r.ok, true);
  assert.equal(E.ev(`S.combat.cards[${r.ci}].temp`), 1);
  assert.equal(E.ev('S.combat.E.cards.filter(c=>c.stolen).length'), 1);
  E.ev('S.combat.steal=10;stealCard();S.combat.steal=10');
  assert.equal(E.json('stealCard()').reason, 'none', '적의 마지막 장비는 못 훔친다');

  fight(E, { dice: [2] });
  E.ev('S.combat.sk=1');
  assert.ok(E.json('rerollDie(100)'));
  assert.equal(E.ev('rerollDie(100)'), null, '횟수 소진');

  fight(E, { cls: 'mage' }); // 주문 3개(화염구·얼음 창·치유) 중 2개만 펼침
  E.ev('beginPlayerTurn()');
  assert.equal(E.ev('S.combat.hand.length'), 2);
  assert.equal(E.ev('flipPage()'), true);
  assert.equal(E.ev('S.combat.sk'), 0);
  assert.equal(E.ev('flipPage()'), false);
});

test('승리 보상 · 레벨 업 · 최종 보스', () => {
  const E = boot();
  fight(E);
  E.ev('S.xp=1;S.hp=30;S.gold=0');
  const r = E.json('resolveVictory()');
  assert.equal(r.last, false);
  assert.deepEqual(E.json('[S.screen,S.level,S.maxhp,S.hp,S.st.kills,S.combat]'), ['reward', 2, 65, 40, 1, null]);
  assert.ok(E.ev('S.gold') > 0);
  assert.equal(E.ev('S.ctx.items.length'), 3);
  assert.equal(E.ev('S.ctx.items.every(it=>!IT[it.id].mon)'), true);

  fight(E, { enemy: 'fortuna', kind: 'boss' });
  E.ev('S.floor=6');
  assert.equal(E.json('resolveVictory()').last, true);
  assert.deepEqual(E.json('[S.screen,S.dead,S.ctx.items.length]'), ['victory', 1, 0]);
});

test('던전 맵 생성 규칙 (시드 60개)', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const E = boot(seed);
    const m = E.json('genMap()');
    assert.equal(m.length, 7);
    assert.deepEqual(m[6].map(n => n.t), ['boss']);
    assert.ok(m[0].every(n => n.t === 'fight'), '첫 줄은 전투');
    assert.ok(m[5].every(n => n.t === 'apple' || n.t === 'forge') && m[5].some(n => n.t === 'apple'), '보스 직전은 휴식');
    assert.ok(m.slice(2, 5).flat().some(n => n.t === 'shop'), '2~4줄에 상점');
    for (let r = 0; r < 6; r++) {
      assert.ok(m[r].every(n => n.l.length && n.l.every(j => j >= 0 && j < m[r + 1].length)), `${seed}: ${r}줄 연결`);
      m[r + 1].forEach((_, j) => assert.ok(m[r].some(n => n.l.includes(j)), `${seed}: ${r + 1}줄 ${j}번 도달 불가`));
    }
  }
});

test('장비 드롭: 몬스터 전용 제외 · 최소 희귀도 · 전설 보장', () => {
  const E = boot(3);
  E.ev(`S=createRun('warrior',0)`);
  for (let i = 0; i < 30; i++) {
    const it = E.json('rollItems(3,2,true).map(x=>IT[x.id])');
    assert.equal(it[0].rar, 3);
    assert.ok(it.every(d => d.rar >= 2 && !d.mon));
  }
});

test('미리보기는 상태를 바꾸지 않는다', () => {
  const E = boot();
  fight(E, { enemy: 'ogre' });
  const before = E.ev('JSON.stringify(S)');
  E.ev('preview("e",S.combat.E.cards[0],[6]);preview("p",S.combat.cards[0],[3])');
  assert.equal(E.ev('JSON.stringify(S)'), before);
  assert.equal(E.events().length, 0);
  assert.equal(E.ev('preview("e",S.combat.E.cards[0],[6]).dmg'), 10);
});

test('세이브: 왕복 · 손상 거부 · 복구', () => {
  const E = boot();
  fight(E);
  const good = E.ev('JSON.stringify(S)');
  assert.equal(E.ev(`JSON.stringify(parseSave(${JSON.stringify(good)}).s)`), good);
  const p = raw => E.json(`parseSave(${JSON.stringify(raw)})`);
  assert.equal(p('{깨진').s, null);
  const mut = f => { const o = JSON.parse(good); f(o); return JSON.stringify(o) };
  assert.equal(p(mut(o => o.v = 99)).s, null, '알 수 없는 버전');
  assert.equal(p(mut(o => o.eq = [{ id: 'nope', u: 0 }])).s, null, '없는 장비');
  assert.equal(p(mut(o => o.floor = 9)).s, null, '범위 밖 층');
  const bc = p(mut(o => o.combat.cards[0].id = 'nope'));
  assert.deepEqual([bc.s.screen, bc.s.combat, !!bc.note], ['map', null, true], '손상된 전투는 맵으로');
  const br = p(mut(o => { o.combat = null; o.screen = 'reward'; o.ctx = { items: 'x' } }));
  assert.equal(br.s.screen, 'map', '손상된 방은 맵으로');
  const bb = p(mut(o => { o.combat = null; o.screen = 'map'; o.pos = { r: 6, i: 0 } }));
  assert.deepEqual([bb.s.screen, bb.s.floor, bb.s.pos], ['floor', 2, null], '보스방 직후면 다음 층');
});

test('엔진 이벤트 이름: 등록된 것만 쓰고, UI가 전부 처리한다', () => {
  const E = boot();
  const events = E.json('EVENTS');
  const emitted = [...SRC.matchAll(/emit\('(\w+)'/g)].map(m => m[1]);
  assert.deepEqual([...new Set(emitted)].filter(t => !events.includes(t)), [], '미등록 이벤트를 emit');
  const ui = html.slice(html.indexOf('onEvent((type,p)=>{'));
  const handled = [...ui.slice(0, ui.indexOf('\n});')).matchAll(/case '(\w+)'/g)].map(m => m[1]);
  assert.deepEqual([...handled].sort(), [...events].sort(), 'UI가 처리하는 이벤트와 등록 목록이 다름');
  assert.throws(() => E.ev('emit("hrut",{})'), /알 수 없는 엔진 이벤트/);
});

test('상점: 구매·사과·강화·판매 규칙', () => {
  const E = boot(5);
  E.ev(`S=createRun('warrior',0);S.gold=500;openShop()`);
  const p0 = E.ev('price(S.ctx.stock[0])');
  const r = E.json('buyItem(0)');
  assert.equal(E.ev('S.gold'), 500 - p0);
  assert.equal(r.where, 'eq');
  assert.equal(E.ev('buyItem(0)'), null, '같은 물건은 한 번만');
  E.ev('S.hp=10');
  assert.equal(E.ev('buyApple()&&buyApple()&&!buyApple()'), true, '사과는 2개까지');
  assert.equal(E.ev('S.hp'), 50);
  const cost = E.ev('upPrice()'), g = E.ev('S.gold');
  assert.equal(E.ev('buyUpgrade(upgradable()[0])'), true);
  assert.deepEqual(E.json('[S.gold,S.eq[0].u,canBuyUpgrade()]'), [g - cost, 1, false], '강화는 상점당 1회');
  // 판매: 마지막 장착 장비는 못 판다, 목록을 연 뒤 바뀐 ref는 무효
  E.ev('S.eq=[S.eq[0]];S.bag=[{id:"sword",u:0}]');
  assert.deepEqual(E.json('sellable().map(r=>r.l)'), ['bag']);
  assert.equal(E.ev('sellItem({it:S.eq[0],l:"eq",i:0})'), 0);
  const stale = E.ev('JSON.stringify(sellable()[0])');
  assert.ok(E.ev('sellItem(sellable()[0])') > 0);
  assert.equal(E.ev(`sellItem(${stale})`), 0, '이미 팔린 장비');
});

test('장비 관리: 장착 칸 제한', () => {
  const E = boot();
  E.ev(`S=createRun('warrior',0);S.bag=[{id:'bow',u:0},{id:'axe',u:0},{id:'gloves',u:0}]`);
  assert.equal(E.ev('equip(0)&&equip(0)'), true);
  assert.equal(E.ev('S.eq.length'), 6);
  assert.equal(E.ev('equip(0)'), false, '6칸 초과 불가');
  E.ev('S.eq=[S.eq[0]]');
  assert.equal(E.ev('unequip(0)'), false, '마지막 장비는 내릴 수 없음');
});

test('보물 상자·사과나무·대장간', () => {
  const E = boot();
  E.ev(`S=createRun('thief',0);S.floor=3`);
  E.ev('setRng(()=>.05)');
  assert.deepEqual(E.json('openTreasure()'), { mimic: true, hp: 16 + 27 }, '2층부터 12% 미믹');
  E.ev('setRng(seededRng(2));S.floor=1');
  assert.equal(E.json('openTreasure()').mimic, false, '1층은 미믹 없음');
  assert.equal(E.ev('treasurePick(0)'), null, '열기 전에는 못 고름');
  E.ev('treasureOpen()');
  const g = E.ev('S.ctx.gold'), g0 = E.ev('S.gold');
  assert.equal(E.ev('treasureGold()'), g);
  assert.equal(E.ev('S.gold'), g0 + g);
  E.ev('S.maxhp=100;S.hp=90');
  assert.equal(E.ev('eatApple("red")'), 10, '최대 체력을 넘지 않음');
  assert.equal(E.ev('eatApple("gold")'), 6);
  assert.equal(E.ev('S.maxhp'), 106);
  E.ev('S.ctx={done:0}');
  assert.equal(E.ev('forgeUpgrade(upgradable()[0])&&!forgeUpgrade(upgradable()[0])'), true, '대장간 강화는 1회');
});

test('여신의 이벤트: 룰렛·주사위 대결·거래', () => {
  const E = boot();
  const wheel = E.json('WHEEL.map(w=>w.k)');
  for (const [k, check] of [['gold', 'S.gold===140'], ['heal', 'S.hp===60'], ['hurt', 'S.hp===40'], ['maxhp', 'S.maxhp===65&&S.hp===55'], ['halve', 'S.gold===50'], ['none', 'S.gold===100'], ['item', 'S.eq.length===5'], ['upgrade', 'S.ctx.pendUp===1']]) {
    E.ev(`S=createRun('warrior',0);S.gold=100;S.hp=50;S.ctx={type:'roulette',done:0};S.ctx.res=${wheel.indexOf(k)};S.ctx.applied=0`);
    assert.equal(E.json('applyWheel()').k, k);
    assert.equal(E.ev(check), true, `룰렛 ${k}`);
    assert.equal(E.ev('applyWheel()'), null, '결과는 한 번만 적용');
  }
  E.ev(`S=createRun('warrior',0);S.ctx={type:'roulette',done:0};setRng(()=>.99)`);
  assert.equal(E.ev('spinWheel()'), 7);
  E.ev('setRng(()=>0)');
  assert.equal(E.ev('spinWheel()'), 7, '이미 정해진 결과는 다시 뽑지 않음');

  E.ev(`S=createRun('warrior',0);S.gold=30;S.ctx={type:'duel',done:0}`);
  assert.equal(E.ev('duel(50)'), null, '판돈 부족');
  E.dice(6, 6, 1, 1);
  assert.equal(E.json('duel(20)').win, 1);
  assert.equal(E.ev('S.gold'), 50);
  assert.equal(E.ev('duel(20)'), null, '대결은 한 번');

  E.ev(`S=createRun('warrior',0);S.hp=12;S.gold=40;S.ctx={type:'deal',done:0}`);
  assert.equal(E.ev('canDealBlood()'), false, '체력 12 이하는 피의 거래 불가');
  assert.ok(E.json('dealCoin()'));
  assert.deepEqual(E.json('[S.gold,S.ctx.done,S.eq.some(it=>it.u===1&&it.id===S.ctx.upId)]'), [0, 1, true]);
});

test('이전 버전 세이브(tests/fixtures)는 최신 형식으로 불러와진다', () => {
  const E = boot();
  const V = E.ev('SAVE_V');
  const dir = new URL('./fixtures/', import.meta.url);
  const load = f => E.json(`parseSave(${JSON.stringify(readFileSync(new URL(f, dir), 'utf8'))})`);
  const files = readdirSync(dir).filter(f => /^save-v\d+.*\.json$/.test(f));
  assert.ok(files.length >= 3, 'fixture가 없음');
  for (const f of files) {
    const r = load(f);
    assert.ok(r.s, `${f}: 불러오기 실패 (${r.note})`);
    assert.equal(r.s.v, V, `${f}: 최신 버전(${V})으로 변환되지 않음`);
    assert.equal(r.note, null, `${f}: 손상 복구가 일어남 (${r.note})`);
  }
  const deal = load('save-v1-deal-msg.json').s.ctx;
  assert.deepEqual([deal.got, deal.msg], [{ id: 'rapier', u: 1 }, undefined], 'v1 거래 문구 → 받은 장비');
  assert.equal(load('save-v1-deal-upgrade.json').s.ctx.upId, 'buckler', 'v1 거래 문구 → 강화한 장비');
  const c = load('save-v1-combat.json').s;
  assert.deepEqual([c.screen, c.combat.phase, c.combat.dice.length > 0], ['combat', 'player', true]);
  // 1 ~ SAVE_V-1 모든 버전에 다음 버전으로 가는 변환이 있어야 한다
  for (let v = 1; v < V; v++) assert.equal(E.ev(`typeof MIGRATIONS[${v}]`), 'function', `v${v} → v${v + 1} 변환 없음`);
});

test('오류 복구용: 전투 처음부터 다시 · 보상 없이 건너뛰기', () => {
  const E = boot();
  // 미믹처럼 체력을 바꿔 만든 전투도 같은 조건으로 다시 시작한다
  E.ev(`S=createRun('warrior',0);S.floor=2;visitNode(0,0);S.hp=50;createCombat('normal','mimic',{hp:34});beginPlayerTurn();
    S.hp=12;S.gold=3;S.combat.E.hp=5;S.combat.turn=4;S.combat.pst.poison=3`);
  E.ev('restartCombat()');
  assert.deepEqual(E.json('[S.hp,S.gold,S.combat.E.hp,S.combat.E.maxhp,S.combat.turn,S.combat.phase,S.combat.pst,S.screen]'), [50, 15, 34, 34, 1, 'start', {}, 'combat'], '체력·골드는 전투 시작 값으로');
  // gold0이 없는 옛 세이브의 전투는 골드를 건드리지 않는다
  E.ev('delete S.combat.gold0;S.gold=9;restartCombat()');
  assert.equal(E.ev('S.gold'), 9);
  // 건너뛰기: 일반 방은 맵으로, 보스방은 다음 층으로 (보상 없음)
  const g = E.ev('S.gold');
  assert.equal(E.ev('skipCombat()'), true);
  assert.deepEqual(E.json('[S.screen,S.combat,S.gold,S.ctx]'), ['map', null, g, null]);
  assert.equal(E.ev('skipCombat()'), false, '전투가 없으면 아무것도 안 함');
  E.ev(`S.pos={r:6,i:0};createCombat('boss','slot')`);
  E.ev('skipCombat()');
  assert.deepEqual(E.json('[S.screen,S.floor,S.pos]'), ['floor', 3, null]);
});

test('오류 복구용: 전투가 아닌 방을 그대로 나가기', () => {
  const E = boot();
  for (const [setup, screen] of [["S.gold=200;openShop()", 'map'], ["S.ctx={type:'deal',done:0};S.screen='event'", 'map'], ["S.ctx={};S.screen='apple'", 'map'], ["S.pos={r:6,i:0};S.ctx={items:[],enemy:{}};S.screen='reward'", 'floor']]) {
    E.ev(`S=createRun('warrior',0);${setup}`);
    assert.equal(E.ev('leaveRoom()'), true, setup);
    assert.deepEqual(E.json('[S.screen,S.ctx]'), [screen, null], setup);
  }
  E.ev(`S=createRun('warrior',0);S.screen='map'`);
  assert.equal(E.ev('leaveRoom()'), false, '맵·전투 화면은 대상이 아님');
});

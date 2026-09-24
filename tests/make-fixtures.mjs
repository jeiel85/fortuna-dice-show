// 릴리스 태그의 엔진으로 "그 버전의 실제 세이브"를 만들어 tests/fixtures에 저장한다.
// engine.test.mjs는 fixtures의 모든 세이브가 최신 형식(SAVE_V)으로 불러와지는지 검사한다.
//
// 사용: node tests/make-fixtures.mjs <태그> [--force]
//   예) 저장 형식을 바꿔 SAVE_V를 올리기 전에, 직전 릴리스로 실행해 그 버전의 세이브를 남겨 둔다.
//       node tests/make-fixtures.mjs v1.3.0   → tests/fixtures/save-v2-*.json
//   이미 있는 파일은 건너뛴다 (--force로 덮어쓰기). 엔진 블록이 있는 v1.1.0 이상 태그에서 동작하며,
//   그 태그에 없는 함수를 쓰는 장면(상점·보물 상자 등은 v1.2.0부터)은 건너뛴다.
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import vm from 'node:vm';

const [tag, ...flags] = process.argv.slice(2);
const force = flags.includes('--force');
if (!tag || tag.startsWith('-')) { console.error('사용법: node tests/make-fixtures.mjs <태그> [--force]'); process.exit(2) }

const root = new URL('..', import.meta.url);
let html;
try { html = execFileSync('git', ['show', `${tag}:index.html`], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }) }
catch { console.error(`태그 ${tag}의 index.html을 읽을 수 없습니다.`); process.exit(2) }
const m = html.match(/<script id="engine">([\s\S]*?)<\/script>/);
if (!m) { console.error(`${tag}에는 엔진 블록이 없습니다. v1.1.0 이상 태그를 지정하세요.`); process.exit(2) }

const ctx = vm.createContext({});
vm.runInContext(m[1], ctx, { filename: `${tag}/engine.js` });
const ev = code => vm.runInContext(code, ctx);
const V = ev('SAVE_V');
const T = 1758600000000; // 고정 시각 (재현용)

// 이름 → 세이브를 만드는 코드. 태그에 없는 함수를 쓰는 장면은 건너뛴다.
const SCENES = {
  'combat': `S=createRun('mage',${T});S.level=3;visitNode(0,0);createCombat('normal','bat');beginPlayerTurn();S.combat.pst.poison=2;S.combat.E.st.weak=1`,
  'enemy-turn': `S=createRun('warrior',${T});visitNode(0,0);createCombat('normal','rat');beginPlayerTurn();endPlayerTurn();enemyTurnBegin();enemyAct()`,
  'map': `S=createRun('thief',${T});visitNode(0,0);advanceNode();S.gold=77;S.bag.push({id:'bow',u:1})`,
  'reward': `S=createRun('gambler',${T});visitNode(0,0);createCombat('normal','slime');S.combat.E.hp=0;resolveVictory()`,
  'shop': `S=createRun('warrior',${T});S.gold=200;openShop();buyItem(0)`,
  'treasure': `S=createRun('mage',${T});setRng(()=>.5);openTreasure();treasureOpen()`,
  'event-deal': `S=createRun('gambler',${T});S.gold=100;S.ctx={type:'deal',done:0};S.screen='event';dealCoin()`,
  'event-roulette': `S=createRun('thief',${T});S.ctx={type:'roulette',done:0};S.screen='event';spinWheel();applyWheel()`,
};

mkdirSync(new URL('fixtures/', import.meta.url), { recursive: true });
let made = 0;
for (const [name, code] of Object.entries(SCENES)) {
  const file = new URL(`fixtures/save-v${V}-${name}.json`, import.meta.url);
  if (existsSync(file) && !force) { console.log(`건너뜀 (이미 있음): save-v${V}-${name}.json`); continue }
  try {
    ev('setRng(seededRng(7))');
    const json = ev(`${code};JSON.stringify(S)`);
    writeFileSync(file, JSON.stringify(JSON.parse(json), null, 1) + '\n');
    console.log(`생성: save-v${V}-${name}.json`); made++;
  } catch (e) { console.log(`건너뜀 (${tag}에서 만들 수 없음): ${name} — ${e.message}`) }
}
console.log(`${tag} (SAVE_V=${V}): ${made}개 생성`);

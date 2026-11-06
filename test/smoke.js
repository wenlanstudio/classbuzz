'use strict';
// 协议级冒烟测试：起真实服务，用 WS 客户端走完整课堂流程。
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const assert = require('assert/strict');
const WebSocket = require('ws');

const PORT = Number(process.env.SMOKE_PORT) || 3199;
const BASE = `http://127.0.0.1:${PORT}`;

function get(p) {
  return new Promise((resolve, reject) => {
    http.get(BASE + p, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

/** 分组断言：名字说清楚"在验什么"，失败时只杀这条不中断后面的用例。支持异步。 */
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    console.error(`  FAIL  ${name}\n        ${error.message}`);
    process.exitCode = 1;
  }
}

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const buf = [];
  const waiters = [];
  ws.on('message', d => {
    const m = JSON.parse(d);
    const i = waiters.findIndex(w => w.types.includes(m.type));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else buf.push(m);
  });
  const opened = new Promise(r => ws.on('open', r));
  return {
    ws, opened,
    send: o => ws.send(JSON.stringify(o)),
    next: (...args) => {
      const types = args.filter(a => Array.isArray(a) ? false : typeof a === 'string');
      const timeout = args.find(a => typeof a === 'number') || 6000;
      return new Promise((resolve, reject) => {
        const idx = buf.findIndex(m => types.includes(m.type));
        if (idx >= 0) return resolve(buf.splice(idx, 1)[0]);
        if (process.env.SMOKE_TRACE) process.stderr.write('  wait: ' + types.join(',') + '\n');
        waiters.push({ types, resolve });
        setTimeout(() => reject(new Error(`timeout waiting [${types}]`)), timeout);
      });
    },
    /** 丢掉已缓冲的某些类型消息（广播类消息每个客户端都会收到，用例里常常先攒着） */
    drain: (...types) => {
      for (let i = buf.length - 1; i >= 0; i--) if (types.includes(buf[i].type)) buf.splice(i, 1);
    },
    close: () => ws.close(),
    /** 丢掉已缓冲的某些类型消息（广播类消息每个客户端都会收到，用例里常常先攒着） */
    drain: (...types) => {
      for (let i = buf.length - 1; i >= 0; i--) if (types.includes(buf[i].type)) buf.splice(i, 1);
    },
  };
}

async function main() {
  const srv = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', d => process.env.SMOKE_VERBOSE && process.stdout.write('[srv] ' + d));
  srv.stderr.on('data', d => process.stderr.write('[srv!] ' + d));
  try {
    for (let i = 0; i < 50; i++) {
      try { await get('/'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
    }

    /* ---- 静态页 ---- */
    for (const p of ['/', '/host', '/board', '/play', '/style.css', '/net.js', '/qr?text=hello']) {
      const r = await get(p);
      assert.equal(r.status, 200, `GET ${p}`);
    }

    /* ---- 房间 + 名单 ---- */
    const host = client(); await host.opened;
    host.send({ type: 'host_create' });
    const hostOk = await host.next('host_ok');
    const { room: CODE, token: HOST_TOKEN } = hostOk;
    assert.match(CODE, /^[23456789A-Z]{4}$/);

    host.send({ type: 'host_import_roster', rows: [
      ['20230001', '张三'], ['20230002', '李四'], ['20230003', '王五'], ['20230004', '赵六'],
    ] });
    const rosterOk = await host.next('roster_ok');
    assert.equal(rosterOk.count, 4);
    assert.equal(rosterOk.strict, true);

    /* ---- 第二个教师端接入（房间号 + 房口令）：口令错 → 拒；口令对 → 拿到 host 角色 ---- */
    const PASS = hostOk.snapshot.passcode;
    assert.match(PASS, /^[23456789A-Z]{6}$/, '房口令应为 6 位易混字符除外的大写字母数字');

    const bad = client(); await bad.opened;
    bad.send({ type: 'host_attach', room: CODE, passcode: 'ZZZZZZ' });
    const badFail = await bad.next('host_attach_fail');
    assert.match(badFail.reason, /房口令不正确/);
    bad.close();

    // md2slides 那一端：凭口令接入，拿到 host 角色
    const co = client(); await co.opened;
    co.send({ type: 'host_attach', room: CODE, passcode: PASS });
    const coOk = await co.next('host_attach_ok');
    assert.equal(coOk.room, CODE);
    assert.equal(coOk.snapshot.role, 'host');
    assert.equal(coOk.snapshot.passcode, PASS);

    /* ---- 入房：名单校验 / 名单外拒入 / 大屏观战 ---- */
    const p1 = client(); await p1.opened;
    p1.send({ type: 'join', room: CODE, sid: '20230001' });
    const j1 = await p1.next('join_ok');
    assert.equal(j1.snapshot.me.name, '张三');
    const T1 = j1.token;

    const px = client(); await px.opened;
    px.send({ type: 'join', room: CODE, sid: '99999999' });
    const jx = await px.next('join_fail');
    assert.match(jx.reason, /学号不在名单/);
    px.close();

    const p2 = client(); await p2.opened;
    p2.send({ type: 'join', room: CODE, sid: '20230002' });
    const j2 = await p2.next('join_ok');
    assert.equal(j2.snapshot.me.name, '李四');
    const T2 = j2.token;

    const board = client(); await board.opened;
    board.send({ type: 'join', room: CODE, spectate: true });
    const jb = await board.next('join_ok');
    assert.equal(jb.role, 'spectator');

    /* ---- 开题：answer 不下发 ---- */
    host.send({ type: 'host_open', stem: '1+1=?', options: ['1', '2', '3', '4'], answer: 'B', limitSec: 30 });
    const open1 = await p1.next('question_open');
    assert.equal(open1.options.length, 4);
    assert.equal('answer' in open1, false, '作答期间不得下发 answer');
    assert.equal(typeof open1.deadline, 'number');

    /* ---- 中途进房观战本题 ---- */
    const p3 = client(); await p3.opened;
    p3.send({ type: 'join', room: CODE, sid: '20230003' });
    const j3 = await p3.next('join_ok');
    assert.equal(j3.snapshot.me.name, '王五');
    assert.equal(j3.snapshot.question.blocked, true, '开题后进房应观战');

    /* ---- 作答 + 计分 ---- */
    p1.send({ type: 'answer', choice: 1 });
    const a1 = await p1.next('answer_ack');
    assert.equal(a1.accepted, true);
    assert.ok(a1.elapsedMs < 2000);

    const prog = await board.next('progress');
    assert.equal(prog.answered, 1);
    assert.equal(prog.total, 3);

    p2.send({ type: 'answer', choice: 0 }); // 李四答错
    const a2 = await p2.next('answer_ack');
    assert.equal(a2.accepted, true);

    // 未加入房间的连接直接作答 → 拒绝
    const dup = client(); await dup.opened;
    dup.send({ type: 'answer', choice: 1 });
    const err0 = await dup.next('error');
    assert.match(err0.message, /请先加入房间/);
    dup.close();

    /* ---- 重复提交拒收 ---- */
    p1.send({ type: 'answer', choice: 2 });
    const a1b = await p1.next('answer_ack');
    assert.equal(a1b.accepted, false);
    assert.match(a1b.reason, /已提交/);

    /* ---- 全员提交自动收卷（王五观战不算）→ 不自动，改手动收卷 ---- */
    host.send({ type: 'host_close' });
    const res1 = await p1.next('question_result');
    assert.equal(res1.answer, 1);
    assert.equal('answer' in res1, true, '揭晓后应下发 answer');
    assert.deepEqual(res1.distribution, [1, 1, 0, 0]);
    assert.equal(res1.fastest.name, '张三');
    assert.equal(res1.leaderboard[0].name, '张三');
    assert.ok(res1.leaderboard[0].score >= 95, `速度分应接近满分，实际 ${res1.leaderboard[0].score}`);
    assert.equal(res1.leaderboard[0].score <= 100, true);

    const sr1 = await p1.next('self_result');
    assert.equal(sr1.correct, true);
    assert.equal(sr1.choice, 1);
    assert.equal(sr1.rank, 1);
    const sr2 = await p2.next('self_result');
    assert.equal(sr2.correct, false);
    assert.equal(sr2.gained, 0);

    /* ---- 断线重连 + 同号顶替 ---- */
    const p1b = client(); await p1b.opened;
    p1b.send({ type: 'resume', token: T1 });
    const sy = await p1b.next('sync');
    assert.equal(sy.snapshot.phase, 'revealed');
    assert.equal(sy.snapshot.lastResult.answer, 1);
    assert.equal(sy.snapshot.me.rank, 1);
    const scoreAfterQ1 = sy.snapshot.me.score;

    const rep = await p1.next('replaced', 3000);
    assert.equal(rep.type, 'replaced');

    /* ---- 成绩导出（含未进入的王五）---- */
    const csv = await get(`/export/${CODE}?token=${HOST_TOKEN}`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers['content-type'], /csv/);
    assert.match(csv.body, /学号,姓名,出勤/);
    assert.match(csv.body, /20230001,张三/);
    assert.match(csv.body, /20230004,赵六,未进入/);
    const csvBad = await get(`/export/${CODE}?token=wrong`);
    assert.equal(csvBad.status, 403);

    /* ---- 到期自动收卷（无人作答）---- */
    host.send({ type: 'host_next' });
    await host.next('room_state');
    host.send({ type: 'host_open', stem: '2+2=?', options: ['3', '4'], answer: 1, limitSec: 5 });
    const open2 = await p1b.next('question_open');
    assert.equal(open2.limitSec, 5);
    const res2 = await p1b.next('question_result', 9000);
    assert.equal(res2.fastest, null);
    assert.deepEqual(res2.distribution, [0, 0]);

    /* ---- 作废本题：已交分数回滚 ---- */
    host.send({ type: 'host_open', stem: '3+3=?', options: ['5', '6'], answer: 1, limitSec: 30 });
    await p1b.next('question_open');
    p1b.send({ type: 'answer', choice: 1 });
    await p1b.next('answer_ack');
    host.send({ type: 'host_abort' });
    const ab = await p1b.next('round_closed');
    assert.equal(ab.reason, 'host_abort');
    const sy2 = client(); await sy2.opened;
    sy2.send({ type: 'resume', token: T1 });
    const sy2r = await sy2.next('sync');
    assert.equal(sy2r.snapshot.me.score, scoreAfterQ1, '作废后张三应回滚到上一题后的得分');
    sy2.close();

    /* ---- 第二个教师端（md2slides 那侧）开题：两端都在线，互不顶替 ---- */
    // 两端一路收着广播但没取过 question_open / question_result / room_state，这里先清掉存量
    host.drain('question_open', 'question_result', 'room_state');
    co.drain('question_open', 'question_result', 'room_state');
    co.send({ type: 'host_open', stem: '4+4=?', options: ['7', '8', '9'], answer: 1, limitSec: 30 });
    const open3 = await co.next('question_open');
    assert.equal(open3.stem, '4+4=?');
    // 主教师端也收到了同一道题（房间内广播），且没有收到 replaced
    const open3b = await host.next('question_open');
    assert.equal(open3b.stem, '4+4=?');
    p2.send({ type: 'answer', choice: 1 });   // 李四作答（p1b 已被上面的 sy2 重连顶替）
    await p2.next('answer_ack');
    co.send({ type: 'host_close' });
    const res3 = await co.next('question_result');
    assert.equal(res3.answer, 1);
    assert.deepEqual(res3.distribution, [0, 1, 0]);
    assert.equal(res3.fastest.name, '李四');
    // 两端都还活着：主教师端还能开下一题（没被顶替下线）
    host.send({ type: 'host_next' });
    await host.next('room_state');

    /* ---- 成绩管理：明细 / 单人清零 / 全班清零 / 进行中拒清 ---- */
    // 成绩页用的是 host_attach（房口令），跟教师页并存；拉明细、清零都走它
    const sc = client(); await sc.opened;
    sc.send({ type: 'host_attach', room: CODE, passcode: PASS });
    await sc.next('host_attach_ok');
    sc.drain('room_state', 'question_open');

    sc.send({ type: 'host_scores' });
    const sd0 = await sc.next('host_scores');
    check('成绩明细：名单全员在列，未进房的也占一行', () => {
      assert.equal(sd0.students.length, 4, '4 人名单应出 4 行');
      const absent = sd0.students.find(s => s.name === '赵六');
      assert.ok(absent, '未进入的学生也要在列（不然成绩页看不到缺席）');
      assert.equal(absent.firstSeen, null);
      assert.equal(absent.score, 0);
      const li = sd0.students.find(s => s.name === '李四');
      assert.ok(li.score > 0, '李四答对过 4+4，分数应 > 0');
      assert.equal(li.answers, 2, '答过 1+1（错）与 4+4（对）两题');
      assert.equal(li.correct, 1);
    });

    sc.send({ type: 'host_reset_player', sid: '20230002' });
    const sd1 = await sc.next('host_scores');
    check('单人清零：只动指定学生，其他人原样', () => {
      const li = sd1.students.find(s => s.name === '李四');
      assert.equal(li.score, 0);
      assert.equal(li.answers, 0);
      assert.equal(li.correct, 0);
      assert.equal(li.fastestMs, null);
    });
    await check('单人清零后：学生端收到自己的新分数（手机不能挂着旧分）', async () => {
      const self = await p2.next('self_score', 3000);
      assert.equal(self.score, 0);
      assert.ok(Number.isInteger(self.rank) && self.rank > 0);
    });
    /* 有题在进行 → 拒清（这题分数还没入账，清了会算乱账） */
    host.send({ type: 'host_open', stem: '5+5=?', options: ['9', '10', '11'], answer: 1, limitSec: 30 });
    await sc.next('question_open');
    sc.send({ type: 'host_reset_scores' });
    const errReset = await sc.next('error');
    check('有题进行中 → 拒清并说明原因', () => {
      assert.match(errReset.message, /有题正在进行/);
    });
    // 李四答对 5+5 攒点分，供下面的"清零后学生端刷新"用
    p2.send({ type: 'answer', choice: 1 });
    await p2.next('answer_ack');
    host.send({ type: 'host_close' });
    await sc.next('question_result');

    /* 作废已收卷的题：不该误发 round_closed。
       以前 host_abort 无条件广播，对一道已揭晓的点"作废"会清空大屏、学生跳待机，
       分数却一分没动——老师以为撤了，其实没有。 */
    const closedFired = await Promise.race([
      sc.next('round_closed', 700).then(() => true).catch(() => false),
      new Promise(r => setTimeout(() => r(false), 900)),
    ]);
    check('作废已收卷的题：不误发 round_closed', () => {
      host.send({ type: 'host_abort' });
      assert.equal(closedFired, false);
    });

    sc.drain('question_open', 'question_result');
    board.drain('scores_reset');
    p2.drain('self_score');
    sc.send({ type: 'host_reset_scores' });
    const sd2 = await sc.next('host_scores');
    check('全班清零：全员归零，玩家与名单不动', () => {
      assert.equal(sd2.students.length, 4, '清零不该把人清走');
      assert.ok(sd2.students.every(s => s.score === 0 && s.answers === 0 && s.correct === 0));
    });
    const resetBcast = await board.next('scores_reset', 3000);
    check('全班清零：广播 scores_reset（大屏榜单跟着换）', () => {
      assert.equal(resetBcast.scope, 'all');
      assert.ok(Array.isArray(resetBcast.leaderboard));
      assert.ok(resetBcast.leaderboard.every(e => e.score === 0));
    });
    const selfAfter = await p2.next('self_score', 3000);
    check('全班清零后：学生端分数同步归零', () => {
      assert.equal(selfAfter.score, 0);
    });
    // CSV 与成绩页同一份口径（清零后导出的也是 0）
    const csv2 = await get(`/export/${CODE}?token=${HOST_TOKEN}`);
    check('清零后 CSV 同步为 0', () => {
      assert.match(csv2.body, /20230001,张三/);
      const li = csv2.body.split('\r\n').find(l => l.startsWith('20230002'));
      assert.match(li, /,0,0,0,/);
    });

    /* ---- 自由昵称模式（无名单房间）---- */
    const host2 = client(); await host2.opened;
    host2.send({ type: 'host_create' });
    const h2 = await host2.next('host_ok');
    const f = client(); await f.opened;
    f.send({ type: 'join', room: h2.room, name: '小明' });
    const jf = await f.next('join_ok');
    assert.equal(jf.snapshot.me.name, '小明');
    assert.equal(jf.snapshot.me.sid, '');

    /* ---- 房间不存在 ---- */
    const g = client(); await g.opened;
    g.send({ type: 'join', room: 'ZZZZ' });
    assert.match((await g.next('join_fail')).reason, /房间不存在/);

    console.log(`SMOKE PASS — ${passed} 组分组断言 + 裸断言全部通过`);
    [host, co, sc, p1, p1b, p2, p3, board].forEach(c => c.close());
  } finally {
    srv.kill();
  }
}

main().then(
  () => process.exit(0),
  e => { console.error('SMOKE FAIL:', e.stack || e.message); process.exit(1); }
);

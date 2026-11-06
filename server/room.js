'use strict';
// 房间与回合状态机：判分、计时、排名全在服务端，客户端只做展示。
const crypto = require('crypto');

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // 去掉 0/1/I/L/O 等易混字符
const SCORE_BASE = 60;   // 答对保底分
const SCORE_SPEED = 40;  // 速度加成上限：得分 = 60 + 40 × 剩余时间比例

function uid() { return crypto.randomUUID(); }

/**
 * 房口令：6 位、避开易混字符，教师口头/抄写给学生端以外的人（比如 md2slides 宿主）用。
 *
 * 为什么不用 hostToken 直接授权：hostToken 是 36 位 UUID，藏在教师浏览器的 localStorage 里，
 * 别的进程（Typora 插件里的 md2slides）读不到，要用只能靠人手抄——不可接受。
 * 口令位数 30^6 ≈ 7.3 亿，课堂场景猜不中；同时够短到老师能口述。
 */
function makePasscode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}

function computeGained(elapsedMs, limitMs) {
  return Math.round(SCORE_BASE + SCORE_SPEED * Math.max(0, limitMs - elapsedMs) / limitMs);
}

function letterToIndex(a) {
  return typeof a === 'string' && /^[A-Fa-f]$/.test(a) ? a.toUpperCase().charCodeAt(0) - 65 : Number(a);
}

class Room {
  constructor(code, log) {
    this.code = code;
    this.hostToken = uid();
    this.passcode = makePasscode();  // 房口令：第二个教师端（md2slides 等）凭它接入
    this.log = log || (() => {});
    this.phase = 'idle';        // idle | open | revealed
    this.roster = null;         // Map<sid, name>；null = 自由昵称模式
    this.strict = true;         // 学号必须在名单内才能进入
    this.players = new Map();   // token -> player
    this.bySid = new Map();     // sid -> token（同学号新连接顶替旧连接）
    this.scores = new Map();    // token -> 累计分
    this.current = null;        // open/revealed 阶段的 Round
    this.lastResult = null;     // revealed 阶段的重连快照
    this.createdAt = Date.now();
    this.closeTimer = null;
  }

  join({ sid, name }) {
    sid = String(sid || '').trim();
    name = String(name || '').trim();
    if (this.roster) {
      if (!sid) return { error: '请输入学号' };
      const rosterName = this.roster.get(sid);
      if (!rosterName) {
        if (this.strict) return { error: '学号不在名单' };
        name = sid + '（名单外）';
      } else {
        name = rosterName;
      }
    } else if (!name) {
      return { error: '请输入姓名' };
    }
    let token = this.roster ? this.bySid.get(sid) : null;
    if (!token) {
      token = uid();
      if (this.roster) this.bySid.set(sid, token);
      // 自由昵称模式重名追加序号；名单模式姓名以学号区分，允许同名
      if (!this.roster) {
        const base = name;
        let n = 2;
        while ([...this.players.values()].some(p => p.name === name)) name = base + n++;
      }
      this.players.set(token, {
        token, sid: this.roster ? sid : '', name,
        firstSeen: Date.now(), lastSeen: Date.now(),
        blockedQid: null, // 开题后才进房：本题观战
        stats: { answers: 0, correct: 0, fastestMs: null },
      });
      this.log({ event: 'join', sid, name });
    } else {
      this.players.get(token).lastSeen = Date.now();
    }
    this.scores.has(token) || this.scores.set(token, 0);
    const p = this.players.get(token);
    if (this.phase === 'open') p.blockedQid = this.current.qid;
    return { token, player: p };
  }

  resumeRole(token) {
    if (token === this.hostToken) return 'host';
    if (this.players.has(token)) return 'player';
    return null;
  }

  /**
   * 房口令校验：第二个教师端（md2slides 的竞答宿主）用它换取 host 角色。
   * 口令错了就是错了——不给"提示哪个字符不对"，避免被逐位试出来。
   */
  checkPasscode(code) {
    const given = String(code ?? '').trim().toUpperCase();
    return given.length === 6 && given === this.passcode;
  }

  openQuestion({ qid, stem, options, answer, limitSec }) {
    if (this.phase === 'open') return { error: '已有题目进行中，请先收卷或作废' };
    stem = String(stem || '').trim();
    if (!stem) return { error: '题干不能为空' };
    if (!Array.isArray(options)) return { error: '选项无效' };
    options = options.map(s => String(s).trim()).filter(s => s !== '');
    if (options.length < 2 || options.length > 6) return { error: '选项需 2-6 个' };
    answer = letterToIndex(answer);
    if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) return { error: '正确答案无效' };
    limitSec = Math.min(300, Math.max(5, Math.floor(Number(limitSec) || 30)));
    const openAt = Date.now();
    this.current = {
      qid: String(qid || uid().slice(0, 8)), stem, options, answer, limitSec,
      openAt, deadline: openAt + limitSec * 1000,
      answers: new Map(), // token -> {choice, elapsedMs, gained, correct}
    };
    this.phase = 'open';
    this.lastResult = null;
    // 到点 +250ms 再收卷，deadline 最后一刻的提交仍按服务端时间判定有效；
    // onReveal 由 index.js 注入（定时收卷也要走广播流程）
    this.closeTimer = setTimeout(() => {
      const out = this.closeRound('deadline');
      if (out && this.onReveal) this.onReveal(out);
    }, limitSec * 1000 + 250);
    this.log({ event: 'question_open', qid: this.current.qid, stem, options, answer, limitSec });
    return {
      broadcast: {
        qid: this.current.qid, stem, options, limitSec, openAt, deadline: this.current.deadline,
      },
    };
  }

  answer(token, choice) {
    if (this.phase !== 'open') return { error: '本题已截止' };
    const r = this.current;
    const p = this.players.get(token);
    if (!p) return { error: '未加入房间' };
    if (p.blockedQid === r.qid) return { error: '你是开题后进来的，本题观战，下一题可参与' };
    if (r.answers.has(token)) return { error: '已提交，不能修改' };
    if (!Number.isInteger(choice) || choice < 0 || choice >= r.options.length) return { error: '选项无效' };
    const now = Date.now();
    if (now > r.deadline) return { error: '已截止' };
    const elapsedMs = now - r.openAt;
    const gained = computeGained(elapsedMs, r.limitSec * 1000);
    const rec = { choice, elapsedMs, gained, correct: choice === r.answer };
    r.answers.set(token, rec);
    // 此处不加分：答对才计分，统一在收卷时入账（见 closeRound）
    this.log({ event: 'answer', qid: r.qid, sid: p.sid, name: p.name, ...rec });
    return { rec };
  }

  closeRound(reason) {
    if (this.phase !== 'open') return null;
    clearTimeout(this.closeTimer);
    this.closeTimer = null;
    const r = this.current;
    const distribution = r.options.map(() => 0);
    let fastest = null;
    for (const [token, a] of r.answers) {
      distribution[a.choice]++;
      const p = this.players.get(token);
      p.stats.answers++;
      if (a.correct) {
        // 答对才计分：速度分在揭晓时统一入账
        this.scores.set(token, (this.scores.get(token) || 0) + a.gained);
        p.stats.correct++;
        if (p.stats.fastestMs == null || a.elapsedMs < p.stats.fastestMs) p.stats.fastestMs = a.elapsedMs;
        if (!fastest || a.elapsedMs < fastest.elapsedMs) fastest = { name: p.name, elapsedMs: a.elapsedMs };
      }
    }
    this.lastResult = {
      qid: r.qid, stem: r.stem, options: r.options, answer: r.answer,
      distribution, fastest, leaderboard: this.leaderboard(),
    };
    this.phase = 'revealed';
    this.log({
      event: 'question_result', qid: r.qid, reason, answer: r.answer, distribution, fastest,
      perPlayer: [...r.answers].map(([t, a]) => {
        const p = this.players.get(t);
        return { sid: p.sid, name: p.name, ...a };
      }),
    });
    return { round: r };
  }

  /**
   * 作废进行中的题：分数在收卷时才入账，直接丢弃即可。
   * @returns {boolean} 是否真的作废了（已收卷 / 待机时调用返回 false）——
   *   协议层据此决定要不要广播 round_closed，别把"什么都没发生"也通知全员。
   */
  abort() {
    if (this.phase !== 'open') return false;
    clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.log({ event: 'round_aborted', qid: this.current.qid, submitted: this.current.answers.size });
    this.current = null;
    this.phase = 'idle';
    return true;
  }

  next() {
    clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.current = null;
    this.phase = 'idle';
    this.lastResult = null;
  }

  leaderboard() {
    return [...this.players.values()]
      .map(p => ({ token: p.token, sid: p.sid, name: p.name, score: this.scores.get(p.token) || 0 }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh'))
      .map((e, i) => ({ rank: i + 1, ...e }));
  }

  publicResult() {
    if (!this.lastResult) return null;
    const { leaderboard, ...rest } = this.lastResult;
    return { ...rest, leaderboard: leaderboard.map(({ token, ...r }) => r) };
  }

  playerSnapshot(token) {
    const p = this.players.get(token);
    const r = this.current;
    const lb = this.leaderboard();
    const rank = (lb.findIndex(e => e.token === token) + 1) || null;
    return {
      role: 'player', code: this.code, phase: this.phase, playerCount: this.players.size,
      me: { sid: p.sid, name: p.name, score: this.scores.get(token) || 0, rank },
      question: this.phase === 'open' && r ? {
        qid: r.qid, stem: r.stem, options: r.options, limitSec: r.limitSec,
        openAt: r.openAt, deadline: r.deadline,
        answered: r.answers.size, total: this.players.size,
        blocked: p.blockedQid === r.qid,
      } : null,
      myAnswer: this.phase === 'open' && r && r.answers.has(token) ? r.answers.get(token).choice : null,
      lastResult: this.phase === 'revealed' ? this.publicResult() : null,
    };
  }

  hostSnapshot() {
    const r = this.current;
    return {
      role: 'host', code: this.code, phase: this.phase, playerCount: this.players.size,
      rosterSize: this.roster ? this.roster.size : 0, strict: this.strict,
      // 房口令随快照下发：教师页显示它，老师把它抄给第二个教师端（md2slides）。
      passcode: this.passcode,
      question: this.phase === 'open' && r ? {
        qid: r.qid, stem: r.stem, options: r.options, limitSec: r.limitSec,
        answered: r.answers.size, total: this.players.size,
      } : null,
      lastResult: this.phase === 'revealed' ? this.publicResult() : null,
    };
  }

  spectatorSnapshot() {
    const r = this.current;
    return {
      role: 'spectator', code: this.code, phase: this.phase, playerCount: this.players.size,
      question: this.phase === 'open' && r ? {
        qid: r.qid, stem: r.stem, options: r.options, limitSec: r.limitSec,
        openAt: r.openAt, deadline: r.deadline, answered: r.answers.size, total: this.players.size,
      } : null,
      lastResult: this.phase === 'revealed' ? this.publicResult() : null,
    };
  }

  /**
   * 成绩明细：成绩管理页与 CSV 导出**共用这一份口径**（两处各算一遍必然漂移）。
   *
   * 名单模式列全班（未进入的也列，`firstSeen: null` → 页面显示「未进入」）；
   * 名单外却进了房的（strict=false）补在末尾并标 `offRoster`——
   * 以前 CSV 会把他们整个漏掉，成绩页不能再漏。
   *
   * @param {Set<string>} [onlineTokens] 当前在线的 token 集合；不给就不判在线
   */
  scoresDetail(onlineTokens = null) {
    const byKey = new Map();
    for (const p of this.players.values()) byKey.set(this.roster ? p.sid : p.name, p);
    const source = this.roster
      ? [...this.roster.entries()]
      : [...this.players.values()].map(p => ['', p.name]);
    const rows = [];
    for (const [sid, name] of source) {
      const p = byKey.get(this.roster ? sid : name);
      rows.push(this.scoreRow(p, {
        sid, name, offRoster: false, onlineTokens,
      }));
    }
    // 名单外进房的（只有 strict=false 才进得来）：按进房时间附在末尾
    if (this.roster) {
      for (const p of this.players.values()) {
        if (this.roster.has(p.sid)) continue;
        rows.push(this.scoreRow(p, { sid: p.sid, name: p.name, offRoster: true, onlineTokens }));
      }
    }
    return rows;
  }

  /** 一个学生 → 一行成绩。`p` 为 null 表示名单里但没进过房。 */
  scoreRow(p, { sid, name, offRoster, onlineTokens }) {
    return {
      sid: p ? p.sid : sid,
      name: p ? p.name : name,
      offRoster,
      score: p ? (this.scores.get(p.token) || 0) : 0,
      answers: p ? p.stats.answers : 0,
      correct: p ? p.stats.correct : 0,
      fastestMs: p ? p.stats.fastestMs : null,
      firstSeen: p ? p.firstSeen : null,
      online: p && onlineTokens ? onlineTokens.has(p.token) : null,
    };
  }

  /**
   * 全班成绩清零：分数、答题统计全部归零，**不动玩家与名单**（学生还在线、房间号不变）。
   * `lastResult` 一并清掉——它带着旧榜单，重连的人会看到已经不算数的结果。
   *
   * 不做「有题在进行中」的检查：那是协议层的事（要不要允许，是策略不是状态）。
   */
  resetScores() {
    for (const token of this.scores.keys()) this.scores.set(token, 0);
    for (const p of this.players.values()) {
      p.stats.answers = 0;
      p.stats.correct = 0;
      p.stats.fastestMs = null;
    }
    this.lastResult = null;
    this.log({ event: 'scores_reset', scope: 'all', players: this.players.size });
  }

  /**
   * 单人成绩清零：代答、作弊、录错时只针对某一个人。
   * @returns {{player: object}|{error: string}}
   */
  resetPlayer(sid) {
    const p = [...this.players.values()].find(
      x => (this.roster ? x.sid : x.name) === String(sid ?? '').trim(),
    );
    if (!p) return { error: '找不到这个学生（可能还没进房）' };
    this.scores.set(p.token, 0);
    p.stats.answers = 0;
    p.stats.correct = 0;
    p.stats.fastestMs = null;
    this.lastResult = null;
    this.log({ event: 'scores_reset', scope: 'player', sid: p.sid, name: p.name });
    return { player: p };
  }

  csv() {
    const pad = n => String(n).padStart(2, '0');
    const fmt = ts => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    const q = v => {
      v = String(v ?? '');
      return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    const rows = [['学号', '姓名', '出勤', '总分', '答题数', '答对数', '最快答对(秒)']];
    // 口径与成绩管理页同一份（scoresDetail），别在这里另算一遍
    for (const r of this.scoresDetail()) {
      rows.push([
        r.sid, r.name,
        r.firstSeen != null ? fmt(r.firstSeen) : '未进入',
        r.score, r.answers, r.correct,
        r.fastestMs != null ? (r.fastestMs / 1000).toFixed(1) : '',
      ]);
    }
    return rows.map(r => r.map(q).join(',')).join('\r\n');
  }
}

class RoomManager {
  constructor(logFactory) {
    this.rooms = new Map();
    this.logFactory = logFactory || (() => () => {});
  }

  newCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < 4; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
  }

  create() {
    const code = this.newCode();
    const room = new Room(code, this.logFactory(code));
    this.rooms.set(code, room);
    room.log({ event: 'room_created' });
    return room;
  }

  get(code) {
    return this.rooms.get(String(code || '').trim().toUpperCase());
  }

  findByToken(token) {
    if (!token) return null;
    for (const room of this.rooms.values()) {
      if (token === room.hostToken || room.players.has(token)) return room;
    }
    return null;
  }
}

module.exports = { Room, RoomManager, computeGained };

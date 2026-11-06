'use strict';
// 服务入口：静态托管 + /export 成绩导出 + /qr 二维码 + WS 消息分发。
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { RoomManager } = require('./room');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = path.join(__dirname, '..', 'data');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

fs.mkdirSync(DATA_DIR, { recursive: true });

// 公网/穿透地址：public-url.txt 第一行非注释内容，或环境变量 CB_PUBLIC_URL
// 教师页用它来生成入房链接和二维码，保证学生走公网而不是局域网。
function publicBase() {
  const env = process.env.CB_PUBLIC_URL;
  if (env && env.trim()) return env.trim().replace(/\/+$/, '');
  try {
    const file = path.join(__dirname, '..', 'public-url.txt');
    const line = fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('#'))[0];
    return line ? line.replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

// 每房间一份 JSONL 对局记录：data/<日期>-<房间号>.jsonl
function logFactory(code) {
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(DATA_DIR, `${day}-${code}.jsonl`);
  return event => {
    fs.appendFile(file, JSON.stringify({ ts: Date.now(), ...event }) + '\n', () => {});
  };
}

const manager = new RoomManager(logFactory);

function isVirtualAdapter(name) {
  // VMware / VirtualBox / Docker / Hyper-V 等虚拟网卡，学生手机不在这些子网，不能用来广播
  return /vmware|vmnet|virtualbox|vbox|docker|hyper-?v|vethernet|loopback|tap|tun|teredo|zero-?config/i.test(name || '');
}

function lanIPs() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ address: ni.address, name, virtual: isVirtualAdapter(name) });
    }
  }
  // 物理网卡（WLAN/以太网）排前面，虚拟网卡排后面，避免把 VMnet 地址编进二维码
  out.sort((a, b) => (a.virtual === b.virtual ? 0 : a.virtual ? 1 : -1));
  return out;
}

function normalizeLocal(addr) {
  if (!addr) return null;
  if (addr.startsWith('::ffff:')) addr = addr.slice(7); // IPv4-mapped IPv6
  if (addr === '::1' || addr === '127.0.0.1' || addr.startsWith('127.')) return null;
  return addr;
}

function send(ws, type, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...data }));
}

const sockState = new WeakMap(); // ws -> { room, token, role }
const tokenSocket = new Map();   // token -> ws（同学号新连接顶替旧连接）

function broadcast(room, type, data, role) {
  for (const client of wss.clients) {
    const st = sockState.get(client);
    if (st && st.room === room && (!role || st.role === role)) send(client, type, data);
  }
}

function publishState(room) {
  broadcast(room, 'room_state', { phase: room.phase, playerCount: room.players.size });
}

/** 当前房里在线的学生 token 集合（成绩页的「在线」列要用）。 */
function onlineTokens(room) {
  const set = new Set();
  for (const client of wss.clients) {
    const st = sockState.get(client);
    if (st && st.room === room && st.role === 'player') set.add(st.token);
  }
  return set;
}

/** 成绩明细报文：成绩管理页拉一次、清零后回一份，都走这里。 */
function sendScores(ws, room) {
  send(ws, 'host_scores', {
    room: room.code,
    phase: room.phase,
    playerCount: room.players.size,
    rosterSize: room.roster ? room.roster.size : 0,
    strict: room.strict,
    students: room.scoresDetail(onlineTokens(room)),
  });
}

/**
 * 清零之后：大屏要刷新榜单、学生手机要刷新自己的分数。
 *
 * 为什么必须主动推：学生端的分数是 join/resume 时下发 + question_result 时下发的，
 * 清零不在这两条路径上——不推的话，老师清了分，学生手机上还挂着旧分数，
 * 大屏榜单也还是旧的（"我清了怎么还在"就是这么来的）。
 */
function broadcastReset(room, scope, sid) {
  const lb = room.leaderboard();
  broadcast(room, 'scores_reset', {
    scope,
    sid: sid || null,
    leaderboard: lb.map(({ token, ...r }) => r),
  });
  for (const client of wss.clients) {
    const st = sockState.get(client);
    if (!st || st.room !== room || st.role !== 'player') continue;
    const i = lb.findIndex(e => e.token === st.token);
    send(client, 'self_score', {
      score: room.scores.get(st.token) || 0,
      rank: i >= 0 ? i + 1 : null,
    });
  }
}

function bind(ws, room, token, role) {
  Object.assign(sockState.get(ws), { room, token, role });
  if (!token) return;
  // **只有学生之间会互相顶替**（同一学号换设备/重连，旧端收到 replaced）。
  // 教师端是**多端共存**的：教师浏览器页 + md2slides 放映宿主可以同时连着同一个房间，
  // 谁也不该把谁踢下线——早期这里一视同仁地顶替，第二个教师端一连就把第一个踢了。
  if (role !== 'player') return;
  const old = tokenSocket.get(token);
  if (old && old !== ws) {
    send(old, 'replaced', {});
    old.close();
  }
  tokenSocket.set(token, ws);
}

function finishRound(room, reason, preClosed) {
  // 定时收卷路径已 closeRound 过，传 preClosed；手动收卷路径在此收卷
  const out = preClosed || room.closeRound(reason);
  if (!out) return;
  const lb = room.leaderboard();
  broadcast(room, 'question_result', { ...room.publicResult(), reason });
  for (const client of wss.clients) {
    const st = sockState.get(client);
    if (!st || st.room !== room || st.role !== 'player') continue;
    const a = out.round.answers.get(st.token);
    send(client, 'self_result', {
      gained: a && a.correct ? a.gained : 0,
      correct: a ? a.correct : false,
      choice: a ? a.choice : null,
      rank: (lb.findIndex(e => e.token === st.token) + 1) || null,
      score: room.scores.get(st.token) || 0,
    });
  }
  publishState(room);
}

function handle(ws, req, msg) {
  const st = sockState.get(ws);
  switch (msg.type) {
    case 'ping':
      return send(ws, 'pong', {});

    case 'host_create': {
      const room = manager.create();
      room.onReveal = out => finishRound(room, 'deadline', out);
      bind(ws, room, room.hostToken, 'host');
      return send(ws, 'host_ok', { room: room.code, token: room.hostToken, snapshot: room.hostSnapshot() });
    }

    /**
     * 第二个教师端接入：凭「房间号 + 房口令」换一个 host 角色，不产生新的 hostToken。
     *
     * 为什么不用 hostToken：它躺在教师浏览器的 localStorage 里，别的进程读不到
     * （Typora 插件里的 md2slides 就读不到），要授权只能靠房口令这种能抄的短码。
     * 口令校验失败不回房间快照，也不说"第几位错了"——试口令的成本要抬高。
     */
    case 'host_attach': {
      const room = manager.get(msg.room);
      if (!room) return send(ws, 'host_attach_fail', { reason: '房间不存在' });
      if (!room.checkPasscode(msg.passcode)) {
        return send(ws, 'host_attach_fail', { reason: '房口令不正确' });
      }
      bind(ws, room, null, 'host');   // token = null → 不进 tokenSocket → 永不被顶替
      return send(ws, 'host_attach_ok', { room: room.code, snapshot: room.hostSnapshot() });
    }

    case 'resume': {
      const room = manager.findByToken(msg.token);
      if (!room) return send(ws, 'resume_fail', { reason: '房间不存在或已结束' });
      const role = room.resumeRole(msg.token);
      bind(ws, room, msg.token, role);
      return send(ws, 'sync', {
        role,
        snapshot: role === 'host' ? room.hostSnapshot() : room.playerSnapshot(msg.token),
      });
    }

    case 'join': {
      const room = manager.get(msg.room);
      if (!room) return send(ws, 'join_fail', { reason: '房间不存在' });
      if (msg.spectate) {
        bind(ws, room, null, 'spectator');
        return send(ws, 'join_ok', { role: 'spectator', snapshot: room.spectatorSnapshot() });
      }
      const out = room.join({ sid: msg.sid, name: msg.name });
      if (out.error) return send(ws, 'join_fail', { reason: out.error });
      bind(ws, room, out.token, 'player');
      send(ws, 'join_ok', { role: 'player', token: out.token, snapshot: room.playerSnapshot(out.token) });
      publishState(room);
      return;
    }
  }

  const room = st.room;
  if (!room) return send(ws, 'error', { message: '请先加入房间' });
  const asHost = () => {
    if (st.role !== 'host') send(ws, 'error', { message: '需要教师身份' });
    return st.role === 'host';
  };

  switch (msg.type) {
    case 'answer': {
      if (st.role !== 'player') return send(ws, 'error', { message: '只有学生可以作答' });
      const out = room.answer(st.token, Number(msg.choice));
      if (out.error) return send(ws, 'answer_ack', { accepted: false, reason: out.error });
      send(ws, 'answer_ack', { accepted: true, elapsedMs: out.rec.elapsedMs });
      broadcast(room, 'progress', { answered: room.current.answers.size, total: room.players.size });
      if (room.current.answers.size >= room.players.size) finishRound(room, 'all');
      return;
    }

    case 'host_import_roster': {
      if (!asHost()) return;
      const roster = new Map();
      for (const row of Array.isArray(msg.rows) ? msg.rows : []) {
        let sid, name;
        if (Array.isArray(row)) [sid, name] = row;
        else if (typeof row === 'string') [sid, name] = row.split(/\t|,|，/);
        else if (row && typeof row === 'object') ({ sid, name } = row);
        sid = String(sid || '').trim();
        name = String(name || '').trim();
        if (sid && name) roster.set(sid, name);
      }
      room.roster = roster.size ? roster : null;
      room.log({ event: 'roster_imported', count: roster.size });
      return send(ws, 'roster_ok', { count: room.roster ? roster.size : 0, strict: room.strict });
    }

    case 'host_set_strict': {
      if (!asHost()) return;
      room.strict = !!msg.strict;
      return send(ws, 'roster_ok', { count: room.roster ? room.roster.size : 0, strict: room.strict });
    }

    case 'host_open': {
      if (!asHost()) return;
      const out = room.openQuestion(msg);
      if (out.error) return send(ws, 'error', { message: out.error });
      broadcast(room, 'question_open', out.broadcast);
      publishState(room);
      return;
    }

    case 'host_close': {
      if (!asHost()) return;
      finishRound(room, 'host_close');
      return;
    }

    case 'host_abort': {
      if (!asHost()) return;
      // 只有真的作废了（有题在进行中）才通知全员。以前这里无条件广播，
      // 对一道已揭晓的题点「作废」会把大屏清空、学生端跳待机，分数却一分没动——
      // 老师以为撤了，其实没有。
      if (room.abort()) broadcast(room, 'round_closed', { reason: 'host_abort' });
      publishState(room);
      return;
    }

    case 'host_next': {
      if (!asHost()) return;
      room.next();
      publishState(room);
      return;
    }

    /* ---- 成绩管理 ---- */

    // 拉成绩明细（成绩管理页打开时一次；之后跟着 room_state 重拉）
    case 'host_scores': {
      if (!asHost()) return;
      return sendScores(ws, room);
    }

    // 单人清零：代答 / 作弊 / 录错时只针对某一个人
    case 'host_reset_player': {
      if (!asHost()) return;
      // 有题在进行中不许清：这题的分数还没入账，清了会把账算乱
      if (room.phase === 'open') {
        return send(ws, 'error', { message: '有题正在进行，先收卷或作废再清零' });
      }
      const out = room.resetPlayer(msg.sid);
      if (out.error) return send(ws, 'error', { message: out.error });
      broadcastReset(room, 'player', out.player.sid);
      return sendScores(ws, room);
    }

    // 全班清零：试答一轮后重来 / 这节课整体作废。不动玩家与名单。
    case 'host_reset_scores': {
      if (!asHost()) return;
      if (room.phase === 'open') {
        return send(ws, 'error', { message: '有题正在进行，先收卷或作废再清零' });
      }
      room.resetScores();
      broadcastReset(room, 'all', null);
      return sendScores(ws, room);
    }

    default:
      return send(ws, 'error', { message: '未知消息 ' + msg.type });
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);

  if (p.startsWith('/export/')) {
    const room = manager.get(p.slice('/export/'.length));
    if (!room || u.searchParams.get('token') !== room.hostToken) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden');
    }
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="classbuzz-${room.code}.csv"`,
    });
    return res.end('\ufeff' + room.csv());
  }

  if (p === '/qr') {
    const text = u.searchParams.get('text') || '';
    try {
      const svg = await QRCode.toString(text, { type: 'svg', margin: 1, width: 480 });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end(svg);
    } catch {
      res.writeHead(400);
      return res.end('bad text');
    }
  }

  if (p === '/lan') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    // local = 教师这次请求进来的那个本机 IP；学生和它同网段，用它广播最可靠
    return res.end(JSON.stringify({ ips: lanIPs().map(x => x.address), local: normalizeLocal(req.socket.localAddress) }));
  }

  if (p === '/api/config') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return res.end(JSON.stringify({ publicBase: publicBase(), port: PORT }));
  }

  const routes = { '/': 'index.html', '/host': 'host.html', '/scores': 'scores.html', '/board': 'board.html', '/play': 'play.html' };
  const file = routes[p] || p.replace(/^\/+/, '');
  const abs = path.normalize(path.join(PUBLIC_DIR, file));
  if (!abs.startsWith(PUBLIC_DIR) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not Found');
  }
  res.writeHead(200, { 'Content-Type': (MIME[path.extname(abs)] || 'application/octet-stream') + '; charset=utf-8' });
  fs.createReadStream(abs).pipe(res);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  sockState.set(ws, {});
  ws.on('message', raw => {
    if (raw.length > 512 * 1024) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { handle(ws, req, msg); } catch { send(ws, 'error', { message: '服务器内部错误' }); }
  });
  ws.on('close', () => {
    const st = sockState.get(ws);
    if (st && st.token && tokenSocket.get(st.token) === ws) tokenSocket.delete(st.token);
  });
});

// 服务端心跳：15s 一轮 ping，两轮无回音判定死链踢掉（手机息屏常见）
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000).unref();

server.listen(PORT, () => {
  const all = lanIPs();
  console.log('classbuzz 服务已启动');
  console.log(`  本机:   http://localhost:${PORT}`);
  for (const { address, virtual } of all) {
    if (virtual) continue; // 虚拟网卡（VMware/VirtualBox 等）跳过，学生手机不在那些子网
    console.log(`  局域网: http://${address}:${PORT}   ← 学生手机用这个`);
  }
  console.log('  提示: 课堂热点部署与防火墙放行见 README.md');
});

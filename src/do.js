/* RoomDO: 多人房间实时转发（结构优化版）
   纯转发职责: 房间/姿态/聊天/私信提醒。账号数据在 KV 按用户分键(Worker 层), 与 DO 无关 */
import { nameToId, userFromToken, readUser, dsPut } from './auth.js';

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new Map();   // code -> {host:{ws,name}, players:Map, pass, max, code}
    this.online = new Map();  // name -> ws
    this.meta = new Map();    // ws -> {name, room, role}
  }

  genCode() {
    const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += cs[Math.floor(Math.random() * cs.length)];
    return s;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/rooms') {
      const list = [...this.rooms.entries()].map(([code, r]) => ({
        code, host: r.host ? r.host.name : '', count: r.players.size, max: r.max, hasPass: !!r.pass, full: r.players.size >= r.max, mode: r.mode || 'normal',
      }));
      return new Response(JSON.stringify({ rooms: list }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/presence') {
      return new Response(JSON.stringify({ online: [...this.online.keys()] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    /* 只读导出旧账号库(state.storage 'db'): 供管理员一次性救援迁移, 需内部令牌 */
    if (url.pathname === '/db-dump') {
      const tok = this.env.AI_PROXY_TOKEN || '';
      if (!tok || request.headers.get('X-Internal-Token') !== tok) return new Response('forbidden', { status: 403 });
      var oldDb = null;
      try { oldDb = (await this.state.storage.get('db')) || null; } catch (e) {}
      return new Response(JSON.stringify({ has: !!oldDb, count: oldDb ? Object.keys(oldDb).length : 0, db: oldDb }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/notify' && request.method === 'POST') {
      const b = await request.json();
      const ws = this.online.get(String(b.to || '').slice(0, 16));
      if (ws) { try { ws.send(JSON.stringify(b.payload)); } catch (e) {} }
      return new Response('ok');
    }
    if (url.pathname === '/kick' && request.method === 'POST') {
      const { username, deleted } = await request.json();
      const ws = this.online.get(username);
      if (ws) {
        try { if (deleted) ws.send(JSON.stringify({ t: 'kicked', reason: 'deleted' })); } catch (e) {}
        try { ws.close(4001, 'kicked'); } catch (e) {}
      }
      return new Response('ok');
    }
    if (request.headers.get('Upgrade') === 'websocket') {
      const u = new URL(request.url);
      const user = await userFromToken(this.env, u.searchParams.get('token'));
      if (!user) return new Response('unauthorized', { status: 401 });
      const name = user.name;
      const pair = new WebSocketPair();
      this.online.set(name, pair[1]);
      this.meta.set(pair[1], { name });
      pair[1].accept();
      pair[1].addEventListener('message', async (e) => {
        try { await this.onMsg(pair[1], e.data); } catch (err) { console.error('[do] msg err:', err.message); }
      });
      pair[1].addEventListener('close', () => { try { this.onClose(pair[1]); } catch (err) {} });
      pair[1].addEventListener('error', () => { try { this.onClose(pair[1]); } catch (err) {} });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response('not found', { status: 404 });
  }

  async onMsg(ws, raw) {
    let d = null;
    try { d = JSON.parse(raw); } catch (e) { return; }
    const att = this.meta.get(ws) || {};
    const name = att.name || '';
    if (d.t === 'create') this.handleCreate(ws, name, String(d.pass || '').slice(0, 16), Math.max(2, Math.min(8, d.max | 0 || 2)), String(d.mode || 'normal'));
    else if (d.t === 'join') this.handleJoin(ws, name, String(d.code || '').toUpperCase(), String(d.pass || '').slice(0, 16));
    else if (d.t === 'set-mode') this.handleSetMode(ws, String(d.mode || ''));
    else if (d.t === 'room-invite') {
      const target = this.online.get(String(d.to || '').slice(0, 16));
      if (target) { try { target.send(JSON.stringify({ t: 'room-invite', from: name, code: String(d.code || '').slice(0, 8) })); } catch (e) {} }
      else { try { ws.send(JSON.stringify({ t: 'g', d: { t: 'invite-fail', to: d.to, reason: '对方不在线' } })); } catch (e) {} }
    }
    else if (d.t === 'g') { this.forward(ws, { t: 'g', d: d.d }); }
    else if (d.t === 'leave') this.leaveAll(ws, true);
    else if (d.t === 'ping') { try { ws.send(JSON.stringify({ t: 'pong' })); } catch (e) {} }
    else if (d.t === 'reclaim') {
      /* 房主断线重连: 认领原房间(保留房码), 需要 hostName 匹配 */
      const rc = String(d.code || '').toUpperCase();
      const rr = this.rooms.get(rc);
      if (!rr || !rr.hostGone || rr.hostName !== name) { try { ws.send(JSON.stringify({ t: 'reclaim-fail' })); } catch (e) {} return; }
      try { this.meta.delete(rr.host.ws); } catch (e) {}
      rr.host = { ws, name };
      rr.hostGone = null;
      if (!rr.players.has(ws)) rr.players.set(ws, { name, ws, score: 0 });
      this.meta.set(ws, { name, room: rc, role: 'host' });
      const rnames = [...rr.players.values()].map((p) => p.name);
      var rleft;
      if (rr.mode === 'rush30' && rr.started && rr.roundStartT) rleft = Math.max(0, 30 - Math.round((Date.now() - rr.roundStartT) / 1000));
      try { ws.send(JSON.stringify({ t: 'reclaimed', code: rc, players: rnames, mode: rr.mode || 'normal', roundLeft: rleft })); } catch (e) {}
      for (const [w] of rr.players) {
        if (w === ws) continue;
        try { w.send(JSON.stringify({ t: 'peer-joined', name: name, players: rnames })); } catch (e) {}
      }
    }
    else if (d.t === 'dm') {
      const text = String(d.text || '').slice(0, 200);
      const to = String(d.to || '').slice(0, 16);
      if (!name || !text || !to || name === to) return;
      const now = Date.now();
      /* 聊天记录持久化(恢复旧版行为): 双方记录各存一份, 最近300条, 走数据服务主存 */
      try {
        var uf = await readUser(this.env, name);
        if (uf) { if (!uf.dm) uf.dm = []; uf.dm.push({ from: name, to, text, ts: now }); uf.dm = uf.dm.slice(-300); await dsPut(this.env, name, uf); }
      } catch (e) {}
      try {
        var ut = await readUser(this.env, to);
        if (ut) { if (!ut.dm) ut.dm = []; ut.dm.push({ from: name, to, text, ts: now }); ut.dm = ut.dm.slice(-300); await dsPut(this.env, to, ut); }
      } catch (e) {}
      const target = this.online.get(to);
      if (target) {
        try { target.send(JSON.stringify({ t: 'dm', from: name, text: text, ts: now })); } catch (e) {}
        try { ws.send(JSON.stringify({ t: 'dm-ok', to: to })); } catch (e) {}
      } else {
        /* 对方离线: 记录已入历史, 对方下次连线 dm-pull 会拉到 */
        try { ws.send(JSON.stringify({ t: 'dm-queued', to: to })); } catch (e) {}
      }
    }
    else if (d.t === 'dm-pull') {
      try {
        /* 返回持久聊天历史(最近100条, 按时间排序), 并合并排干旧版 dmq 离线队列 */
        var qk = 'dmq:' + (await nameToId(name));
        var q = [];
        try { q = JSON.parse((await this.env.BOW_KV.get(qk)) || '[]'); } catch (e) {}
        if (q.length) { try { await this.env.BOW_KV.delete(qk); } catch (e) {} }
        var me = await readUser(this.env, name);
        var hist = (me && me.dm) ? me.dm.slice(-100) : [];
        var seen = {}; var out = [];
        hist.concat(q).forEach(function (m) {
          var k = (m.from || '') + '|' + (m.to || '') + '|' + (m.ts || 0) + '|' + (m.text || '');
          if (!seen[k]) { seen[k] = 1; out.push(m); }
        });
        out.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
        try { ws.send(JSON.stringify({ t: 'dm-offline', msgs: out.slice(-100) })); } catch (e) {}
      } catch (e) {}
    }
  }

  async webSocketMessage(ws, raw) { await this.onMsg(ws, raw); }

  handleCreate(ws, name, pass, max, mode) {
    this.leaveAll(ws, true);
    if (['normal', 'endless', 'precision', 'rush30'].indexOf(mode) < 0) mode = 'normal';
    let code;
    do { code = this.genCode(); } while (this.rooms.has(code));
    const room = { host: { ws, name }, hostName: name, players: new Map(), pass, max, code, mode, started: false, roundStartT: 0 };
    room.players.set(ws, { name, ws, score: 0 });
    this.rooms.set(code, room);
    this.meta.set(ws, { name, room: code, role: 'host' });
    try { ws.send(JSON.stringify({ t: 'created', code, mode })); } catch (e) {}
    /* 狂射: 满员自动开跑(理论上建房时只有房主, 不会满员, 兜底) */
    this.maybeStartRush(room);
  }

  /* 狂射模式: 人齐(room.max)才开跑, 广播 round-start */
  maybeStartRush(room) {
    if (room.mode !== 'rush30' || room.started || room.players.size < room.max) return;
    room.started = true;
    room.roundStartT = Date.now();
    for (const [w] of room.players) {
      try { w.send(JSON.stringify({ t: 'round-start' })); } catch (e) {}
    }
  }

  handleJoin(ws, name, code, pass) {
    this.leaveAll(ws, true);
    const r = this.rooms.get(code);
    if (!r) { try { ws.send(JSON.stringify({ t: 'no-room' })); } catch (e) {} return; }
    if (r.pass && r.pass !== pass) { try { ws.send(JSON.stringify({ t: 'need-pass' })); } catch (e) {} return; }
    if (r.players.size >= r.max) { try { ws.send(JSON.stringify({ t: 'full' })); } catch (e) {} return; }
    r.players.set(ws, { name, ws, score: 0 });
    this.meta.set(ws, { name, room: code, role: 'player' });
    const names = [...r.players.values()].map((p) => p.name);
    var roundLeft;
    if (r.mode === 'rush30' && r.started && r.roundStartT) {
      roundLeft = Math.max(0, 30 - Math.round((Date.now() - r.roundStartT) / 1000));   // 中途加入: 剩余秒数
    }
    try { ws.send(JSON.stringify({ t: 'joined', players: names, foeName: r.host.name, mode: r.mode || 'normal', roundLeft })); } catch (e) {}
    /* 通知房主与房内其他玩家 */
    for (const [w, p] of r.players) {
      if (w === ws) continue;
      try { w.send(JSON.stringify({ t: 'peer-joined', name: name, players: names })); } catch (e) {}
    }
    /* 狂射: 补齐人数后开跑 */
    this.maybeStartRush(r);
  }

  /* 换房间模式: 仅房主, 全房广播同步 */
  handleSetMode(ws, mode) {
    if (['normal', 'endless', 'precision', 'rush30'].indexOf(mode) < 0) mode = 'normal';
    const att = this.meta.get(ws);
    const r = att && this.rooms.get(att.room);
    if (!r) return;
    if (att.role !== 'host' || r.host.ws !== ws) {
      try { ws.send(JSON.stringify({ t: 'g', d: { t: 'mode-fail', reason: '只有房主能更换模式' } })); } catch (e) {}
      return;
    }
    r.mode = mode;
    for (const [w] of r.players) {
      try { w.send(JSON.stringify({ t: 'mode', mode })); } catch (e) {}
    }
    /* 狂射: 换模式即重置本局; 若人已齐立刻开跑(再来一局) */
    if (mode === 'rush30') {
      r.started = false; r.roundStartT = 0;
      this.maybeStartRush(r);
    }
  }

  forward(ws, obj) {
    const att = this.meta.get(ws) || {};
    const r = this.rooms.get(att.room);
    if (!r) return;
    const tagged = JSON.stringify({ t: 'g', d: { ...(obj.d || {}), from: att.name } });
    for (const [w, p] of r.players) {
      if (w === ws) continue;
      try { w.send(tagged); } catch (e) {}
    }
  }

  /* intentional=true: 玩家主动离开, 房主则立即解散房间;
     intentional=false(断线): 房主掉线房间保留25s宽限期供 reclaim, 超时未归才解散 */
  leaveAll(ws, intentional) {
    const att = this.meta.get(ws) || {};
    const r = att.room ? this.rooms.get(att.room) : null;
    if (!r) return;
    if (r.host && r.host.ws === ws) {
      if (intentional) {
        this.rooms.delete(att.room);
        for (const [w, p] of r.players) {
          if (w === ws) continue;
          try { w.send(JSON.stringify({ t: 'room-closed' })); } catch (e) {}
        }
        return;
      }
      r.hostGone = Date.now();
      r.players.delete(ws);
      const names = [...r.players.values()].map((p) => p.name);
      for (const [w, p] of r.players) {
        try { w.send(JSON.stringify({ t: 'peer-left', name: att.name, players: names })); } catch (e) {}
      }
      const room = r;
      setTimeout(() => {
        if (room.hostGone && Date.now() - room.hostGone > 24000) {
          this.rooms.delete(room.code);
          for (const [w] of room.players) {
            try { w.send(JSON.stringify({ t: 'room-closed' })); } catch (e) {}
          }
        }
      }, 25000);
    } else if (r.players.has(ws)) {
      r.players.delete(ws);
      const names = [...r.players.values()].map((p) => p.name);
      for (const [w, p] of r.players) {
        try { w.send(JSON.stringify({ t: 'peer-left', name: att.name, players: names })); } catch (e) {}
      }
    }
  }

  onClose(ws) {
    this.leaveAll(ws);
    var nm = (this.meta.get(ws) || {}).name;
    if (nm && this.online.get(nm) === ws) this.online.delete(nm);
  }
}

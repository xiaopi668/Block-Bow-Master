/* 方块弓箭大师 v5.3-CF · Cloudflare Workers 版后端（结构优化版）
   账号数据: KV 按用户分键存储（纯 Worker+KV, 不消耗 DO 额度）
   多人房间: Durable Object 仅承载实时对局转发 */
import { RoomDO } from './do.js';
import { ADMIN_NAME, hex, hashPass, nameToId, getSecret, hmacSign, issueToken, userFromToken, pubUser, readUser, writeUser, delUser, flushDirty, dsGet, dsPut, dsPatch } from './auth.js';
export { RoomDO };

/* ---------------- 工具 ---------------- */
function json(data, code = 200) {
  return new Response(JSON.stringify(data), {
    status: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
async function readBody(request) {
  try { return await request.json(); } catch (e) { return {}; }
}
/* 进程内限流(isolate 级, 跨 isolate 各自计数): 作为防脚本刷分/撞库/养号的第一道闸 */
const RL = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const e = RL.get(key);
  const arr = e ? e.t.filter(function (t) { return now - t < windowMs; }) : [];
  if (arr.length >= max) { RL.set(key, { w: windowMs, t: arr }); return false; }
  arr.push(now);
  RL.set(key, { w: windowMs, t: arr });
  if (RL.size > 4000) {   // 内存兜底: 清掉已过期的桶
    for (const [k, v] of RL) { if (!v.t.length || now - v.t[v.t.length - 1] > v.w) RL.delete(k); }
  }
  return true;
}
async function presenceList(env) {
  try {
    const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
    const r = await stub.fetch('https://do/presence');
    const d = await r.json();
    return d.online || [];
  } catch (e) { return []; }
}
/* 通用通知: 经 DO 转发给在线用户的 WebSocket */
async function notifyUser(env, to, payload) {
  try {
    const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
    await stub.fetch('https://do/notify', { method: 'POST', body: JSON.stringify({ to, payload }) });
  } catch (e) {}
}

/* 数据服务调用助手(内部令牌) */
async function dsFetch(env, pathAfter, method, payload) {
  const base = (env.DATA_URL || '').replace(/\/+$/, '');
  return fetch(base + pathAfter, {
    method: method || 'POST',
    headers: { 'X-Data-Token': env.DATA_TOKEN || '', 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

/* 全量账号列表: 主存(数据服务 __index)优先, KV u: 键兜底 */
async function listAllUsers(env) {
  try {
    const base = (env.DATA_URL || '').replace(/\/+$/, '');
    if (base) {
      const r = await fetch(base + '/__index', { headers: { 'X-Data-Token': env.DATA_TOKEN || '' }, cf: { cacheTtl: 0 } });
      if (r.ok) return await r.json();
    }
  } catch (e) {}
  const out = {};
  var cursor = undefined;
  do {
    const page = await env.BOW_KV.list({ prefix: 'u:', cursor });
    page.keys.forEach(function(k){ out[k.name.slice(2)] = {}; });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/* 按用户 KV 存取: readUser/writeUser/delUser 来自 auth.js */

/* ---------------- API ---------------- */
const NAME_RE = /[<>"'\/\\]/;
const ADMIN_API = ['/api/admin/'];
const AUTH_API = ['/api/me', '/api/logout', '/api/online', '/api/users/public', '/api/score', '/api/settings/title', '/api/leaderboard'];
let LB_CACHE = null, LB_CACHE_T = 0;
const SP_TYPES = { track: 8, split: 5, ice: 3, boom: 8, shadow: 10 };
/* ===== 赛季系统: 每7天自动换赛季; 切换时积分/箭矢/特殊箭清零(🛡️防丢卡可保护) ===== */
const SEASON_EPOCH = Date.UTC(2026, 8, 21, 0, 0, 0);   // 2026-09-21 00:00 UTC 第1赛季开启
const SEASON_MS = 7 * 24 * 3600 * 1000;
const CARD_COST = 5000;   // 防丢卡售价(很贵: 赛季保护属高价值道具)
const SEASON_GRANT_ARROWS = 100;   // 无卡换季的箭矢补给(与新建账号一致)
function seasonIdx(){ const n = Date.now(); return n < SEASON_EPOCH ? 0 : 1 + Math.floor((n - SEASON_EPOCH) / SEASON_MS); }
function seasonLeft(){ const n = Date.now(); if (n < SEASON_EPOCH) return SEASON_EPOCH - n; return SEASON_MS - ((n - SEASON_EPOCH) % SEASON_MS); }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* WebSocket upgrade -> Durable Object（原样转发, DO 自行验签） */
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
      return stub.fetch(request);
    }

    if (!url.pathname.startsWith('/api/')) {
      try {
        const res = await env.ASSETS.fetch(request);
        const h = new Headers(res.headers);
        h.set('Cache-Control', 'private, no-store, max-age=0');
        h.set('CDN-Cache-Control', 'no-store');
        return new Response(res.body, { status: res.status, headers: h });
      } catch (e) { return new Response('not found', { status: 404 }); }
    }

    try { return await apiBody(request, env, url); }
    catch (e) { return json({ error: 'SRV ' + String((e && e.message) || e).slice(0, 200) }, 500); }
    finally { await flushDirty(env); }   // 响应返回前把本次写入落盘(防 isolate 回收丢账号)
  },
};

/* API 主体(独立函数, 便于统一在响应返回前把 KV 写入刷盘) */
async function apiBody(request, env, url) {
    await flushDirty(env);   // 先刷掉上次积攒的脏写入
    const body = await readBody(request);
    const token = request.headers.get('X-User-Token');
    const me0 = await userFromToken(env, token);
    let me = me0;
    const path = url.pathname;
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    /* 赛季懒结算: 下沉到数据服务做同步原子读改写(AI评审: 并发下不重复结算/不多扣卡) */
    if (me && (me.seasonIdx|0) !== seasonIdx()) {
      try {
        const sbase = (env.DATA_URL || '').replace(/\/+$/, '');
        const rS = await fetch(sbase + '/settle/' + encodeURIComponent('u:' + me.name), {
          method: 'POST',
          headers: { 'X-Data-Token': env.DATA_TOKEN || '', 'Content-Type': 'application/json' },
          body: JSON.stringify({ idx: seasonIdx(), grant: SEASON_GRANT_ARROWS })
        });
        if (rS.ok) {
          let dS = null;
          try { dS = await rS.json(); } catch (e) { dS = null; }   // 非JSON响应兜底(AI评审)
          if (dS && dS.rec) {   // 仅合并结算字段, 不整体替换用户对象(防丢 friends/skin 等)
            me.score = dS.rec.score|0; me.arrows = dS.rec.arrows|0; me.sp = dS.rec.sp || {};
            me.anticard = dS.rec.anticard|0; me.seasonIdx = dS.rec.seasonIdx|0; me.cardUsedSeason = dS.rec.cardUsedSeason|0;
          }
        }
      } catch (e) { /* 结算失败不影响本次请求, 下次登录重试 */ }
    }

    /* ---- 无需登录的接口 ---- */
    if (path === '/api/ai-proxy' && request.method === 'POST') {
      try {
        /* secret 未配置时硬失败: 否则空值头 '' === '' 会直接放行(AI评审/P0) */
        if (!env.AI_PROXY_TOKEN) return json({ error: '服务未配置(AI_PROXY_TOKEN)' }, 503);
        if (request.headers.get('X-Internal-Token') !== env.AI_PROXY_TOKEN) return json({ error: '无权' }, 403);
        if (!rateLimit('ai:' + ip, 30, 60000)) return json({ error: '请求过于频繁，请稍后再试' }, 429);
        const base = (env.AI_BASE_URL || '').replace(/\/+$/, '');
        const payload = { model: body.model || (env.AI_MODEL || 'glm-5.3-flash'), messages: body.messages || [], temperature: (body.temperature === undefined ? 0.1 : body.temperature), max_tokens: body.max_tokens || 4000 };
        const resp = await fetch(base + '/chat/completions', { method: 'POST', headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (env.AI_API_KEY || ''),
          'X-Data-Token': (env.DATA_TOKEN || ''),   // 数据服务/AI 中继鉴权
          'x-opencode-session': 'bow-master-' + Math.random().toString(36).slice(2, 10),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        }, body: JSON.stringify(payload) });
        const txt = await resp.text();
        return new Response(txt, { status: resp.status, headers: { 'Content-Type': 'application/json' } });
      } catch (e) { return json({ error: String(e && e.stack || e).slice(0, 300) }, 500); }
    }
    if (path === '/api/skin/get' && request.method === 'GET') {
      const nm = String(url.searchParams.get('name') || '').slice(0, 16);
      const u = await readUser(env, nm);
      return json({ skin: (u && u.skin) || null });
    }
    if (path === '/api/config' && request.method === 'GET') {
      return json({ config: { maxScore: 999999, server: 'bow-v5-cf' } });
    }

    /* ---- 认证 ---- */
    if (path === '/api/register' && request.method === 'POST') {
      if (!rateLimit('rg:' + ip, 5, 600000)) return json({ error: '注册太频繁了，请 10 分钟后再试' }, 429);
      const name = String(body.username || '').trim();
      const pass = String(body.password || '');
      if (!name) return json({ error: '请输入姓名（账号）' }, 400);
      if (name === ADMIN_NAME) return json({ error: '该账号是管理员保留账号，不能注册' }, 400);
      if (NAME_RE.test(name)) return json({ error: '姓名里不能包含特殊符号' }, 400);
      if (name.length > 16) return json({ error: '姓名最长 16 字' }, 400);
      if (pass.length < 6) return json({ error: '密码至少 6 位' }, 400);
      const exists = await readUser(env, name);
      if (exists) return json({ error: '这个账号已经被注册过了' }, 400);
      const salt = hex(crypto.getRandomValues(new Uint8Array(8)));
      const rec = { salt, pass: await hashPass(pass, salt), score: 0, arrows: 100, banned: false, isAdmin: false, isDeveloper: false, reg: Date.now(), lastLogin: 0, sp: {}, friends: [], requests: [], sent: [], dm: [], seasonIdx: seasonIdx(), anticard: 0, ach: [] };
      await writeUser(env, name, rec);
      const u = { ...rec, _name: name };
      return json({ token: await issueToken(env, name), user: pubUser(u) });
    }
    if (path === '/api/login' && request.method === 'POST') {
      if (!rateLimit('lgi:' + ip, 10, 300000)) return json({ error: '登录太频繁了，请 5 分钟后再试' }, 429);
      try {
        const name = String(body.username || '').trim();
        const pass = String(body.password || '');
        /* 按账号限速: 阻止单账号被定向撞库(与 IP 限速叠加) */
        if (name && !rateLimit('lgn:' + name.toLowerCase(), 8, 300000)) return json({ error: '该账号尝试过多，请 5 分钟后再试' }, 429);
        let u = await readUser(env, name);
        if (!u) {
          /* KV 副本可能滞后: 回源 DO 查询 */
          try {
            const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
            const rr = await stub.fetch('https://do/user-check?name=' + encodeURIComponent(name));
            if (rr.ok) { const d = await rr.json(); if (d.name && d.user) u = d.user; }
          } catch (e) {}
        }
        if (!u) return json({ error: '账号不存在，请先注册' }, 400);
        if (!u.salt && !u.pass) {
          /* 自动建档账号（无密码）首次登录即认领: 设置密码 */
          if (pass.length < 6) return json({ error: '密码至少 6 位' }, 400);
          const csalt = hex(crypto.getRandomValues(new Uint8Array(8)));
          u.salt = csalt;
          u.pass = await hashPass(pass, csalt);
          await writeUser(env, name, u);
          return json({ token: await issueToken(env, name), user: pubUser({ ...u, _name: name }) });
        }
        if (await hashPass(pass, u.salt) !== u.pass) return json({ error: '密码错误！' }, 400);
        if (u.banned) return json({ error: 'banned' }, 403);
        u.lastLogin = Date.now();
        await writeUser(env, name, u);
        return json({ token: await issueToken(env, name), user: pubUser({ ...u, _name: name }) });
      } catch (e) { return json({ error: 'SRV ' + (e.message || String(e)) + ' :: ' + String(e.stack || '').slice(0, 400) }, 500); }
    }

    if (!me) return json({ error: '未登录或登录已过期' }, 401);
    if (path === '/api/logout' && request.method === 'POST') return json({ ok: true });

    /* ---- 已登录: 账号数据（全部走按用户 KV, 零 DO 消耗） ---- */
    if (path === '/api/me' && request.method === 'GET') {
      const online = (await presenceList(env)).includes(me.name);
      return json({ user: pubUser({ ...me, _name: me.name, _online: online }) });
    }
    if (path === '/api/score' && request.method === 'POST') {
      /* 记分限流: 单账号 10 秒内最多 60 次上报(正常命中远低于此), 挡住脚本刷分(P0) */
      if (!rateLimit('sc:' + me.name, 60, 10000)) return json({ error: '得分上报太频繁，请稍后再试', score: 0 }, 429);
      /* 记分下沉到数据服务原子操作(AI评审): 服务端校验反作弊并同步读改写 */
      let d2 = null;
      try { const r2 = await dsFetch(env, '/score/' + encodeURIComponent('u:' + me.name), 'POST', body); d2 = await r2.json(); } catch (e) { d2 = null; }   // 非JSON响应兜底(AI评审)
      if (d2 && d2.ok) return json({ score: d2.score|0 });
      const isAntiCheat = d2 && (d2.error || '').indexOf('贴脸') >= 0;
      return json({ error: (d2 && d2.error) || '服务暂时不可用，请稍后再试', score: (d2 && d2.score|0) || 0 }, d2 ? (isAntiCheat ? 403 : 400) : 502);
    }
    if (path === '/api/arrow/use' && request.method === 'POST') {
      /* 扣箭下沉为数据服务原子操作(AI评审双存储一致性问题): 整条记录回写会互相覆盖分数 */
      const n = Math.max(1, Math.min(10, (body.count | 0) || 1));
      const rA = await dsFetch(env, '/arrowuse/' + encodeURIComponent('u:' + me.name), 'POST', { count: n });
      const dA = await rA.json();
      if (dA.ok) return json({ arrows: dA.arrows|0 });
      return json({ error: '服务暂时不可用，请稍后再试' }, 502);
    }
    if (path === '/api/shop/buy' && request.method === 'POST') {
      const count = Math.max(1, Math.min(10000, Math.floor(Number(body.count) || 0)));
      const u = await readUser(env, me.name);
      if (!u) return json({ error: '账号不存在' }, 400);
      const cost = count;
      if ((u.score|0) < cost) return json({ error: '积分不足', score: u.score|0 }, 400);
      u.score = (u.score|0) - cost;
      u.arrows = (u.arrows|0) + count;
      await writeUser(env, me.name, u);
      return json({ score: u.score|0, arrows: u.arrows|0 });
    }
    if ((path === '/api/sp/buy' || path === '/api/sp/use') && request.method === 'POST') {
      const type = String(body.type || '');
      if (!SP_TYPES[type]) return json({ error: '未知箭种' }, 400);
      /* 特殊箭购买/消耗也下沉为数据服务原子操作(AI评审双存储一致性) */
      const rB = await dsFetch(env, (path === '/api/sp/buy' ? '/spbuy/' : '/spuse/') + encodeURIComponent('u:' + me.name), 'POST', { type: type, count: (body.count | 0) || 1 });
      const dB = await rB.json();
      if (dB.ok) return json({ ok: true, score: dB.score|0, left: dB.left|0 });
      return json({ error: dB.error || '服务暂时不可用', left: (dB.left|0) || 0 }, 400);
    }
    if (path === '/api/card/buy' && request.method === 'POST') {
      let d3 = null;
      try { const r3 = await dsFetch(env, '/cardbuy/' + encodeURIComponent('u:' + me.name), 'POST', { cost: CARD_COST }); d3 = await r3.json(); } catch (e) { d3 = null; }
      if (d3 && d3.ok) return json({ ok: true, score: d3.score|0, anticard: d3.anticard|0 });
      return json({ error: (d3 && d3.error) || '购买服务暂时不可用，请稍后再试', score: d3 ? (d3.score|0) : 0 }, 400);
    }
    if (path === '/api/ach/unlock' && request.method === 'POST') {
      /* 上游也做长度/字符校验(AI评审), 与数据层正则清洗双保险 */
      const achId = String(body.id || '').slice(0, 24).replace(/[^a-zA-Z0-9_-]/g, '');
      if (!achId) return json({ error: '参数错误' }, 400);
      const r5 = await dsFetch(env, '/ach/' + encodeURIComponent('u:' + me.name), 'POST', { id: achId });
      let d5 = null;
      try { d5 = await r5.json(); } catch (e) { d5 = null; }
      if (d5 && d5.ok) { if (d5.ach) me.ach = d5.ach; return json({ ok: true, unlocked: !!d5.unlocked, ach: d5.ach || [] }); }
      return json({ error: '服务暂时不可用' }, 502);
    }
    if (path === '/api/ach/unlock-batch' && request.method === 'POST') {
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 20).map(function(x){ return String(x || '').slice(0, 24).replace(/[^a-zA-Z0-9_-]/g, ''); }).filter(Boolean) : [];
      if (!ids.length) return json({ ok: true, unlockedAny: false, ach: (me.ach || []) });
      let cur = (me.ach || []);
      let anyNew = false;
      for (var i6 = 0; i6 < ids.length; i6++) {
        if (cur.indexOf(ids[i6]) < 0) { cur.push(ids[i6]); anyNew = true; }
      }
      const r6 = anyNew ? await dsFetch(env, '/ach/' + encodeURIComponent('u:' + me.name), 'POST', { id: ids[0], ids: ids }) : null;   // ids字段与数据层协议对齐(AI评审)
      let d6 = r6 ? await r6.json() : null;
      if (anyNew && !(d6 && d6.ok)) return json({ error: '服务暂时不可用' }, 502);
      if (d6 && d6.ach) me.ach = d6.ach; else if (anyNew) me.ach = cur;
      return json({ ok: true, unlockedAny: anyNew, ach: me.ach || [] });
    }
    if (path === '/api/leaderboard' && request.method === 'GET') {
      const online = await presenceList(env);
      let all = null;
      if (Date.now() - LB_CACHE_T < 60000 && LB_CACHE) { all = LB_CACHE; }
      else { all = await listAllUsers(env); LB_CACHE = all; LB_CACHE_T = Date.now(); }
      var rows = [];
      for (var nm in all) {
        var ru = all[nm];
        if (!ru || ru.banned || ru.deleted) continue;
        rows.push({ name: nm, score: ru.score|0 });
      }
      rows.sort(function(a, b){ return b.score - a.score; });
      const top = rows.slice(0, 20).map(function(r, i){
        return { rank: i + 1, name: r.name, score: r.score, online: online.includes(r.name) };
      });
      return json({ top: top });
    }
    if (path === '/api/season' && request.method === 'GET') {
      return json({ idx: seasonIdx(), left: seasonLeft(), epoch: SEASON_EPOCH, ms: SEASON_MS, cardCost: CARD_COST });
    }
    if (path === '/api/best' && request.method === 'POST') {
      const v = String(body.variant || '');
      if (v !== 'endless' && v !== 'rush30') return json({ error: '无效' }, 400);
      const s = Math.max(0, body.score | 0);
      const u = await readUser(env, me.name);
      if (!u) return json({ error: '账号不存在' }, 400);
      if (!u.best) u.best = {};
      var changed = false;
      if (s > (u.best[v]|0)) { u.best[v] = s; changed = true; await writeUser(env, me.name, u); }
      return json({ ok: true, best: u.best, changed: changed });
    }
    if (path === '/api/cape/get' && request.method === 'GET') {
      const nm = String(url.searchParams.get('name') || '').slice(0, 16);
      const uc = await readUser(env, nm);
      return json({ cape: (uc && uc.cape) || null });
    }
    if (path === '/api/cape/set' && request.method === 'POST') {
      const data = String(body.data || '');
      if (!data.startsWith('data:image/png;base64,') || data.length > 43000) return json({ error: '只支持 PNG（小于32KB）' }, 400);
      const u = await readUser(env, me.name);
      if (!u) return json({ error: '账号不存在' }, 400);
      u.cape = data;
      await writeUser(env, me.name, u);
      return json({ ok: true });
    }
    if (path === '/api/cape/clear' && request.method === 'POST') {
      const u = await readUser(env, me.name);
      if (!u) return json({ error: '账号不存在' }, 400);
      delete u.cape;
      await writeUser(env, me.name, u);
      return json({ ok: true });
    }
    if (path === '/api/skin/set' && request.method === 'POST') {
      const data = String(body.data || '');
      if (!data.startsWith('data:image/png;base64,') || data.length > 40000) return json({ error: '只支持 64x64 PNG（小于30KB）' }, 400);
      const u = await readUser(env, me.name);
      if (!u) return json({ error: '账号不存在' }, 400);
      u.skin = data;
      await writeUser(env, me.name, u);
      return json({ ok: true });
    }
    if (path === '/api/settings/title' && request.method === 'POST') {
      const u = await readUser(env, me.name);
      if (!u) return json({ error: '账号不存在' }, 400);
      u.title = String(body.title || '').slice(0, 20);
      await writeUser(env, me.name, u);
      return json({ ok: true });
    }
    if (path === '/api/users/public' && request.method === 'GET') {
      const all = await listAllUsers(env);
      const names = Object.keys(all).filter(function(n){ return n && NAME_RE.test(n) === false; });
      return json({ names });
    }
    if (path === '/api/online' && request.method === 'POST') {
      const names = Array.isArray(body.names) ? body.names.slice(0, 200) : [];
      const online = await presenceList(env);
      return json({ online: names.filter((n) => online.includes(n)) });
    }

    /* ---- 好友系统（按用户记录存取, 零 DO 消耗; 在线提醒经 DO 转发） ---- */
    if (path === '/api/friend/list' && request.method === 'GET') {
      const u = await readUser(env, me.name);
      return json({ friends: (u && u.friends) || [], requests: (u && u.requests) || [], sent: (u && u.sent) || [] });
    }
    const FR = { request: 'to', accept: 'from', reject: 'from', cancel: 'to' };
    if (FR[path.slice(12)] && request.method === 'POST') {
      const act = path.slice(12);
      const other = String(body[FR[act]] || '').slice(0, 16);
      if (!other || other === me.name) return json({ error: '无效的好友' }, 400);
      const u = await readUser(env, me.name);
      if (!u) return json({ error: '账号不存在' }, 400);
      const o = await readUser(env, other);
      if (!o && (act === 'request')) return json({ error: '对方账号不存在' }, 400);
      if (act === 'request') {
        if ((u.friends||[]).includes(other)) return json({ error: '已经是好友了' }, 400);
        if ((o.requests||[]).includes(me.name)) return json({ error: '对方已收到你的申请' }, 400);
        if ((o.sent||[]).includes(me.name)) { /* 对方也申请了: 直接成为好友 */ }
        o.requests = (o.requests||[]); if (!o.requests.includes(me.name)) o.requests.push(me.name);
        u.sent = (u.sent||[]); if (!u.sent.includes(other)) u.sent.push(other);
        await writeUser(env, other, o); await writeUser(env, me.name, u);
        await notifyUser(env, other, { t: 'friend-req', from: me.name });
        return json({ ok: true });
      }
      if (act === 'accept') {
        const rq = (u.requests||[]).indexOf(other);
        if (rq < 0) return json({ error: '没有这条申请' }, 400);
        u.requests.splice(rq, 1);
        u.friends = (u.friends||[]); if (!u.friends.includes(other)) u.friends.push(other);
        o.friends = (o.friends||[]); if (!o.friends.includes(me.name)) o.friends.push(me.name);
        o.sent = (o.sent||[]).filter(function(x){ return x !== me.name; });
        await writeUser(env, other, o); await writeUser(env, me.name, u);
        await notifyUser(env, other, { t: 'friend-accepted', from: me.name });
        return json({ ok: true, friends: u.friends });
      }
      if (act === 'reject') {
        u.requests = (u.requests||[]).filter(function(x){ return x !== other; });
        o.sent = (o.sent||[]).filter(function(x){ return x !== me.name; });
        await writeUser(env, other, o); await writeUser(env, me.name, u);
        await notifyUser(env, other, { t: 'friend-rejected', from: me.name });
        return json({ ok: true });
      }
      if (act === 'cancel') {
        u.sent = (u.sent||[]).filter(function(x){ return x !== other; });
        o.requests = (o.requests||[]).filter(function(x){ return x !== me.name; });
        await writeUser(env, other, o); await writeUser(env, me.name, u);
        return json({ ok: true });
      }
    }
    if (path === '/api/friend/remove' && request.method === 'POST') {
      const other = String(body.name || '').slice(0, 16);
      const u = await readUser(env, me.name); if (!u) return json({ error: '账号不存在' }, 400);
      u.friends = (u.friends||[]).filter(function(x){ return x !== other; });
      await writeUser(env, me.name, u);
      const o = await readUser(env, other);
      if (o) { o.friends = (o.friends||[]).filter(function(x){ return x !== me.name; }); await writeUser(env, other, o); }
      return json({ ok: true, friends: u.friends });
    }
    if (path === '/api/friend/gift' && request.method === 'POST') {
      const other = String(body.to || '').slice(0, 16);
      const cnt = Math.max(1, Math.min(100, body.count | 0));
      const u = await readUser(env, me.name);
      if (!u) return json({ error: '账号不存在' }, 400);
      if (other === me.name) return json({ error: '不能送给自己' }, 400);
      const o = await readUser(env, other);
      if (!o) return json({ error: '对方账号不存在' }, 400);
      if (!(u.friends||[]).includes(other)) return json({ error: '只能赠送给好友' }, 400);
      if ((u.arrows|0) < cnt) return json({ error: '箭矢不足' }, 400);
      u.arrows = (u.arrows|0) - cnt;
      o.arrows = (o.arrows|0) + cnt;
      const text = '🎁 送了你 ' + cnt + ' 支箭';
      u.dm = (u.dm||[]); u.dm.push({ from: me.name, to: other, text, ts: Date.now() }); u.dm = u.dm.slice(-300);
      o.dm = (o.dm||[]); o.dm.push({ from: me.name, to: other, text, ts: Date.now() }); o.dm = o.dm.slice(-300);
      await writeUser(env, me.name, u); await writeUser(env, other, o);
      await notifyUser(env, other, { t: 'gift', from: me.name, count: cnt });
      return json({ ok: true, arrows: u.arrows|0 });
    }

    /* ---- 多人房间列表（DO 内存中的活跃房间） ---- */
    if (path === '/api/rooms' && request.method === 'GET') {
      try {
        const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
        const r = await stub.fetch('https://do/rooms');
        return json(await r.json());
      } catch (e) { return json({ rooms: [] }); }
    }
    if ((path === '/api/event/shoot' || path === '/api/event/hit') && request.method === 'POST') {
      return json({ ok: true });
    }

    /* ---- 管理接口（按用户 KV 存取） ---- */
    if (path.startsWith('/api/admin/')) {
      if (!(me.isAdmin || me.isDeveloper)) return json({ error: '需要管理员权限' }, 403);
      const uname = String(body.username || '').trim();
      const target = uname ? await readUser(env, uname) : undefined;
      const isDev = function(u){ return u && u.isDeveloper; };
      var canTouch = function(u){ return u && (me.name === ADMIN_NAME || (!isDev(u) && (!u.isAdmin || me.isDeveloper))); };
      var meIsDev = !!me.isDeveloper;

      /* 救援迁移: 只读导出 DO state.storage 里的旧账号库 */
      if (path === '/api/admin/do-db' && request.method === 'GET') {
        try {
          const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
          const r = await stub.fetch('https://do/db-dump', { headers: { 'X-Internal-Token': (env.AI_PROXY_TOKEN || '') } });
          const d = await r.json();
          return json({ has: d.has, count: d.count, db: d.db });
        } catch (e) { return json({ error: String((e && e.message) || e).slice(0, 200) }, 500); }
      }

      if (path === '/api/admin/users' && request.method === 'GET') {
        const online = await presenceList(env);
        const all = await listAllUsers(env);
        var pub = [];
        for (var nm in all) {
          var ru = all[nm];
          if (!ru || ru.deleted) continue;
          if (!ru.reg && !ru.arrows) { ru = (await readUser(env, nm)) || ru; }   // KV兜底空壳: 单独补读
          if (!ru || ru.deleted) continue;
          pub.push(pubUser({ ...ru, _name: nm, _online: online.includes(nm) }));
        }
        pub.sort(function(a, b){ return b.score - a.score; });
        return json({ users: pub });
      }
      if (path === '/api/admin/warnings' && request.method === 'GET') return json({ players: [] });
      if (request.method !== 'POST') return json({ error: 'not found' }, 404);

      if (path === '/api/admin/promote') {
        if (!meIsDev) return json({ error: '只有开发者能任命管理员' }, 403);
        var tu = await readUser(env, uname);
        if (!tu) return json({ error: '这个玩家不存在' }, 400);
        if (isDev(tu)) return json({ error: '该账号是开发者' }, 400);
        tu.isAdmin = true; await writeUser(env, uname, tu);
        return json({ ok: true });
      }
      if (path === '/api/admin/demote') {
        if (!meIsDev) return json({ error: '只有开发者能取消管理员' }, 403);
        var tu2 = await readUser(env, uname);
        if (!tu2) return json({ error: '这个玩家不存在' }, 400);
        tu2.isAdmin = false; await writeUser(env, uname, tu2);
        return json({ ok: true });
      }
      if (path === '/api/admin/ban') {
        var tb = await readUser(env, uname);
        if (!tb) return json({ error: '这个玩家不存在' }, 400);
        if (!canTouch(tb)) return json({ error: '无权操作该账号' }, 400);
        tb.banned = body.banned === false ? false : true;
        await writeUser(env, uname, tb);
        if (tb.banned) await notifyUser(env, uname, { t: 'kicked', reason: 'banned' });
        return json({ ok: true });
      }
      if (path === '/api/admin/setdeveloper') {
        if (!meIsDev) return json({ error: '只有开发者能任命开发者' }, 403);
        var td = await readUser(env, uname);
        if (!td) return json({ error: '这个玩家不存在' }, 400);
        if (body.on === false) { if (uname === ADMIN_NAME) return json({ error: '内置开发者不可降级' }, 400); td.isDeveloper = false; }
        else td.isDeveloper = true;
        await writeUser(env, uname, td);
        return json({ ok: true });
      }
      if (path === '/api/admin/delete') {
        var tdel = await readUser(env, uname);
        if (!tdel) return json({ error: '这个玩家不存在' }, 400);
        if (!canTouch(tdel)) return json({ error: '无权删除该账号' }, 400);
        await delUser(env, uname);
        await notifyUser(env, uname, { t: 'kicked', reason: 'deleted' });
        return json({ ok: true, name: uname });
      }
      if (path === '/api/admin/setpassword') {
        var pass2 = String(body.password || '');
        var tp = await readUser(env, uname);
        if (!tp) return json({ error: '这个玩家不存在' }, 400);
        if (!canTouch(tp)) return json({ error: '无权操作该账号' }, 400);
        if (pass2.length < 6) return json({ error: '密码至少 6 位' }, 400);
        tp.salt = hex(crypto.getRandomValues(new Uint8Array(8)));
        tp.pass = await hashPass(pass2, tp.salt);
        await writeUser(env, uname, tp);
        return json({ ok: true });
      }
      if (path === '/api/admin/score') {
        const d2 = Math.max(-500, Math.min(500, body.delta | 0));
        if (body.zero) {
          /* 全体清零: 主存(数据服务 __index)优先, PATCH 只改 score 字段; 数据服务不可用时回退 KV 读改写。
             (修复 P0: 原实现 cursor 未声明, ES Module 严格模式直接 ReferenceError → 该接口必定 500;
              且原实现只遍历 KV 的 u: 键, 早已迁到数据服务的账号一个都清不到) */
          const allZero = await listAllUsers(env);
          const namesZero = Object.keys(allZero);
          var zeroed = 0;
          for (var zi = 0; zi < namesZero.length; zi++) {
            var zn = namesZero[zi];
            if (isDev(allZero[zn])) continue;   // 开发者账号保持不动(与原逻辑一致)
            var zok = false;
            try { zok = await dsPatch(env, zn, { score: 0 }); } catch (e) { zok = false; }
            if (zok) { zeroed++; continue; }
            var zu = await readUser(env, zn);
            if (zu && !isDev(zu)) { zu.score = 0; await writeUser(env, zn, zu); zeroed++; }
          }
          return json({ ok: true, zeroed: zeroed, total: namesZero.length });
        }
        if (body.all) {
          /* 全体加分: 用 __index 的名字+当前分, PATCH 只改 score 字段(不读不写整记录) */
          const allAdj = await listAllUsers(env);
          for (var nm2 in allAdj) {
            var au = allAdj[nm2] || {};
            if (au.isDeveloper) continue;
            var ns = Math.max(0, (au.score | 0) + d2);
            try { await dsPatch(env, nm2, { score: ns }); } catch (e) {}
          }
          return json({ ok: true });
        }
        var tsu = await readUser(env, uname);
        if (!tsu) return json({ error: '这个玩家不存在' }, 400);
        if (!canTouch(tsu)) return json({ error: '无权操作该账号' }, 400);
        tsu.score = Math.max(0, (tsu.score||0) + d2);
        await writeUser(env, uname, tsu);
        return json({ ok: true, score: tsu.score });
      }
      return json({ error: 'not found' }, 404);
    }
    return json({ error: 'not found' }, 404);
}

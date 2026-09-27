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
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
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
  if (RL.size > 4000) {   // 内存兜底: 清掉已过期的桶(桶结构 {w,t}, 只删最后一条已过期的)
    for (const [k, v] of RL) { if (!v.t.length || now - v.t[v.t.length - 1] > v.w) RL.delete(k); }
  }
  return true;
}
/* 只记"失败"的限流: 记一次并返回是否仍在配额内(用于登录, 防止被用来定向锁死账号) */
function rlFail(key, max, windowMs) {
  const now = Date.now();
  const e = RL.get(key);
  const arr = e ? e.t.filter(function (t) { return now - t < windowMs; }) : [];
  arr.push(now);
  RL.set(key, { w: windowMs, t: arr });
  return arr.length <= max;
}
function rlClear(key) { RL.delete(key); }
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
/* 经济类接口统一 count 校验(渗透#4/#5/#10): 必须是 [min,max] 内的整数, 缺省取 def; 非法一律 null → 上层 400。
   原本是 Math.max/min 静默归一(count=-999999 也按 1 结算), 看着"能用"实则掩盖客户端 bug 与恶意输入 */
function intCount(v, def, min, max) {
  if (v === undefined || v === null || v === '') v = def;
  return (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max) ? v : null;
}
/* ===== 成就服务端白名单与达成条件(渗透#2) =====
   原本客户端报什么 id 就解锁什么: 可一次拿到全部成就, 还能写入任意伪造 id */
const ACH_IDS = ['first-hit', 'combo-5', 'combo-10', 'perfect-round', 'round-100', 'round-300', 'round-500',
  'rush-200', 'rush-400', 'endless-300', 'endless-600', 'precision-100', 'precision-200',
  'billion-1', 'anticard-1', 'rank-diamond', 'rank-king'];
/* false = 服务端判定未达成, 忽略该 id。连击/百发百中这类只在对局内的遥测服务端无从核验,
   只做白名单放行 —— 成就不发任何奖励, 伪造它拿不到实际收益 */
function achMet(id, u) {
  const best = u.best || {};
  const top = Math.max(best.endless | 0, best.rush30 | 0);
  const sc = u.score | 0;
  switch (id) {
    case 'rank-diamond': return sc >= 60000;
    case 'rank-king': return sc >= 400000;
    case 'rush-200': return (best.rush30 | 0) >= 600;
    case 'rush-400': return (best.rush30 | 0) >= 1500;
    case 'endless-300': return (best.endless | 0) >= 1200;
    case 'endless-600': return (best.endless | 0) >= 3000;
    /* 单局分必然 <= 累计分, 用它当"成立条件"不会误伤正常玩家 */
    case 'round-100': return sc >= 1000 || top >= 1000;
    case 'round-300': return sc >= 3000 || top >= 3000;
    case 'round-500': return sc >= 10000 || top >= 10000;
    case 'precision-100': return sc >= 300 || top >= 300;
    case 'precision-200': return sc >= 800 || top >= 800;
    case 'anticard-1': return (u.anticard | 0) >= 1;
    case 'billion-1': { const sp = u.sp || {}; let t = 0; for (const k in sp) t += sp[k] | 0; return t >= 1; }
    default: return true;
  }
}
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

    /* 明文 HTTP 一律跳 HTTPS: X-User-Token 是明文令牌, 不能走明文通道(渗透#8)。
       放行回环地址与内网地址(本地 wrangler dev、自建反代/LAN 部署只有 http, 否则会被自己重定向)。
       用严格正则: 原来 `indexOf('127.')===0` 会把 127.evil.com 这种域名也当回环放行 */
    const hn = url.hostname;
    const isLocal = hn === 'localhost' || hn === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hn);
    const isPrivate = /^10(\.\d{1,3}){3}$/.test(hn) || /^192\.168(\.\d{1,3}){2}$/.test(hn) ||
      /^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/.test(hn);
    if (url.protocol === 'http:' && !isLocal && !isPrivate) return Response.redirect('https://' + url.host + url.pathname + url.search, 301);

    /* WebSocket upgrade -> Durable Object（原样转发, DO 自行验签） */
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
      return stub.fetch(request);
    }

    if (!url.pathname.startsWith('/api/')) {
      try {
        const res = await env.ASSETS.fetch(request);
        const h = new Headers(res.headers);
        h.set('Cache-Control', 'no-cache');   // 允许 ETag 复验(304), 既不给过期 HTML 也不让 1.6MB 每次全量重下
        h.set('CDN-Cache-Control', 'no-store');
        /* 安全响应头(渗透#8): 全站原本一个都没有 */
        h.set('X-Content-Type-Options', 'nosniff');
        h.set('Content-Security-Policy', "frame-ancestors 'none'");   // 点击劫持: 只管 frame, 不碰内联脚本, 零兼容风险
        h.set('X-Frame-Options', 'DENY');                              // 与 frame-ancestors 'none' 同义, 兼容老浏览器(不与之矛盾)
        h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
        h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
        h.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
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
    /* 取客户端 IP(限流 key): CF 边缘头优先, 本地/自建反代回退 XFF 第一跳 */
    const xff = request.headers.get('X-Forwarded-For') || '';
    const ip = request.headers.get('CF-Connecting-IP') || (xff.split(',')[0] || '').trim() || 'unknown';

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
      /* 需登录(渗透#7): 原本在鉴权闸之前, 任何人可批量探测账号存在性/下载任意玩家皮肤;
         同作用域的 /api/cape/get 本来就要求登录, 属鉴权不一致 */
      if (!me) return json({ error: '未登录或登录已过期' }, 401);
      if (!rateLimit('skin:' + ip, 60, 60000)) return json({ error: '请求过于频繁，请稍后再试' }, 429);
      const nm = String(url.searchParams.get('name') || '').slice(0, 16);
      const u = await readUser(env, nm);
      return json({ skin: (u && u.skin) || null });
    }
    if (path === '/api/config' && request.method === 'GET') {
      return json({ config: { maxScore: 999999, server: 'bow-v5-cf' } });
    }

    /* ---- 认证 ---- */
    if (path === '/api/register' && request.method === 'POST') {
      if (!rateLimit('rg:' + ip, 8, 600000)) return json({ error: '注册太频繁了，请 10 分钟后再试' }, 429);
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
      return json({ token: await issueToken(env, name, 0), user: pubUser(u) });
    }
    if (path === '/api/login' && request.method === 'POST') {
      if (!rateLimit('lgi:' + ip, 10, 300000)) return json({ error: '登录太频繁了，请 5 分钟后再试' }, 429);
      try {
        const name = String(body.username || '').trim();
        const pass = String(body.password || '');
        const lgnKey = 'lgn:' + name.toLowerCase();   // 账号级桶: 只记密码错误(见下), 不预检
        let u = await readUser(env, name);
        if (!u) return json({ error: '账号或密码错误！' }, 400);   // 统一文案: 消除用户名枚举(渗透#3)
        if (!u.salt && !u.pass) {
          /* 自动建档账号（无密码）首次登录即认领: 设置密码 */
          if (pass.length < 6) return json({ error: '密码至少 6 位' }, 400);
          const csalt = hex(crypto.getRandomValues(new Uint8Array(8)));
          u.salt = csalt;
          u.pass = await hashPass(pass, csalt);
          await writeUser(env, name, u);
          return json({ token: await issueToken(env, name, u.tv), user: pubUser({ ...u, _name: name }) });
        }
        if (await hashPass(pass, u.salt) !== u.pass) {
          /* 账号级限速只统计密码错误(8次/5分): 正确密码永远能进, 防止被人拿错误密码定向锁死账号(含管理员) */
          const over = name && !rlFail(lgnKey, 8, 300000);
          return json({ error: over ? '该账号尝试过多，请 5 分钟后再试' : '账号或密码错误！' }, over ? 429 : 400);   // 与"账号不存在"同文案, 消除枚举(渗透#3)
        }
        rlClear(lgnKey);   // 登录成功: 清掉该账号的失败计数
        if (u.banned) return json({ error: 'banned' }, 403);
        u.lastLogin = Date.now();
        await writeUser(env, name, u);
        return json({ token: await issueToken(env, name, u.tv), user: pubUser({ ...u, _name: name }) });
      } catch (e) { return json({ error: 'SRV ' + (e.message || String(e)) + ' :: ' + String(e.stack || '').slice(0, 400) }, 500); }
    }

    if (!me) return json({ error: '未登录或登录已过期' }, 401);
    if (path === '/api/logout' && request.method === 'POST') {
      /* 吊销令牌(渗透#6): 账号版本号 tv +1 → 该账号所有已签发令牌立即失效。
         用 dsPatch 只写 tv 字段并检查返回值: 整条回写会把并发写入的分数/私信覆盖掉,
         而只进 dirty 队列再"假装成功"的话, 数据服务挂掉时登出其实没生效 */
      const tvNew = ((me.tv | 0) + 1);
      let okLg = false;
      try { const rL = await dsPatch(env, me.name, { tv: tvNew }); okLg = !!rL; } catch (e) { okLg = false; }
      if (!okLg) return json({ error: '登出失败，请稍后重试' }, 502);
      try { const uL = await readUser(env, me.name); if (uL) { uL.tv = tvNew; await writeUser(env, me.name, uL); } } catch (e) {}
      return json({ ok: true });
    }

    /* ---- 已登录: 账号数据（全部走按用户 KV, 零 DO 消耗） ---- */
    if (path === '/api/me' && request.method === 'GET') {
      const online = (await presenceList(env)).includes(me.name);
      /* hideNames: 让前端在运行时才知道要隐藏/特殊显示的账号名, 不再把最高权限账号名硬编码进客户端(渗透#3) */
      return json({ user: pubUser({ ...me, _name: me.name, _online: online }), hideNames: [ADMIN_NAME] });
    }
    if (path === '/api/score' && request.method === 'POST') {
      /* 记分限流: 单账号 10 秒内最多 90 次上报(留足分裂箭散射3支+狂射模式的余量), 挡住脚本刷分(P0) */
      if (!rateLimit('sc:' + me.name, 90, 10000)) return json({ error: '得分上报太频繁，请稍后再试', score: 0 }, 429);
      /* 记分下沉到数据服务原子操作(AI评审): 服务端校验反作弊并同步读改写 */
      let d2 = null;
      try { const r2 = await dsFetch(env, '/score/' + encodeURIComponent('u:' + me.name), 'POST', body); d2 = await r2.json(); } catch (e) { d2 = null; }   // 非JSON响应兜底(AI评审)
      if (d2 && d2.ok) return json({ score: d2.score|0 });
      const isAntiCheat = d2 && (d2.error || '').indexOf('贴脸') >= 0;
      return json({ error: (d2 && d2.error) || '服务暂时不可用，请稍后再试', score: (d2 && d2.score|0) || 0 }, d2 ? (isAntiCheat ? 403 : 400) : 502);
    }
    if (path === '/api/arrow/use' && request.method === 'POST') {
      /* 扣箭下沉为数据服务原子操作(AI评审双存储一致性问题): 整条记录回写会互相覆盖分数 */
      const n = intCount(body.count, 1, 1, 10);   // 渗透#10: 非法值不再按 1 静默结算
      if (n === null) return json({ error: '数量无效' }, 400);
      const rA = await dsFetch(env, '/arrowuse/' + encodeURIComponent('u:' + me.name), 'POST', { count: n });
      const dA = await rA.json();
      if (dA.ok) return json({ arrows: dA.arrows|0 });
      return json({ error: '服务暂时不可用，请稍后再试' }, 502);
    }
    if (path === '/api/shop/buy' && request.method === 'POST') {
      const count = intCount(body.count, 1, 1, 10000);   // 渗透#4
      if (count === null) return json({ error: '数量无效' }, 400);
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
      const rawT = body.type;
      /* 必须是字符串: String(['track']) === 'track', 数组/对象会被隐式转换成合法箭种(渗透#4) */
      if (typeof rawT !== 'string' || !SP_TYPES[rawT]) return json({ error: '未知箭种' }, 400);
      const type = rawT;
      const spCnt = intCount(body.count, 1, 1, 50);   // 渗透#4
      if (spCnt === null) return json({ error: '数量无效' }, 400);
      /* 特殊箭购买/消耗也下沉为数据服务原子操作(AI评审双存储一致性) */
      const rB = await dsFetch(env, (path === '/api/sp/buy' ? '/spbuy/' : '/spuse/') + encodeURIComponent('u:' + me.name), 'POST', { type: type, count: spCnt });
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
      if (!rateLimit('ach:' + me.name, 30, 60000)) return json({ error: '操作过于频繁，请稍后再试' }, 429);
      /* 上游也做长度/字符校验(AI评审), 与数据层正则清洗双保险 */
      const achId = String(body.id || '').slice(0, 24).replace(/[^a-zA-Z0-9_-]/g, '');
      if (!achId) return json({ error: '参数错误' }, 400);
      if (ACH_IDS.indexOf(achId) < 0) return json({ error: '无效成就' }, 400);      // 白名单(渗透#2)
      if (!achMet(achId, me)) return json({ ok: true, unlocked: false, ach: me.ach || [] });   // 未达成 → 静默忽略
      const r5 = await dsFetch(env, '/ach/' + encodeURIComponent('u:' + me.name), 'POST', { id: achId });
      let d5 = null;
      try { d5 = await r5.json(); } catch (e) { d5 = null; }
      if (d5 && d5.ok) { if (d5.ach) me.ach = d5.ach; return json({ ok: true, unlocked: !!d5.unlocked, ach: d5.ach || [] }); }
      return json({ error: '服务暂时不可用' }, 502);
    }
    if (path === '/api/ach/unlock-batch' && request.method === 'POST') {
      if (!rateLimit('ach:' + me.name, 30, 60000)) return json({ error: '操作过于频繁，请稍后再试' }, 429);
      /* 白名单 + 达成条件双重过滤(渗透#2): 伪造 id、未达成的 id 直接被丢弃 */
      const ids = (Array.isArray(body.ids) ? body.ids.slice(0, 20).map(function(x){ return String(x || '').slice(0, 24).replace(/[^a-zA-Z0-9_-]/g, ''); }).filter(Boolean) : [])
        .filter(function(x){ return ACH_IDS.indexOf(x) >= 0 && achMet(x, me); });
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
      /* 个人最佳上报限流: 前端无限模式"每次涨分就上报"，客户端已节流(≥3秒一次) ⇒ 正常玩家 ≤20次/分，
         这里给到 60次/分的余量, 只用来挡住脚本狂刷(原本完全无频控) */
      if (!rateLimit('bst:' + me.name, 60, 60000)) return json({ error: '上报过于频繁，请稍后再试' }, 429);
      const v = String(body.variant || '');
      if (v !== 'endless' && v !== 'rush30') return json({ error: '无效' }, 400);
      /* 必须是 0..999999 的整数(999999 = /api/config 的 maxScore)。
         原本 body.score|0 直接放行到 INT32_MAX: 1 次请求即可把 best 刷成 2147483647(渗透#1 HIGH) */
      const rawB = body.score;
      if (typeof rawB !== 'number' || !Number.isFinite(rawB) || Math.floor(rawB) !== rawB || rawB < 0 || rawB > 999999) return json({ error: '数据异常' }, 400);
      const s = rawB;
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
      const cnt = intCount(body.count, 1, 1, 100);   // 渗透#5: 负数/小数/超上限一律拒(原本 -1 也按 1 结算)
      if (cnt === null) return json({ error: '数量无效' }, 400);
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
        if (!env.AI_PROXY_TOKEN) return json({ error: '服务未配置(AI_PROXY_TOKEN)' }, 503);   // secret 缺失先硬失败, 避免拿到 403 纯文本后 JSON 解析炸成 500
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
        /* 改密即吊销: tv+1 让改密前签发的所有令牌失效(否则改密对已窃令牌毫无意义) */
        tp.tv = (tp.tv | 0) + 1;
        tp.salt = hex(crypto.getRandomValues(new Uint8Array(8)));
        tp.pass = await hashPass(pass2, tp.salt);
        await writeUser(env, uname, tp);
        return json({ ok: true });
      }
      if (path === '/api/admin/score') {
        const d2 = Math.max(-500, Math.min(500, body.delta | 0));
        if (body.zero) {
          /* 全体清零: 一条指令下沉到数据服务原子执行(服务端遍历账号、跳过开发者)。
             (修复 P0: 原实现 cursor 未声明, ES Module 严格模式直接 ReferenceError → 该接口必定 500;
              且原实现只遍历 KV 的 u: 键, 早已迁到数据服务的账号一个都清不到。
              也不再做"KV 读改写回退" —— writeUser 只进 dirty 队列, 最终 flushDirty 是整条回写,
              拿迁移期冻结的 KV 快照覆盖线上账号属于数据丢失风险, 数据服务不可用时宁可报错重试) */
          let dZ = null;
          try { const rZ = await dsFetch(env, '/scorezero', 'POST', {}); dZ = await rZ.json(); } catch (e) { dZ = null; }
          if (dZ && dZ.ok) return json({ ok: true, zeroed: dZ.changed|0, total: dZ.total|0, skippedDev: dZ.skippedDev|0 });
          return json({ error: '数据服务暂时不可用，清零未执行（可稍后重试）' }, 502);
        }
        if (body.all) {
          /* 全体加分: 同样下沉为数据服务一条原子指令(避免逐用户发 N 个 PATCH 撞子请求上限) */
          let dA = null;
          try { const rA = await dsFetch(env, '/scoreadj', 'POST', { delta: d2 }); dA = await rA.json(); } catch (e) { dA = null; }
          if (dA && dA.ok) return json({ ok: true, adjusted: dA.changed|0, total: dA.total|0, skippedDev: dA.skippedDev|0 });
          return json({ error: '数据服务暂时不可用，加分未执行（可稍后重试）' }, 502);
        }
        var tsu = await readUser(env, uname);
        if (!tsu) return json({ error: '这个玩家不存在' }, 400);
        if (!canTouch(tsu)) return json({ error: '无权操作该账号' }, 400);
        const newS = Math.max(0, (tsu.score | 0) + d2);
        /* 只 PATCH score 字段(评审C): 原本 readUser→writeUser 整条回写, 会拿 5 秒缓存快照
           覆盖并发写入的分数/私信/皮肤等其它字段 */
        const okS = await dsPatch(env, uname, { score: newS });
        if (!okS) return json({ error: '数据服务暂时不可用，未改动（可稍后重试）' }, 502);
        tsu.score = newS;
        return json({ ok: true, score: newS });
      }
      return json({ error: 'not found' }, 404);
    }
    return json({ error: 'not found' }, 404);
}

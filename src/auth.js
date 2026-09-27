/* 共享: 存储 + token 鉴权 (Worker 与 Durable Object 共用) */
const ADMIN_NAME = '为啥全部姓名都在';
const TOKEN_TTL = 30 * 24 * 3600 * 1000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64u = (buf) => {
  let s = ''; const b = new Uint8Array(buf);
  for (const c of b) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const bytesFromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((c) => c.toString(16).padStart(2, '0')).join('');
const bytesFromHex = (h) => new Uint8Array((h || '').match(/../g).map((b) => parseInt(b, 16)));

async function sha1Hex(s) { return hex(await crypto.subtle.digest('SHA-1', enc.encode(s))); }
async function sha256Hex(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function nameToId(name) { return 'u' + (await sha1Hex('bow:' + name)).slice(0, 15); }
async function hmacSign(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
async function hashPass(pass, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: bytesFromHex(saltHex).buffer, iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  return hex(bits);
}

/* 存储: KV 直读直写(绕开 DO 免费层请求限额); DO 仅用于 WS 房间(WS 内消息不计请求数) */
let dbCache = null;
async function getDb(env) {
  if (dbCache) return dbCache;
  try { const s = await env.BOW_KV.get('db'); if (s) { dbCache = JSON.parse(s); return dbCache; } } catch (e) {}
  try { const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
    const r = await stub.fetch('https://do/db');
    if (r.ok) { dbCache = await r.json(); return dbCache; } } catch (e) {}
  return {};
}
async function putDb(env, d) {
  dbCache = d;
  try { await env.BOW_KV.put('db', JSON.stringify(d)); } catch (e) {}
  return true;
}
async function getSecret(env) {
  /* 确定性密钥: 由 SECRET_PEPPER 推导, Worker 与 DO 各自本地计算, 永远一致(不再经 KV 分发)。
     ⚠ 两个 await 都不能少: 少了那个会变成 sha1(...) + "[object Promise]" —— 密钥后半段
       实际是个常量字符串, 且两处写法一旦被改就会让线上令牌全体失效 */
  const m = (env.SECRET_PEPPER || 'bow-fallback-v2') + '|bow-master|v1';
  return (await sha1Hex(m)) + (await sha256Hex(m));
}
async function issueToken(env, name, tv) {
  const sec = await getSecret(env);
  const userId = await nameToId(name);
  /* v = 账号令牌版本: 登出/改密时账号上的 tv +1, 旧令牌立即全部失效(渗透#6) */
  const payload = b64u(enc.encode(JSON.stringify({ userId, name, exp: Date.now() + TOKEN_TTL, v: (tv | 0) })));
  return payload + '.' + await hmacSign(sec, payload);
}
async function userFromToken(env, token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.indexOf('.');
  if (i < 0) return null;
  const head = token.slice(0, i), mac = token.slice(i + 1);
  const sec = await getSecret(env);
  const good = await hmacSign(sec, head);
  if (mac !== good) return null;
  try {
    const p = JSON.parse(dec.decode(bytesFromB64u(head)));
    if (!p.name || !p.exp || p.exp < Date.now()) return null;
    if (await nameToId(p.name) !== p.userId) return null;   // 防伪造
    const rec = await readUser(env, p.name);
    if (!rec) return null;
    if (rec.banned) return null;
    if ((p.v | 0) !== (rec.tv | 0)) return null;   // 版本不匹配 = 该令牌已被吊销(登出/改密)
    return { name: p.name, ...rec };
  } catch (e) { return null; }
}

/* ---------------- 数据服务(美国服务器中转, 无 KV 写入限额) ----------------
   env.DATA_URL + env.DATA_TOKEN; 主存走数据服务, KV 作镜像兜底 */
async function dsUrl(env, name) {
  return env.DATA_URL.replace(/\/+$/, '') + '/' + encodeURIComponent('u:' + name);
}
async function dsGet(env, name) {
  if (!env.DATA_URL) return null;
  try {
    const r = await fetch(await dsUrl(env, name), { headers: { 'X-Data-Token': env.DATA_TOKEN || '' }, cf: { cacheTtl: 0 } });
    if (!r.ok) return null;
    return JSON.parse(await r.text());
  } catch (e) { return null; }
}
async function dsPut(env, name, rec) {
  if (!env.DATA_URL) return false;
  try {
    const r = await fetch(await dsUrl(env, name), { method: 'PUT', headers: { 'X-Data-Token': env.DATA_TOKEN || '', 'Content-Type': 'application/json' }, body: JSON.stringify(rec) });
    return r.ok;
  } catch (e) { return false; }
}
async function dsDel(env, name) {
  if (!env.DATA_URL) return false;
  try {
    const r = await fetch(await dsUrl(env, name), { method: 'DELETE', headers: { 'X-Data-Token': env.DATA_TOKEN || '' } });
    return r.ok;
  } catch (e) { return false; }
}
/* 浅合并修改(不动未提及字段, 如皮肤/私信) */
async function dsPatch(env, name, patch) {
  if (!env.DATA_URL) return false;
  try {
    const r = await fetch(await dsUrl(env, name), { method: 'PATCH', headers: { 'X-Data-Token': env.DATA_TOKEN || '', 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    return r.ok;
  } catch (e) { return false; }
}

/* ---------------- 按用户 KV 存取（写入合并缓冲） ---------------- */
const UKEY = (name) => 'u:' + name;
var userCache = {};          // 内存缓存(所有已读/已写用户)
var userCacheT = {};         // 缓存写入时间(5秒TTL)
var dirtyUsers = {};         // 待刷写的用户名
var flushTimer = null;

function cacheGet(name) { return userCache[name] || null; }
function cachePut(name, rec) { userCache[name] = rec; userCacheT[name] = Date.now(); }

async function readUser(env, name) {
  /* 内存缓存带TTL(5秒): 避免isolate陈旧副本覆盖数据服务的新写入(AI评审) */
  if (userCache[name] !== undefined && Date.now() - (userCacheT[name] || 0) < 5000) return userCache[name];
  /* 数据服务(主存, 无限额) */
  var rec = await dsGet(env, name);
  if (rec) { cachePut(name, rec); return rec; }
  try { const v = await env.BOW_KV.get(UKEY(name)); if (v) { var recK = JSON.parse(v); cachePut(name, recK); return recK; } } catch (e) {}
  /* 旧整库迁移(只读兜底: 不再写 KV, 避免消耗写入额度) */
  try {
    var blob = JSON.parse((await env.BOW_KV.get('db')) || 'null');
    if (blob && blob[name]) {
      var rec2 = blob[name];
      cachePut(name, rec2);
      return rec2;
    }
  } catch (e) {}
  return null;
}
/* 写入: 更新内存缓存, 标记 dirty; 由请求结束前的 flushDirty 统一落盘(保证响应前持久化) */
function markDirty(name, rec) {
  userCache[name] = rec;
  dirtyUsers[name] = true;
}
async function flushDirty(env) {
  if (!env) return;
  var keys = Object.keys(dirtyUsers);
  for (var i = 0; i < keys.length; i++) {
    var nm = keys[i];
    var rec = userCache[nm];
    if (rec) {
      var ok = await dsPut(env, nm, rec);   // 主存(美国服务器): 成功才算落盘, KV 不再镜像(省写入额度)
      if (ok) delete dirtyUsers[nm];        // 主存失败保留 dirty, 下次请求重试
    } else { delete dirtyUsers[nm]; }
  }
}
async function writeUser(env, name, rec) {
  cachePut(name, rec);
  dirtyUsers[name] = true;
}
async function delUser(env, name) {
  delete userCache[name];
  try { await dsDel(env, name); } catch (e) {}
  try { await env.BOW_KV.delete(UKEY(name)); } catch (e) {}
}

function pubUser(u) {
  return {
    username: u._name, score: u.score || 0, banned: !!u.banned,
    isAdmin: !!u.isAdmin, isDeveloper: !!u.isDeveloper, arrows: (u.arrows === undefined ? 100 : (u.arrows | 0)),
    sp: u.sp || {},
    best: u.best || {},
    anticard: u.anticard || 0,
    ach: u.ach || [],
    reg: u.reg || 0, lastLogin: u.lastLogin || 0, online: u._online || false,
  };
}

export {
  ADMIN_NAME, TOKEN_TTL,
  b64u, hex, hashPass, getDb, putDb, getSecret, hmacSign,
  issueToken, userFromToken, pubUser, nameToId, readUser, writeUser, delUser, flushDirty, dsGet, dsPut, dsPatch,
};

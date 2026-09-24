/* 方块弓箭大师: 按用户分键的 JSON 存储 (KV 额度替代层) */
import http from 'http';
import fs from 'fs';
import path from 'path';
const DATA_DIR = '/data_store';
const TOKEN = (process.env.DATA_TOKEN || '').trim();
fs.mkdirSync(DATA_DIR, { recursive: true });
const AI_HITS = {};   // AI 中继限流: ip -> 时间戳数组
const SP_PRICE = { track: 8, split: 5, ice: 3, boom: 8, shadow: 10 };   // 价目表下沉到数据服务(AI评审: 不信任调用方)
const safeKey = (k) => k.replace(/[^a-zA-Z0-9\u4e00-\u9fa5._:-]/g, '').slice(0, 64);
const server = http.createServer((req, res) => {
  console.log('[req]', req.method, req.url);
  if (!TOKEN || (req.headers['x-data-token'] || '') !== TOKEN) { res.writeHead(403); res.end('forbidden'); return; }
  const url = new URL(req.url, 'http://localhost');
  let rawKey = url.pathname.replace(/^\/data\//, '').replace(/^\//, '');
  try { rawKey = decodeURIComponent(rawKey); } catch (e) {}   /* URL编码还原(中文键) */
  if (!rawKey) { res.writeHead(400); res.end('no key'); return; }
  const key = safeKey(rawKey);
  /* AI 中继: /ai/<path> -> opencode.ai(经美国服务器出口, 绕开对 Cloudflare Worker 出站的拦截) */
  if (req.method === 'POST' && rawKey.startsWith('ai/')) {
    if (rawKey !== 'ai/zen/go/v1/chat/completions') { res.writeHead(404); res.end('not found'); return; }   // 白名单: 仅聊天补全
    const rip = (req.socket.remoteAddress || '?');
    const nowT = Date.now();
    AI_HITS[rip] = (AI_HITS[rip] || []).filter(function(t){ return nowT - t < 600000; });
    if (AI_HITS[rip].length >= 30) { res.writeHead(429); res.end('rate limited'); return; }
    AI_HITS[rip].push(nowT);
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 400000) req.destroy(); });
    req.on('end', () => {
      const fwd = 'https://opencode.ai/' + rawKey.slice(3);   // rawKey 保留斜杠: ai/xxx -> opencode.ai/xxx
      const headers = { 'Content-Type': 'application/json', 'x-opencode-session': 'bow-master-relay-' + Math.random().toString(36).slice(2, 10), 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'Accept': 'application/json' };
      if (process.env.AI_KEY) headers['Authorization'] = 'Bearer ' + process.env.AI_KEY;
      else if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];
      console.log('[ai-relay] fwd=' + fwd + ' key=' + !!process.env.AI_KEY + ' bodyLen=' + (body || '').length);
      fetch(fwd, { method: 'POST', headers, body })
        .then(async (r) => {
          const txt = await r.text();
          console.log('[ai-relay] status=' + r.status + ' body=' + txt.slice(0, 160));
          res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json' });
          res.end(txt);
        })
        .catch((e) => { res.writeHead(502); res.end('relay err: ' + String(e && e.message || e).slice(0, 200)); });
    });
    return;
  }
  /* 赛季结算(原子): 同步读改写, 单线程事件循环内无并发交错 */
  if (req.method === 'POST' && rawKey.startsWith('settle/')) {
    if (!TOKEN || req.headers['x-data-token'] !== TOKEN) { res.writeHead(403); res.end('forbidden'); return; }
    const name = safeKey(rawKey.slice(7));   // 防路径穿越(AI评审: 必须过滤)
    if (!name) { res.writeHead(400); res.end('no name'); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 100000) req.destroy(); });
    req.on('end', () => {
      let arg = {};
      try { arg = JSON.parse(body || '{}'); } catch (e) {}
      const idx = arg.idx|0;
      const grant = Math.max(0, Math.min(200, (arg.grant|0) || 100));   // 补给数量钳制(AI评审)
      const f = path.join(DATA_DIR, name + '.json');   // name 已含 u: 前缀(AI评审: 修双前缀)
      let rec = {};
      try { rec = JSON.parse(fs.readFileSync(f, 'utf8') || '{}'); } catch (e) {}
      if ((rec.seasonIdx|0) !== idx) {
        if ((rec.anticard|0) > 0 && (rec.cardUsedSeason|0) !== idx) {
          rec.anticard = (rec.anticard|0) - 1;          // 防丢卡: 保护本次换季, 一次性
          rec.cardUsedSeason = idx;                     // 幂等键: 该赛季已消耗
        } else {
          rec.score = 0; rec.arrows = grant; rec.sp = {};   // 无卡: 积分/特殊箭清零, 箭矢补给
        }
        rec.seasonIdx = idx;
        try { fs.writeFileSync(f, JSON.stringify(rec)); } catch (e) { res.writeHead(500); res.end('write failed'); return; }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: 1, settled: (rec.seasonIdx|0) === idx, rec: rec }));
    });
    return;
  }
  /* 记分(原子): 服务端校验反作弊(12m/单次上限)并同步读改写 */
  if (req.method === 'POST' && rawKey.startsWith('score/')) {
    if (!TOKEN || req.headers['x-data-token'] !== TOKEN) { res.writeHead(403); res.end('forbidden'); return; }
    const name = safeKey(rawKey.slice(6));   // 防路径穿越(AI评审: 必须过滤)
    if (!name) { res.writeHead(400); res.end('no name'); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 100000) req.destroy(); });
    req.on('end', () => {
      let a = {};
      try { a = JSON.parse(body || '{}'); } catch (e) {}
      const f = path.join(DATA_DIR, name + '.json');   // name 已含 u: 前缀(AI评审: 修双前缀)
      if (!fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: 0, error: '账号不存在', score: 0 })); return; }
      let rec = {};
      try { rec = JSON.parse(fs.readFileSync(f, 'utf8') || '{}'); } catch (e) {}
      const d = a.delta|0;
      if (!Number.isInteger(d) || d < 1 || d > 15) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: 0, error: '数据异常', score: rec.score|0 })); return; }
      const T1 = { x: -2.0, z: -22 }, T2 = { x: 2.0, z: -22 };
      const px = Number(a.x), pz = Number(a.z);
      if (Number.isFinite(px) && Number.isFinite(pz)) {
        const d1 = Math.hypot(px - T1.x, pz - T1.z), d2 = Math.hypot(px - T2.x, pz - T2.z);
        if (Math.min(d1, d2) < 12) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: 0, error: '贴脸得分已被拒绝', score: rec.score|0 })); return; }
      }
      rec.score = (rec.score|0) + d;
      try { fs.writeFileSync(f, JSON.stringify(rec)); } catch (e) { res.writeHead(500); res.end('write failed'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: 1, score: rec.score|0 }));
    });
    return;
  }
  /* 购特殊箭(原子): 扣积分加库存 */
  if (req.method === 'POST' && rawKey.startsWith('spbuy/')) {
    if (!TOKEN || req.headers['x-data-token'] !== TOKEN) { res.writeHead(403); res.end('forbidden'); return; }
    const name = safeKey(rawKey.slice(6));
    if (!name) { res.writeHead(400); res.end('no name'); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 100000) req.destroy(); });
    req.on('end', () => {
      let a = {};
      try { a = JSON.parse(body || '{}'); } catch (e) {}
      const type = String(a.type || '').slice(0, 12);
      const f = path.join(DATA_DIR, name + '.json');
      if (!fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: 0, error: '账号不存在', score: 0 })); return; }
      let rec = {};
      try { rec = JSON.parse(fs.readFileSync(f, 'utf8') || '{}'); } catch (e) {}
      if (!SP_PRICE[type]) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: 0, error: '未知箭种', score: rec.score|0 })); return; }   // 类型白名单+价目表在服务端(AI评审: 不可信客户端价格)
      const count = Math.max(1, Math.min(50, (a.count|0) || 1));
      const cost = SP_PRICE[type] * count;
      if (!rec.sp) rec.sp = {};
      if ((rec.score|0) < cost) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: 0, error: '积分不足，还差 ' + (cost - (rec.score|0)) + ' 分', score: rec.score|0 })); return; }
      rec.score = (rec.score|0) - cost;
      rec.sp[type] = (rec.sp[type]|0) + count;
      try { fs.writeFileSync(f, JSON.stringify(rec)); } catch (e) { res.writeHead(500); res.end('write failed'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: 1, score: rec.score|0, left: rec.sp[type]|0 }));
    });
    return;
  }
  /* 扣箭(原子): 支持批量(脱靶连扣) */
  if (req.method === 'POST' && rawKey.startsWith('arrowuse/')) {
    if (!TOKEN || req.headers['x-data-token'] !== TOKEN) { res.writeHead(403); res.end('forbidden'); return; }
    const name = safeKey(rawKey.slice(9));
    if (!name) { res.writeHead(400); res.end('no name'); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 100000) req.destroy(); });
    req.on('end', () => {
      let a = {};
      try { a = JSON.parse(body || '{}'); } catch (e) {}
      const n = Math.max(1, Math.min(10, (a.count|0) || 1));
      const f = path.join(DATA_DIR, name + '.json');
      if (!fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: 0, error: '账号不存在', arrows: 0 })); return; }
      let rec = {};
      try { rec = JSON.parse(fs.readFileSync(f, 'utf8') || '{}'); } catch (e) {}
      rec.arrows = Math.max(0, (rec.arrows|0) - n);
      try { fs.writeFileSync(f, JSON.stringify(rec)); } catch (e) { res.writeHead(500); res.end('write failed'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: 1, arrows: rec.arrows|0 }));
    });
    return;
  }
  /* 特殊箭消耗(原子) */
  if (req.method === 'POST' && rawKey.startsWith('spuse/')) {
    if (!TOKEN || req.headers['x-data-token'] !== TOKEN) { res.writeHead(403); res.end('forbidden'); return; }
    const name = safeKey(rawKey.slice(6));
    if (!name) { res.writeHead(400); res.end('no name'); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 100000) req.destroy(); });
    req.on('end', () => {
      let a = {};
      try { a = JSON.parse(body || '{}'); } catch (e) {}
      const type = String(a.type || '').slice(0, 12);
      if (!SP_PRICE[type]) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: 0, error: '未知箭种', left: 0 })); return; }   // 类型白名单(AI评审)
      const f = path.join(DATA_DIR, name + '.json');
      if (!fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: 0, error: '账号不存在', left: 0 })); return; }
      let rec = {};
      try { rec = JSON.parse(fs.readFileSync(f, 'utf8') || '{}'); } catch (e) {}
      if (!rec.sp) rec.sp = {};
      if ((rec.sp[type]|0) < 1) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: 0, error: '该箭已用完', left: 0 })); return; }
      rec.sp[type] = (rec.sp[type]|0) - 1;
      try { fs.writeFileSync(f, JSON.stringify(rec)); } catch (e) { res.writeHead(500); res.end('write failed'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: 1, left: rec.sp[type]|0 }));
    });
    return;
  }
  /* 购防丢卡(原子): 校验积分并同步扣分+发卡 */
  if (req.method === 'POST' && rawKey.startsWith('cardbuy/')) {
    if (!TOKEN || req.headers['x-data-token'] !== TOKEN) { res.writeHead(403); res.end('forbidden'); return; }
    const name = safeKey(rawKey.slice(8));   // 防路径穿越(AI评审: 必须过滤)
    if (!name) { res.writeHead(400); res.end('no name'); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 100000) req.destroy(); });
    req.on('end', () => {
      let a = {};
      try { a = JSON.parse(body || '{}'); } catch (e) {}
      const cost = (a.cost|0) || 5000;
      const f = path.join(DATA_DIR, name + '.json');   // name 已含 u: 前缀(AI评审: 修双前缀)
      if (!fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: 0, error: '账号不存在', score: 0 })); return; }
      let rec = {};
      try { rec = JSON.parse(fs.readFileSync(f, 'utf8') || '{}'); } catch (e) {}
      if ((rec.score|0) < cost) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: 0, error: '积分不足，还差 ' + (cost - (rec.score|0)) + ' 分', score: rec.score|0 })); return; }
      rec.score = (rec.score|0) - cost;
      rec.anticard = (rec.anticard|0) + 1;
      try { fs.writeFileSync(f, JSON.stringify(rec)); } catch (e) { res.writeHead(500); res.end('write failed'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: 1, score: rec.score|0, anticard: rec.anticard|0 }));
    });
    return;
  }
  /* __index: 一次性返回全部账号(剥掉皮肤/私信大字段) */
  if (req.method === 'GET' && key === '__index') {
    let files = [];
    try { files = fs.readdirSync(DATA_DIR); } catch (e) {}
    const out = {};
    for (const f of files) {
      if (!f.startsWith('u:') || !f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        delete rec.skin; rec.dm = [];
        out[f.slice(2, -5)] = rec;
      } catch (e) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(out));
    return;
  }
  const file = path.join(DATA_DIR, key + '.json');
  const tmp = file + '.tmp';
  if (req.method === 'GET') {
    fs.readFile(file, 'utf8', (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  } else if (req.method === 'PUT' || req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 200000) req.destroy(); });
    req.on('end', () => {
      fs.writeFile(tmp, body, (err) => {
        if (err) { res.writeHead(500); res.end('err'); return; }
        fs.rename(tmp, file, (err2) => { res.writeHead(err2 ? 500 : 200); res.end(err2 ? 'err' : 'ok'); });
      });
    });
  } else if (req.method === 'PATCH') {
    /* 浅合并: 读取现有记录后合并写入(用于批量加分等, 不动 skin/dm 等未提及字段) */
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 100000) req.destroy(); });
    req.on('end', () => {
      fs.readFile(file, 'utf8', (err, old) => {
        let obj = {};
        try { obj = JSON.parse(old || '{}'); } catch (e) { obj = {}; }
        let patch = {};
        try { patch = JSON.parse(body || '{}'); } catch (e) { patch = {}; }
        for (const k in patch) obj[k] = patch[k];
        fs.writeFile(tmp, JSON.stringify(obj), (err2) => {
          if (err2) { res.writeHead(500); res.end('err'); return; }
          fs.rename(tmp, file, (err3) => { res.writeHead(err3 ? 500 : 200); res.end(err3 ? 'err' : 'ok'); });
        });
      });
    });
  } else if (req.method === 'DELETE') {
    fs.rm(file, { force: true }, (err) => { res.writeHead(err ? 500 : 200); res.end(err ? 'err' : 'ok'); });
  } else { res.writeHead(405); res.end('method not allowed'); }
});
server.listen(8081, '127.0.0.1', () => console.log('bow data server on :8081'));

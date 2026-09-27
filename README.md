# 方块弓箭大师 v4.0-CF · Cloudflare Workers 部署说明

架构：`public/` 前端静态托管 + `src/index.js` 账号API（KV存储）+ `src/do.js` WebSocket房间（Durable Object）

## 前置
1. 注册 Cloudflare 账号，装 Node.js
2. 命令行：
   ```
   npm install
   npx wrangler login
   ```
3. 建一个 KV 存储空间：
   ```
   npx wrangler kv namespace create BOW_KV
   ```
   把输出的 `id` 填进 wrangler.jsonc 里 `kv_namespaces` 的 `"id"`（替换"在这里填你的KV_NAMESPACE_ID"）

## 部署
```
npx wrangler deploy
```
完成后会输出 https://bow-master.你的子域.workers.dev —— 这就是游戏地址，发朋友就能玩。

## 首次启动
自动创建开发者账号：
- 账号名见 `src/auth.js` 的 `ADMIN_NAME`（仓库公开，**请勿在文档/前端暴露**）
- 初始密码**不在仓库内**：`ADMIN_DEFAULT_PASS` 常量已删除，但**旧默认密码仍留在 git 历史里**，删常量不等于抹掉历史。线上账号若仍是旧默认密码，**必须立刻改密**
- 改密没有前端入口，走管理员 API（新密码至少 6 位；改密会吊销该账号所有已登录令牌。普通管理员只能改自己或下级账号，改开发者/超管会返回 `无权操作该账号`）：
  ```bash
  # token 用管理员账号调 POST /api/login 的返回值
  curl -X POST https://<你的域名>/api/admin/setpassword \
    -H 'Content-Type: application/json' -H 'X-User-Token: <token>' \
    -d '{"username":"<账号名>","password":"<新密码>"}'
  ```
- 其他人正常注册，开发者可在管理面板任命管理员

## 免费额度提醒
- Workers 免费版：10万请求/天
- KV 免费版：写 1000次/天（每次注册/登录/计分都会写，人多了会撞墙，游戏命中计分也计——重度玩会超）
- Durable Objects：免费版可用（SQLite 后端）
- 超额就 $5/月 付费版，额度基本用不完

## 本地预览
```
npx wrangler dev
```
开 http://localhost:8787

## 文件结构
```
wrangler.jsonc    部署配置（KV/DO/静态目录）
src/index.js      API + token + 路由
src/do.js         RoomDO 房间服务器（WebSocket）
public/index.html 前端（和 v4.0 相同，不用改）
```

<!-- CI 测试标记 -->

<!-- PR 流程验证 -->

---

## 版权与授权 ©

© 2026 xiaopi668 · **保留所有权利 / All Rights Reserved**

本项目为专有软件，未经作者书面授权不得复制、修改、分发或商用。详见 [LICENSE](LICENSE)。

- 2026-09-13: AI 审核流水线联调通过（中继 + workers 出站链路修复）
- 2026-09-13: 补充联机稳定性说明（心跳保活与断线自动重连）
- 2026-09-27: **停用 AI 审核自动合并**（`.github/workflows/ai-review.yml` 已删除，中继上游 403/额度耗尽），改为人工审核后手动合并 `gh pr merge`
- 2026-09-27: 渗透测试加固（game.xiaopi.ink 报告 10 项）：`/api/best` 上限+限流、成就白名单+达成条件、登出吊销令牌、`/api/skin/get` 需登录、统一登录报错消除用户名枚举、安全响应头+强制 HTTPS、经济接口 count 严格校验、移除前端硬编码的管理员账号名
- 2026-09-27: 复审跟进（PR #31）：修复 `getSecret` 少一个 `await`（密钥退化为 sha1+常量字符串，修复后**全部旧登录态失效、需重新登录**）、登出/改密真吊销令牌且登出改用字段级落盘、`best` 上报客户端节流 3 秒 + 服务端 60 次/分、资产 `Cache-Control` 改 `no-cache`（避免 1.6MB 每次全量重下）、删除公开仓库里的默认密码常量 `ADMIN_DEFAULT_PASS` 与永远 404 的 DO 回源兜底
- 2026-09-27: 复审二轮必改（PR #31）：前端登出失败不再被吞掉（服务端 502/网络失败时提示`退出失败`并保留登录态可重试，不再无条件显示`已退出登录`）、数据服务 `PATCH` 对不存在的键返回 404（不再凭空写出只有 `{tv}` 的残缺文件遮蔽 KV 老账号）、README 改为如实说明旧默认密码仍在 git 历史、前端无改密入口（附管理员改密 API 示例）
- 2026-09-27: 页脚友情链接：登录/注册/大厅底部展示外链，开发者后台「玩家管理」内可增删（仅开发者可写，普通管理员只读）；`GET /api/friendlinks` 公开只读，`POST /api/admin/friendlinks` `{op:add|del,name,url}`；链接只收 http/https（挡 `javascript:` 伪协议，无协议头自动补 `https://`）、名称 1-24 字禁 `<>`、同名/同链接去重、上限 30 条、管理端 60 次/分 + 公开读 120 次/分限流；存 KV 单键 `flinks`（改的次数可忽略，不占写入额度）

> **部署前提（限流相关）**：限流按 `CF-Connecting-IP` 取不到时回退 `X-Forwarded-For` 第一跳。
> 只有在「前置代理会覆盖 XFF」的环境（Cloudflare 默认如此）下才安全；若直接挂在**不改写 XFF 的自建反代**后面，
> 客户端可伪造 XFF 绕过注册/登录限流——这种情况请在反代上强制写入真实客户端 IP。

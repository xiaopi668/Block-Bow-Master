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
- 账号：`为啥全部姓名都在`
- 初始密码：`abc198992`（登录后立刻改密！）
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

## 更新记录

- v5.3-CF: 结构优化版（账号存自建数据服务、多人房间、AI 审核 PR 流程）

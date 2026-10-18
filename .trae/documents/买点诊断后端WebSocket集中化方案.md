# 买点诊断后端 WebSocket 集中化改造方案

## Context（为什么做）

当前买点诊断在**前端多处重复轮询**：`OpeningBattle`（弹窗 + 发飞书）、`FloatingStockPosition`（开抽屉 + 发飞书）、`MainFund`（开抽屉）各自每 5 分钟 POST `/buy_point_checks`，命中判定、频控、飞书发送都在前端且互不感知。后果：

- 同一时刻某页同时挂载 `FloatingStockPosition`（全局挂载）与该页自身卡片时，**一次命中会发出 2 张飞书卡片、弹 2 个 UI**；
- 页面未打开时完全无诊断、无飞书；频控口径三处不一致。

目标：把买点诊断收敛为**后端单一集中管控**——后端每 10s 跑一次诊断，通过 WebSocket 把诊断结果实时推给前端；命中时由**后端**在同一 5 分钟时间桶内最多一次地发送飞书 + 下发“打开抽屉/弹窗”信号。前端的“打开抽屉后刷新数据”“手动刷新按钮”仍走独立 HTTP 拉最新诊断，但**不再发飞书、不再触发打开动作**。

### 已确认的决策（与用户）
1. **后端维护全局模式**（`tech_attack` / `hot_money_extreme_win`），前端切换模式时同步给后端并持久化；即使浏览器未开，后端也照常发飞书。
2. WS **每 10s 推完整诊断结果**（卡片实时展示）+ **桶门控的命中/打开信号**。
3. `MainFund` 也迁移到 WS（移除其前端轮询）。
4. **卖点诊断完全不动**（前端轮询 + 飞书逻辑保持现状）。

---

## 一、核心口径：5 分钟时间桶（严格对齐回测）

回测的桶来自 `trainingCamp` 的 `timeBuckets`（`server/src/service/trainingCamp.js` L461-467），其骨架来自资金快照 `fundSnapshot.aggregateByInterval`（`server/src/service/fundSnapshot.js` L48-103）：向前归属，桶只保留边界点。

**合法桶标签唯一集合** = 上午 `9:35, 9:40, …, 11:30`；下午 `13:05, 13:10, …, 15:00`（即 `9:30+5` 起、`13:00+5` 起，步长 5）。注意：**没有 9:30 / 13:00 桶**（与前端现状“`minute % 5 === 0` 含 9:30”不同，本次以后端口径为准）。

- 回测在“桶标签分钟”评估该桶（`minute ≤ 标签`）；因此后端**只在某个桶标签已闭合成新标签时**才触发飞书/打开信号。约定：
  - `currentClosedBucket(now)` = 当前时刻之前（含）**最大的合法标签**；9:35 前为 `null`（不触发）。
  - 每进入一个新的 `currentClosedBucket` 且诊断为命中 → 触发一次（每桶最多一次）。
- 新建 `server/src/service/buyPointBuckets.js` 提供 `getTradingBucketLabels()` / `getCurrentClosedBucket(date)`。**不改动 `fundSnapshot.js`**（该项目 5min 口径敏感，避免回归风险），新 helper 用与之一致的边界常量和注释交叉引用。

> 已知 quirk：`fundSnapshot` 中恰好落在 11:30 的点会被归入 15:00 桶。本方案只用到“标签集合”，不复制归属 quirk，不影响一致性。

---

## 二、后端改动

### 1) 新增 `server/src/wsServer.js`（WebSocket 服务）
- `WebSocketServer({ server, path: '/ws' })`，维护 `Set<socket>`；导出 `attach(httpServer)`、`broadcast(msg)`、`clientCount()`。
- 连接生命周期：`close/error` 清理；不做复杂握手（模式由 HTTP 同步）。

### 2) 新增 `server/src/service/strategyModeState.js`（全局模式）
- 读写 `server/src/data/strategy_mode.json`（`{ mode }`），`getMode()` / `setMode(mode)`，`normalize` 与前端一致（非 extreme 一律 `tech_attack`）。
- **复用**回测/线上既有常量 `MODE_EXTREME_WIN`（`server/src/service/hotMoneyExtremeWin.js` L44）。
- `clear.js` 不会清这个文件（`clear.js` 只清固定白名单，L28-48），可持久化。

### 3) `server/src/index.js`
- `const server = app.listen(port, cb)`（`app.listen` 返回 `http.Server`，可直接挂 WS）→ 回调内 `wsServer.attach(server)` 并 `buyPointPushService.start()`。
- 新增路由 `POST /set_strategy_mode { mode }` → `strategyModeState.setMode(mode)`。
- 注册 `SIGINT/SIGTERM` 优雅关闭（HTTP + WS）；`dev-with-clear.js` L87-93 已把 SIGINT 转发给子进程，Ctrl+C 会一并关闭。
- 把 `/send_feishu_card`（L1202-1298）里 `type==='buy_point'` 的卡片构建/发送逻辑**抽取**为共享函数（见下），路由本体保留（卖点仍在用）。

### 4) 新增 `server/src/service/buyPointNotifier.js`（飞书）
- 从 `index.js` 路由抽出买点卡片逻辑：`notifyBuyPointFeishu({ mode })`。保留现有两套口径（extreme → `getHotMoneyLeaderList` 的 `buyPointHit` 股 + 逆周期兜底；tech → `getTopGainersByMarket` 前三 + 候选），复用 `feishuNotify.buildHotMoneyLeaderCard / buildHotMoneyReverseLeaderCard / buildBuyPointCard / sendFeishuCard`。
- 路由 `/send_feishu_card` 改为调用它，行为不变。

### 5) 新增 `server/src/service/buyPointPushService.js`（调度核心）
- `setInterval(10s)`；每次 tick：
  1. **守卫**：`!isTradingHours(now)`（复用 `require('../utils')` 的 `isTradingHours/isMiddayBreak/isAfterMarketClose/isTradingDay`）→ 直接 return（非交易日、午休、收盘后不空跑）。加“上一 tick 未完成则跳过”的重入保护。
  2. **诊断**：与路由同源——
     `mode===MODE_EXTREME_WIN ? getExtremeWinBuyPointChecks(null, true) : getBuyPointChecks(null, true, false)`（`refresh:true` 让重度刷新自有 30s 节流兜底）。**注意**：此调用会写 `buy_point_hit_records.json`（红绿灯告警：这是有意的，见“四、影响”）。
  3. **广播**：`wsServer.broadcast({ type:'buy_point', mode, bucket: currentClosedBucket, ts, data, open:false })`。
  4. **桶门控命中**：`canonicalHit = data.allPassed===true || data.reverse?.allPassed===true || data.tailDipBuyingHit===true`；若 `currentClosedBucket != null` 且 `canonicalHit` 且 `lastNotifiedBucket !== currentClosedBucket` → 置 `lastNotifiedBucket` 并落盘 → `notifyBuyPointFeishu({ mode })`（try/catch 隔离，先落盘再发）→ **再**广播一次 `{...同一 data, open:true}`。
- 幂等状态落盘 `server/src/data/buy_point_notify_state.json`（`{ date, bucket, mode }`），重启同桶不重复发。
- 命中条件口径取三端并集（extreme 的 `reverse.allPassed`、MainFund 的 `tailDipBuyingHit`），前端各自再按本地条件过滤是否打开 UI。

### 6) `server/package.json`
- 依赖显式加入 `"ws": "^8.21.0"`（当前仅在 `node_modules` 传递存在，清装会坏）。

---

## 三、前端改动

### 1) 新增 `盯盘工具/src/utils/buyPointWs.js`（单例 WS 客户端）
- 模块级单例连接 `ws://${local_ip}:3000/ws`，`subscribe(listener) -> unsubscribe`；指数退避重连；`visibilitychange` 变可见时重连；解析消息后分发给订阅者。
- 导出 `syncStrategyMode(mode)`（POST `/set_strategy_mode`）。

### 2) `盯盘工具/src/utils/strategyMode.js`
- `setStrategyMode` 内额外调用 `syncStrategyMode(next)`；并暴露当前值供 App 启动时推送一次。

### 3) `盯盘工具/src/pages/OpeningBattle/index.jsx`
- **删除**：自动轮询调度 `useEffect`（L1143-1180）、`sendBuyPointFeishu`（L1095-1104）、`run()` 内的命中开弹窗与发飞书分支（L1119-1129）。`run()` 只保留“取数 → `setData` → `onResultChange(hit)`”。`handleRefresh`（手动刷新）保持**仅取数**。
- **新增**：`subscribeBuyPoint` 订阅——每收到 `data` 就 `setData(msg.data)` + `onResultChange(hit)`（卡片实时刷新）；当 `msg.open===true` 且 `(allPassed || reverse)` 且弹窗未打开时，用 `buyableRef.current` 设 `popupStocks` 并 `setPopupVisible(true)`（尾盘抄底不在本页弹，与现有 `filter(c=>c.id!=='tail_dip_buying')` 一致）。保留卡片与 Modal 渲染不动。

### 4) `盯盘工具/src/components/FloatingStockPosition/index.jsx`
- **删除**：`autoRunBuyPointDiagnosis`（L469-496）、轮询 `useEffect`（L498-550）、`lastAutoBuyPointOpenRef`（L97）中的买点部分、买点飞书调用（L487）。
- **新增**：`subscribeBuyPoint` 订阅——`msg.open===true` 且 `(allPassed || reverse.allPassed)` 且抽屉未打开 → `setBuyPointDrawerOpen(true)`。抽屉本身 `BuyPointDiagnosisDrawer`（L1081）打开时 `fetchChecks(false)` 独立取数保持不变。**卖点相关轮询/飞书一律不动。**

### 5) `盯盘工具/src/pages/MainFund/index.jsx`
- **删除**：`autoRunBuyPointDiagnosis`（L544-563）、轮询 `useEffect`（L565-581）、`lastAutoBuyPointOpenRef`（L552 用法）。
- **新增**：`subscribeBuyPoint` 订阅——`msg.open===true` 且 `(allPassed || tailDipBuyingHit)` 且 `document.visibilityState==='visible'` 且抽屉未开 → 开抽屉。

### 6) `盯盘工具/src/App.jsx`
- 挂载时推送一次当前模式（`syncStrategyMode(getStrategyMode())`）。`FloatingStockPosition` 挂载点（L1356）不变。

---

## 四、不变量与已知影响

- **卖点诊断/飞书**：代码路径完全不动（`FloatingStockPosition` 卖点轮询、`/send_feishu_card` 的 `sell_point` 分支、`buySellDiagnose` 卖点逻辑）。
- **买点命中记录（有意的副作用）**：`getBuyPointChecks` 在 `allPassed` 时会写 `buy_point_hit_records.json`，供“快进快出强卖豁免①”（`buySellDiagnose.js` L212-218）读取。改造后由后端 10s ticker 写（此前由前端每 5 分钟轮询写）。这**更接近**改造前“交易时段页面打开时每 5 分钟都有记录”的行为，避免因移除前端轮询导致记录骤减、豁免①口径漂移。
- **UI 双弹**：与现状一致——在开盘实战页，全局 `FloatingStockPosition` 与页面卡片仍会各自打开（抽屉 + 弹窗）。本方案不做路由仲裁，保持现有体验。
- 命中跨桶持续时，每桶仍会发一次飞书 + 一次打开信号（与改造前“滚动 5 分钟频控”等价）；前端在“已打开”时不重复开 UI。

---

## 五、验证

1. **WS 连通**：`server` 目录 `npm run dev`，控制台确认 WS 监听；用 `ws` 客户端连 `ws://localhost:3000/ws` 打印消息。
2. **10s 节奏与桶门控**：交易时段观察每 10s 一条 `type:'buy_point'`；`open:true` 在 5 分钟标签（9:35/9:40/…）处**每桶最多一次**。用 node 脚本直接调用 `getCurrentClosedBucket` 校验标签集合 = 上午 935..1130 / 下午 1305..1500。
3. **模式同步**：POST `/set_strategy_mode` 切换后，推送消息的 `data`/卡片口径随之切换；重启后模式仍生效（`strategy_mode.json`）。
4. **前端去轮询**：打开开盘实战页，Network 面板**无**周期 `/buy_point_checks`（仅挂载/手动刷新/开抽屉）；卡片仍随 WS 实时刷新；WS 断线（停后端）时前端自动重连。
5. **命中链路（端到端）**：制造/等待一次命中，确认：飞书由后端发出且**每桶仅一张**；OpeningBattle 弹窗、FloatingStockPosition 抽屉、MainFund 抽屉按各自条件打开；服务端重启同桶不重复发（`buy_point_notify_state.json`）。
6. **边界**：非交易日、午休（11:30-13:00）、15:05 后无推送；Ctrl+C 时 HTTP 与 WS 一并退出（确认端口 3000 释放）。

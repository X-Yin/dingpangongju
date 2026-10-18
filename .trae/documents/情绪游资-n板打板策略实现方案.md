# 情绪游资-n板打板 策略实现方案

## Context（背景与目标）

用户要求在买卖点回测页（[index.jsx](file:///Users/xieyin/Desktop/盯盘工具/盯盘工具/src/pages/backtest/index.jsx)，实际复用 `BacktestDrawer`）新增一个回测策略「**情绪游资-n板打板**」，n 取 **2、3**（两个独立策略 id）。规格：

- **买点**：当下上证指数 3 日线斜率为正；**若前一交易日收盘口径斜率已经为正，则今天至少要等到 9:40 才买**（前一日为负、今日盘中转正则可从转正桶起买）。
- **选股**：上个交易日（T-1）中的 **n-1 板**个股，在**今天盘中分时冲高到 8%** 的那一分钟买入（先冲到 8% 的先买）。
- **卖点**：与「情绪游资-极致胜率」的**顺周期腿**完全一致。
- 用户已确认的设计决策：**半仓单持仓**；**先冲到 8% 的先买**；**排除创业板(30/301)与科创板(688)**，**买入时段仅限早盘 9:30–11:30**。

现有「情绪游资-极致胜率」「情绪游资-反向抱团龙头」均为**独立引擎**实现（不复用标准/重点板块引擎），本次沿用同一模式新增 `nBoardMode` 独立引擎。

## 关键结论（已核实）

- 策略注册：`strategies/families/*.js` 导出对象 → [registry.js](file:///Users/xieyin/Desktop/盯盘工具/server/src/service/buySellBacktest/strategies/registry.js) 用 spread 合并为 `STRATEGIES`，在 family 文件加条目即自动注册。
- 路由：单策略 [rangeBacktest.js](file:///Users/xieyin/Desktop/盯盘工具/server/src/service/buySellBacktest/engine/rangeBacktest.js#L26-L37) 按标志位分流；**worker（`script/backtest-worker.js`）始终走 [rangeBacktestMulti.js](file:///Users/xieyin/Desktop/盯盘工具/server/src/service/buySellBacktest/engine/rangeBacktestMulti.js#L27-L41)**，其分流目前只覆盖 `keyBlockDays`/`reverseLeaderMode`（`extremeWinMode` 未单独分流，落在 `regularIds`）。→ **两处都必须补 `nBoardMode` 路由**，否则「回测全部/趋势/月度」会跑错引擎。
- 独立引擎样板：[reverseLeaderBacktest.js](file:///Users/xieyin/Desktop/盯盘工具/server/src/service/buySellBacktest/engine/reverseLeaderBacktest.js)（日期轴、`loadTrainingCampData`、`clearTlineCache`、`scanLeaderPriceSell`、结果组装 `{type:'single', ...}`、`attachBuyDayReturn`）。
- 卖点基准（顺周期腿）：[extremeWinBacktest.js](file:///Users/xieyin/Desktop/盯盘工具/server/src/service/buySellBacktest/engine/extremeWinBacktest.js#L492-L538) —— `scanLeaderPriceSell({ costLinePct:-5, costLineSustainMinutes:0 })`（**含**单分钟跳水卖点）∪ 持仓第3日尾盘未拉开 +10%（`WEAK_TRADE_HOLD_DAYS=3/TAIL_MINUTE=1457`）∪ 收盘抗分歧 < 6（`RESILIENCE_SELL_MAX=6`，指数 `sh000001`）。
- 上证斜率：[indexGate.js](file:///Users/xieyin/Desktop/盯盘工具/server/src/service/buySellBacktest/engine/indexGate.js) 的 `ICE_SIGNAL_INDEX_CODE='sh000001'`、`getIceMa3SlopeIntraday(dateStr, minute)`、`ensureIndexMa3SlopeSeries(code)`、`fmtKeyBlockSlope`。
- 分时加载/打分辅助：`engine/extremeWinScores.js` 导出 `loadTlinePoints(code, dateNum)`（返回 `{preclose, points:[{minute,lastPx,change,...}]}`）、`clearTlineCache()`、`round2`。
- 半仓账户口径：[twoBuy.js](file:///Users/xieyin/Desktop/盯盘工具/server/src/service/buySellBacktest/engine/twoBuy.js) 的 `computeTwoBuyAccountReturn(legs)`（区间合并：轮内相加、跨轮复利）+ `TWO_BUY_LEG_WEIGHT=0.5`。
- 选池数据：[keyBlockData.js](file:///Users/xieyin/Desktop/盯盘工具/server/src/service/keyBlockData.js#L275-L290) `getRecentMultiLianbanStocks(dateStr, lookbackDays, minBoardCount)`（**已**由 [deps.js](file:///Users/xieyin/Desktop/盯盘工具/server/src/service/buySellBacktest/deps.js) 导出 `getRecentMultiLianbanStocks`、`getPastTradingDates`）；`getMultiLianbanStocks` **未导出**。
  - 取「上个交易日 n-1 板」：调用 `getRecentMultiLianbanStocks(dateStr /* 当日 T */, 1, n-1)` → 其内部 `getPastTradingDates(T,1)` 得到 `[T-1]`，返回 T-1 当日 `lianbanCount >= n-1` 的个股；**再过滤 `lianbanCount === n-1`** 得到精确的 n-1 板（n=2→首板；n=3→二板）。无需改动 keyBlockData.js 导出。

## 改动清单

### 1. 新增独立引擎 `server/src/service/buySellBacktest/engine/nBoardBacktest.js`

参照 `reverseLeaderBacktest.js` 骨架，导出 `runNBoardBacktest(startDate, endDate, strategyId, onProgress)`。

- 从 `STRATEGIES[strategyId]` 取 `nBoardN`（2/3），校验 `strategy.nBoardMode === true`，否则返回 `{success:false}`。
- 日期轴：`Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]))` 过滤 `[start,end]` 升序（同反向抱团龙头引擎，不依赖资金快照）。
- 启动时 `ensureIndexMa3SlopeSeries('sh000001')` 预热斜率序列。
- 每交易日：
  1. `loadTrainingCampData(dateStr, {allowMissingFund:true})` → `timeBuckets`；`dateNum`；`hasTailBucket = timeBuckets.some(b => Number(b.minute) >= 1457)`。
  2. **候选池（日级，一次）**：`getRecentMultiLianbanStocks(dateStr, 1, nBoardN - 1)` → `stocks.filter(s => s.lianbanCount === nBoardN - 1)` → 剔除创业板/科创板（`/^(sz30|sh688)/`）与 `EXCLUDED_CODES`。记录进 `seenStocks`。
  3. `prevCloseSlope`：本地 helper（同 reverseLeader 的 `getPrevCloseSlope`）——用 `ensureIndexMa3SlopeSeries` 取**严格早于当日**的最后一个交易日收盘口径斜率。
  4. `clearTlineCache()`；隔夜持仓分时 `loadTlinePoints(position.code, dateNum)`（仅 `dateStr > position.buyDate`）。
  5. 逐桶（`bucketMinute = Number(bucket.minute)`）：
     - **卖出**（隔夜持仓，`dateStr > buyDate`）：`priceAtMinute(points, bucketMinute)` → `scanLeaderPriceSell({points, preclose, buyPrice, cutoffMinute: bucketMinute, costLinePct:-5, costLineSustainMinutes:0})`；再判 ④ 第3日尾盘(≥1457)收益 < +10%；再判 ⑥ 尾盘收盘抗分歧 < 6（懒计算：`getSingleStockTlineDataByDate(code,dateNum)` + 同接口取 `sh000001` 分钟线 → `calculateReplayResilience(stockLine, indexLine, code)`，<5 点则不触发）。命中即生成 trade（`weight:0.5, returnRate: round2(raw*0.5), rawReturnRate: raw`）、清空持仓、`soldThisDate = true`。
     - **买入**（`position === null && !soldThisDate`）：门禁 ① 时段 `930 <= bucketMinute <= 1130`；② `getIceMa3SlopeIntraday(dateStr, bucketMinute) > 0`；③ 若 `prevCloseSlope > 0` 则 `bucketMinute >= 940`。通过后遍历候选池：对每只取 `loadTlinePoints(code, dateNum)`，在 `points` 中找**首个** `minute >= 930 && minute <= bucketMinute` 且 `(lastPx - preclose)/preclose*100 >= 8` 的分钟（记为 `first8`）；取所有候选中 `first8` **最早**的一只（并列取涨幅更高者）买入，价格取该分钟 `lastPx`、时间取该分钟。命中后写入 position（含 `buyReason`/`buyChecks` 明细、`buyDi = di`、`weight:0.5`）。
     - 候选分时数据用懒加载 Map 缓存（`batchParallel` 批量预拉当日候选分时，参照 reverseLeader 的 `ensurePoolData`）。
- 收益/结果组装（**半仓口径**）：
  - `overallReturn = computeTwoBuyAccountReturn([...trades, ...holdingLeg])`，每条 leg `returnRate = rawReturnRate * 0.5`（单持仓不重叠，退化为逐笔 `(1+0.5·raw)` 复利）。
  - 期末持仓用 `getStockCloseOnOrBefore(code, 最后一日)` 估浮盈。
  - 返回 `{success:true, type:'single', strategy:{id,name,desc}, range, skippedDates, seenStocks, trades, currentHolding, summary:{tradeCount, winCount, winRate, ...calcDrawdownStats(validTrades), overallReturn, holding}}`，并 `attachBuyDayReturn(trades/holding)`。
- 复用：`batchParallel`、`getSingleStockTlineDataByDate`、`getStockCloseOnOrBefore`、`getTrainingCampDates`、`loadTrainingCampData`、`getRecentMultiLianbanStocks`（均来自 `../deps`）；`getTechIndexDates`（`../utils/techEmotion`）；`calculateReplayResilience`（`../diagnose/sellPoint`）；`scanLeaderPriceSell`（`./leaderSellMinute`）；`loadTlinePoints/clearTlineCache/round2`（`./extremeWinScores`）；`calcDrawdownStats/attachBuyDayReturn`（`../utils/tradeStats`）；`EXCLUDED_CODES`（`../constants`）；`fmtTime`（`../diagnose/buyPoint`）。

### 2. 注册策略 + 描述 `strategies/families/leader.js` / `strategies/descs.js`

- `descs.js` 新增并导出 `N_BOARD_ATTACK_DESC(n)`（长描述，口径同实现：T-1 的 n-1 板池、上证斜率门禁 9:40 规则、8% 触发、排除 30/301/688、9:30–11:30、半仓、顺周期腿卖点）。
- `leader.js` 新增两条：
  ```js
  hot_money_2board_attack: { id:'hot_money_2board_attack', name:'情绪游资-2板打板', desc: N_BOARD_ATTACK_DESC(2), nBoardMode:true, nBoardN:2 },
  hot_money_3board_attack: { id:'hot_money_3board_attack', name:'情绪游资-3板打板', desc: N_BOARD_ATTACK_DESC(3), nBoardMode:true, nBoardN:3 },
  ```

### 3. 路由 `engine/rangeBacktest.js` + `engine/rangeBacktestMulti.js`

- `rangeBacktest.js`：在 `reverseLeaderMode` 分支后追加
  `if (STRATEGIES[strategyId]?.nBoardMode === true) return runNBoardBacktest(...)`；顶部 require。
- `rangeBacktestMulti.js`：新增 `const nBoardIds = ids.filter(id => STRATEGIES[id]?.nBoardMode === true);`，并在 `regularIds` 过滤条件中加入 `&& STRATEGIES[id]?.nBoardMode !== true`（避免误入标准循环），新增 `for (const strategyId of nBoardIds) results.push({ strategyId, result: await runNBoardBacktest(...) })`；顶部 require。

### 4. registry 排除 `strategies/registry.js`（避免 desc 污染）

`isCycleFilterStrategy` 与 `isCrashSellStrategy` 各加 `&& s.nBoardMode !== true`，使新策略不被追加「顺周期过滤 / 盘中大跌强卖」desc、不置 `crashSell`（本引擎自带卖点，不需要）。

### 5. 前端 `盯盘工具/src/pages/trainingCamp/components/BacktestDrawer/index.jsx`

- `STRATEGY_OPTIONS`：在 `hot_money_reverse_leader` 后加两条 `{ value:'hot_money_2board_attack', label:'情绪游资-2板打板' }`、`{ value:'hot_money_3board_attack', label:'情绪游资-3板打板' }`。
- `STRATEGY_CATEGORIES` 的 `ice_hot_money.ids`：追加两个 id。
- 新增：`N_BOARD_ATTACK_STRATEGY_IDS` / `isNBoardAttackStrategy(id)`；`nBoardAttackBuyRules`（斜率门禁+9:40、T-1 的 n-1 板池、8% 触发、排除 30/301/688、9:30–11:30、半仓）；`nBoardAttackSellRules`（= `LEADER_SELL_RULES`，其中 `leader_sell_stop_loss` 文案改为 **-5% 即时、不设 5 分钟**）。
- `STRATEGY_SPECIFIC_NOTES`：新增 `nBoardAttackNote(n)`，并挂到两个 id。
- 三处分支同步：
  - `curIsNBoard = isNBoardAttackStrategy(strategy)`（~L941-944）。
  - `handleCopy` 规则文本（~L1312-1313）与规则 tab（~L2109-2114）：`buyRules = curIsNBoard ? nBoardAttackBuyRules : (...)`、`sellRules = curIsNBoard ? nBoardAttackSellRules : (...)`。

## 验证

1. 语法检查：`node -e "require('./src/service/buySellBacktest')"`（在 `server/` 下，确认模块加载无循环/语法错误）；前端 `npx eslint` 或构建通过。
2. 单策略回测：`cd server && node script/backtest-worker.js --strategies hot_money_2board_attack --start <YYYYMMDD> --end <YYYYMMDD> --prebuild`，核对：买点均在 9:30–11:30、斜率 > 0、(前一日斜率为正时) 买点时间 ≥ 09:40、买入价为该股当日首次触及 +8% 的分钟价、候选均为 T-1 的 n-1 板且非 30/301/688；卖点为顺周期腿口径；`weight=0.5`、`overallReturn` 按半仓复利。
3. 走通路由：`node script/backtest-worker.js --list` 确认两策略在列；对含新策略的分组跑一次确认 `runNBoardBacktest` 被调用（打印内部日志/结果 `summary.tradeCount` 合理）。
4. 前端：打开 `/backtest` 页，下拉可见两项、分类 Tag「情绪游资类」含两项、规则 tab 与「复制规则」显示新规则、跑一次后报告卡片正常渲染。

## 备注 / 待确认

- **已发现的既有问题（本次不处理，除非用户要求）**：`rangeBacktestMulti.js` 未对 `extremeWinMode` 分流，「情绪游资-极致胜率」经 worker（回测全部/趋势/月度）会落入 `regularIds` 走标准循环；单策略路径正常。新增 `nBoardMode` 时会在 multi 中一并补上，但不改动 extremeWin 的既有行为（超出本次范围）。

# 情绪游资-连板 N 日涨幅最大 策略实现方案

## Context

用户要求在回测系统中新增「情绪游资-连板 n 日涨幅最大」策略，n 取 2 / 3 / 5（三条独立策略）。
入口参考 `/Users/xieyin/Desktop/盯盘工具/盯盘工具/src/pages/backtest/index.jsx`（该页仅内嵌 `BacktestDrawer`）。

规格（已与用户确认）：

- **买点**：当日 5min 内大盘主力资金净流入 **> 20 亿**（口径与「N 日涨幅最大」策略完全一致 → 直接复用 `buildFundInflowCheck`）。
- **选股**：从 **严格早于回测日 D** 的最近 **10 个 lianbanSnapshot 快照日** 聚合出 **3 条主线**（逻辑同 `themeMonitor.js` 的 `buildThemeAnalysis`），把 3 条主线内**所有股票**取出、去重；**剔除创业板（30/301）与科创板（688）**[用户确认]；再取其中 **n 个交易日（不含 D）累计涨幅最大**的一只；若该只**当时已涨停**（买不进）则**顺延**到涨幅排名的下一只。
- **卖点**：完全沿用「情绪游资-极致胜率」顺周期腿口径（与 `nBoardBacktest.js` 中一致）。
- **仓位**：半仓单持仓（权重 0.5，收益按半仓折算后逐笔复利）[用户确认]。
- **买入时段**：**9:30–13:30**[用户确认]（全局 `BUY_TIME_MAX_MINUTE = 1330`）。

实现方式：克隆 `nBoardBacktest.js` 的独立引擎骨架，新增模式标志 `lianbanGainMode` + `lianbanGainN`，并按既有模式（nBoardMode）接入路由、注册表、前端抽屉。

## 复用的现成能力

| 能力 | 位置 |
| --- | --- |
| 资金买点 `buildFundInflowCheck(buckets, idx)` → `.check.passed`（`fundDiff > 20`） | `server/src/service/buySellBacktest/diagnose/buyPoint.js` L47 |
| 快照读取 `getLianbanDayData` / `getAvailableLianbanDates`（降序） | `server/src/service/lianban.js` L513 / L523 |
| 主线打分（`boardKeyOf` + `0.85^decay` + `lianbanBonus` + `leaderCodes*1.5` + top3 主线） | `server/src/service/themeMonitor.js` `buildThemeAnalysis` L133-L307（移植为「按 D 截断」版本） |
| n 日累计涨幅 `stockWindowGain(code, winDates)`；`getPastTradingDates(D, n)`；`ensureBarsForCodes(set)` | `server/src/service/buySellBacktest/deps.js`（re-export 自 `keyBlockData.js`） |
| 涨停判定 `isLimitUpAtBuy(code, changePct)`（主板 >9.5%、创业/科创 >19%） | `server/src/service/buySellBacktest/engine/replayData.js` |
| 顺周期腿卖点 `scanLeaderPriceSell` + `calculateReplayResilience` | `engine/leaderSellMinute.js` / `diagnose/sellPoint.js`（`nBoardBacktest.js` L255-L281 已完整接线） |
| 半仓账户口径 `TWO_BUY_LEG_WEIGHT` / `computeTwoBuyAccountReturn` | `engine/twoBuy.js` |
| 全局排除股 `EXCLUDED_CODES` | `engine/constants.js` |
| 报告汇总 | `server/src/service/backtestReport.js` 由 `STRATEGIES` 驱动，无需单独登记 |

## 实现步骤

### 1) 新建后端独立引擎 `server/src/service/buySellBacktest/engine/lianbanGainBacktest.js`

导出 `runLianbanGainBacktest(startDate, endDate, strategyId, onProgress)`；以 `nBoardBacktest.js` 为骨架克隆。
入口校验 `strategy.lianbanGainMode !== true` / 读取 `lianbanGainN`（须 ≥ 2）。

常量：`BUY_TIME_MIN_MINUTE = 930`、`BUY_TIME_MAX_MINUTE = 1330`（与 `registry.js` 同值）、
`WEAK_TRADE_HOLD_DAYS = 3`、`WEAK_TRADE_MIN_GAIN_PCT = 10`、`TAIL_MINUTE = 1457`、
`RESILIENCE_SELL_MAX = 6`、`LEADER_RESILIENCE_INDEX_CODE = 'sh000001'`。

日期序列与 nBoard 同口径：`Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]))`，
每日 `loadTrainingCampData(dateStr, { allowMissingFund: true })`，循环 `timeBuckets`，`clearTlineCache()` 每日重建。

**新增内部函数 `buildMainLinesBefore(dateStr)`**（移植 `themeMonitor.buildThemeAnalysis`，改为「严格早于 D」）：
- `dates = getAvailableLianbanDates().filter(d => Number(d) < Number(D)).slice(0, 10).reverse()`（升序；不足 10 日取全部）。
- 按 `boardKeyOf(theme.board)` 聚合，排除 `'其他'`；`dailyCounts[ymd] += theme.stocks.length`；
  `lianbanBonus += Σ max(0, lianbanCount-1)*0.6*Math.pow(0.85, totalDays-1-idx)`；
  `score = Σ dailyCounts[idx]*0.85^(totalDays-1-idx) + lianbanBonus + leaderCodes.size*1.5`。
- 按 score 降序取前 3（`idx < 3` → 主线），合并其 `theme.stocks[]` 的 `marketCode || code`（已实测快照中 `marketCode` 形如 `sh603197`），去重。
- 结果按日缓存（`Map<dateStr, code[]>`），避免每日重复计算。

**候选池过滤**：剔除 `EXCLUDED_CODES`；剔除 `/^(sz30|sh688)/i`（创业板/科创）；剔除名称含 `ST`。

**选股排序（每日一次）**：`ensureBarsForCodes(candidateCodes)` → `winDates = await getPastTradingDates(D, n)` →
每只 `stockWindowGain(code, winDates)`（缺失即 null，排最后）→ 按涨幅**降序**。

**买点（逐桶）**：`!position && !soldThisDate && minute ∈ [930, 1330]` 时：
- `const { check } = buildFundInflowCheck(timeBuckets, bi);` 若 `check.passed` 为真：
- 按涨幅降序遍历候选，对该桶 `atPt = priceAtMinute(points, bucketMinute)`（`loadTlinePoints` 懒加载全部候选分时），
  当桶涨幅 `chg = (atPt.lastPx - preclose)/preclose*100`；`isLimitUpAtBuy(code, chg)` 为真 → **顺延下一只**；
  否则按 `atPt.lastPx` 买入该只（半仓）。全部不可买则本桶不买、后续桶重试。
- 买入只做一次：`!soldThisDate` 且买入后当日至多一笔。

**卖点**：完全复用 `nBoardBacktest.js` 的隔夜持仓卖出块（`scanLeaderPriceSell` costLinePct `-5`/sustain 0、
第 3 日尾盘 < +10%、尾盘抗分歧 < 6），仅把 `sellReason` 尾缀改为 `情绪游资-连板${n}日涨幅最大（半仓）卖出`。

**结果组装**：与 nBoard 相同 —— `type: 'single'`、`weight: TWO_BUY_LEG_WEIGHT`、
`returnRate = rawReturnRate * 0.5`、`computeTwoBuyAccountReturn`、`attachBuyDayReturn`、`calcDrawdownStats`。
`buildPosition` 内 `buyReason`/`buyChecks` 记录：资金条件命中（含 5min 净流入差额）、3 条主线选股来源、
n 日涨幅排名、涨停顺延说明、半仓仓位。

### 2) `strategies/families/leader.js` — 注册 3 条策略

在 nBoard 两条之后追加（`desc: LIANBAN_GAIN_DESC(n)`）：

```js
hot_money_lianban_2d_gain: { id, name: '情绪游资-连板2日涨幅最大', desc: LIANBAN_GAIN_DESC(2), lianbanGainMode: true, lianbanGainN: 2 },
hot_money_lianban_3d_gain: { ... n=3 },
hot_money_lianban_5d_gain: { ... n=5 },
```

并在文件首行 require 中加入 `LIANBAN_GAIN_DESC`。

### 3) `strategies/descs.js` — 新增 `LIANBAN_GAIN_DESC(n)`

仿 `N_BOARD_ATTACK_DESC` 结构，描述买点（5min 资金净流入 > 20 亿）、选股（早于 D 的最近 10 快照日 → 3 条主线 →
全部成分股去重 → 剔除创业板/科创板 → n 日累计涨幅最大 → 涨停顺延）、卖点（顺周期腿）、仓位（半仓单持仓）、时段（9:30–13:30）。
加入 `module.exports`。

### 4) `strategies/registry.js` — 排除项

`isCycleFilterStrategy`（L37）与 `isCrashSellStrategy`（L69）末尾各追加 `&& s.lianbanGainMode !== true`。

### 5) 路由 `engine/rangeBacktest.js` + `engine/rangeBacktestMulti.js`

- `rangeBacktest.js`：新增 require `runLianbanGainBacktest`，在 nBoardMode 分支（L41-43）之后插入
  `if (STRATEGIES[strategyId]?.lianbanGainMode === true) return runLianbanGainBacktest(...)`。
- `rangeBacktestMulti.js`：新增 require + `const lianbanGainIds = ids.filter(id => STRATEGIES[id]?.lianbanGainMode === true);`，
  `regularIds` 过滤追加 `&& STRATEGIES[id]?.lianbanGainMode !== true`，并在 nBoardIds 循环后追加同款 for 循环调用新引擎。

### 6) 前端 `盯盘工具/src/pages/trainingCamp/components/BacktestDrawer/index.jsx`

- `STRATEGY_OPTIONS`（L174 后）：追加 3 项 `{ value: 'hot_money_lianban_{n}d_gain', label: '情绪游资-连板{n}日涨幅最大' }`。
- `STRATEGY_CATEGORIES` 的 `'ice_hot_money'`（L203-L210）：`ids` 追加 3 个新 id。
- 仿 `N_BOARD_ATTACK_STRATEGY_IDS`（L386-L409）新增：
  `LIANBAN_GAIN_STRATEGY_IDS`、`isLianbanGainStrategy(id)`、`lianbanGainN(id)`、
  `lianbanGainBuyRules(n)`、`lianbanGainSellRules`（= `nBoardAttackSellRules`，卖点相同）、`lianbanGainNote(n)`。
- `STRATEGY_SPECIFIC_NOTES`（L763 后）：`hot_money_lianban_2d_gain: lianbanGainNote(2)` 等 3 项。
- 两处规则选择三元表达式（L1356-1357 与 L2180-2181）：最外层加 `isLianbanGain ? lianbanGainBuyRules(lianbanGainN(strategy)) : (...)` 分支；
  并在 L988 附近加 `const curIsLianbanGain = isLianbanGainStrategy(strategy);`。

### 7) 前端 `BacktestReportModal/index.jsx` — 半仓文案

`halfReasonOf`（L150-L155）条件追加 `|| strategy.lianbanGainMode === true`，半仓说明文案与 n 板打板同款。

## 验证

1. 语法校验：`node --check` 逐个改动的后端文件（新建引擎 + leader.js + descs.js + registry.js + 2 个 rangeBacktest）。
2. 短区间回测：以 node 直接调用 `runRangeBacktestInner('20260901','20261016','hot_money_lianban_2d_gain')`（或经 `/training_camp/backtest` 接口），
   确认：`success: true`、`type: 'single'`、`trades` 每笔 `weight: 0.5` 且 `buyChecks` 含资金/主线/n日涨幅项、
   `sellReason` 为顺周期腿三类之一；`hot_money_lianban_3d_gain` / `_5d_gain` 同法各跑一次。
3. 前端：确认 `BacktestDrawer` 下拉出现 3 条新策略、分类「情绪游资类」含新策略、规则弹窗显示新规则文案，且 JSX 无语法错误（构建通过）。
4. 如需完整报告缓存：重跑 `server/script/backtest-worker.js` 生成含新策略的回测报告。

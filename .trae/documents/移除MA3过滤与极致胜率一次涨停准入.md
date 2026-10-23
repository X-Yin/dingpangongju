# 移除 MA3 正斜率过滤 + 极致胜率候选池改「一次涨停」准入

## Context

用户提出两项规则调整：

1. **删除买点过滤中的「个股 MA3 切线正斜率连续天数 > 4」条件**（回测 + 线上实盘）。该条件仅在跟踪指数「今日盘中由负转正」当日生效，用于避免刚转正时追已抢先连涨 5 天以上的个股。
2. **「情绪游资-极致胜率」大市值候选准入放宽**：流通市值 > 100 亿元的个股，由「出现过两连板 + 含这两连板在内连续 5 个交易日累计涨幅 > 40%」改为「**出现过一次涨停（首板即可）** + 含该涨停日在内连续 5 个交易日累计涨幅 > 40%」。小市值（≤ 100 亿元或市值缺失）仍保持「四连板及以上」不变。回测与线上共用同一候选池实现，改一处双端生效。

预期结果：回测交易序列变化（缓存需失效重建），线上诊断/龙头列表同步新口径；线上服务需重启生效。

## 一、删除 MA3 正斜率 > 4 天过滤

### 回测侧

- [pickBest.js](file:///Users/xieyin/Desktop/盯盘工具/server/src/service/buySellBacktest/engine/pickBest.js)
  - 第 2 行 import 去掉 `countStockPositiveSlopeDays`。
  - 删除第 231 行 `stockSlopeSkipped` 声明、第 233–238 行 `shouldCheckStockSlope` 定义、第 314–326 行过滤块。
  - 第 330、348 行返回值删除 `stockSlopeSkipped` 字段（全仓库无其它消费方，已确认）。
  - 函数签名中的 `turnedPosInfo` 形参保留（各引擎调用点均传该参数，不做跨文件签名改造）。
- [pickHelpers.js](file:///Users/xieyin/Desktop/盯盘工具/server/src/service/buySellBacktest/engine/pickHelpers.js)：删除第 89–117 行 `countStockPositiveSlopeDays` 及第 121 行导出。
- [indexGate.js](file:///Users/xieyin/Desktop/盯盘工具/server/src/service/buySellBacktest/engine/indexGate.js)：第 500–502 行注释改为「指数今日盘中是否由负转正的状态透传（供选股层/明细展示）」，`gateTurnedPosInfo` 字段与各引擎传参保留（删除将波及 rangeBacktest / rangeBacktestMulti / fusedEmoWinBacktest 等 10+ 调用点，超出本次范围）。

### 线上实盘侧（buySellDiagnose.js）

- 删除第 2812–2830 行 `countStockPositiveSlopeDaysLocal`。
- `getBuyPointStocks`：删除第 3067–3071 行第 ④ 步过滤；第 2832–2834、3047–3048 行注释同步去掉 ④ 描述。
- `getTopGainersByMarket`（约 3391–3412 行）：
  - 删除 `slopeOk` 计算；
  - `matchesBuyPoint = indexGatePassed && resilienceOk && !valuationReason`；
  - 删除 `else if (!slopeOk) excludeReason = 'MA3正斜率>4天'` 分支，并更新第 3404 行排除优先级注释。
- `getBuyPointChecks`：删除第 3648–3685 行 `stock_ma3_slope_duration` 检查块（含 `shouldCheckStockSlope`、内联天数计算、`allPassed` 影响）。
- [index.js](file:///Users/xieyin/Desktop/盯盘工具/server/src/index.js) 第 1179 行注释去掉「个股 MA3 斜率 ≤ 4」。

## 二、极致胜率候选池改为「一次涨停」准入

### 共用候选池 extremeWinPool.js

- 常量区（第 26–38 行）：
  - `BASE_MIN_BOARD_COUNT = 2` **保留**（`extremeWinBacktest.js:232`、`fusedEmoWinBacktest.js:181` 的预拉仍用它）。
  - 新增 `LARGE_CAP_MIN_BOARD_COUNT = 1`，并加入 `module.exports`。
  - 更新第 33–38 行注释为「大市值：出现过一次涨停 + 含该涨停日连续 5 日累计涨幅 > 40%」。
- `largeCapBoardPass`（第 267–277 行）：
  - `idx < 0` 返回 false（不再要求前一交易日）；
  - 窗口枚举改为 `start = idx-(CAP_BOARD_WINDOW_DAYS-1)` 到 `start <= idx`。
  - 函数注释（第 253–256 行）同步。
- `buildExtremeWinPool`（第 295–345 行）：
  - 第 307–308 行两处 `getRecentMultiLianbanOccurrences(..., BASE_MIN_BOARD_COUNT)` 改为 `LARGE_CAP_MIN_BOARD_COUNT`（使首板进入 raw；该函数的 `getMultiLianbanStocks(date, minBoardCount=1)` 会返回 `lianbanCount === 1` 的涨停股，已确认）。
  - `needsBarCheck`（第 331 行）与 `boardPass` 大市值分支（第 343 行）改为 `lb >= LARGE_CAP_MIN_BOARD_COUNT`；小市值分支保持 `MIN_BOARD_COUNT`（四连板）。
  - 第 279–285、298–303、333 行注释同步。
  - `poolFilterText`（第 420 行）「出现过两连板且含这两连板在内…」改为「出现过一次涨停且含该涨停日在内…」。
- [keyBlockData.js](file:///Users/xieyin/Desktop/盯盘工具/server/src/service/keyBlockData.js) 第 295–296 行注释去掉「两连板」限定，改为通用「连板/涨停事件」描述（无功能改动）。

### 文案同步（回测 + 线上 + 前端）

统一替换口径：**「流通市值 > 100 亿元者出现过一次涨停且含该涨停日在内的连续 5 个交易日累计涨幅 > 40%；≤ 100 亿元者仍需四连板及以上」**。

- [hotMoneyExtremeWin.js](file:///Users/xieyin/Desktop/盯盘工具/server/src/service/hotMoneyExtremeWin.js) 第 81–82 行注释、第 596 行 `extreme_win_pool` 的 `title`、第 599 行 `reason`。
- [extremeWinBacktest.js](file:///Users/xieyin/Desktop/盯盘工具/server/src/service/buySellBacktest/engine/extremeWinBacktest.js) 第 72 行注释、第 722 行附近买点明细文案。
- [descs.js](file:///Users/xieyin/Desktop/盯盘工具/server/src/service/buySellBacktest/strategies/descs.js) 第 84、86、91–93、138 行。
- [leader.js](file:///Users/xieyin/Desktop/盯盘工具/server/src/service/buySellBacktest/strategies/families/leader.js) 第 5 行注释。
- 前端文案：「两连板 + 含两连板 5 日涨幅 > 40%」→「一次涨停 + 含该涨停日 5 日涨幅 > 40%」：
  - [FloatingBuyPointDiagnosis/index.jsx](file:///Users/xieyin/Desktop/盯盘工具/盯盘工具/src/components/FloatingBuyPointDiagnosis/index.jsx) 第 461 行；
  - [OpeningBattle/index.jsx](file:///Users/xieyin/Desktop/盯盘工具/盯盘工具/src/pages/OpeningBattle/index.jsx) 第 862 行；
  - [BacktestDrawer/index.jsx](file:///Users/xieyin/Desktop/盯盘工具/盯盘工具/src/pages/trainingCamp/components/BacktestDrawer/index.jsx) 第 179、344、378 行。
  - 注意：`hot_money_2board_attack` / `hot_money_3board_attack`（n 板打板）语境中的「首板/二板」不改。

## 三、回测缓存版本号自增（paths.js）

按现有「v+1（2026-10-23）」注释风格，新增一行说明「移除个股 MA3 正斜率 > 4 天过滤；极致胜率大市值候选改为一次涨停准入」，并自增：

| 策略 | 现版本 → 新版本 |
| --- | --- |
| `hot_money_extreme_win` | 33 → 34 |
| `sci_attack_emo_win` | 15 → 16 |
| `highest_{2,3,4,5,2.5,3.5}d_gain_emoquick`（6 个）、`highest_3d_reports_top5_gain_emoquick` | 15 → 16 |
| `highest_3d_gain_emoquick_emo10/emo20/emo30/g10` | 12 → 13 |
| `highest_{2,3,4,5,10,2.5,3.5}d_gain`（7 个） | 7 → 8 |
| `highest_{2,3,4,5,2.5,3.5}d_gain_two_buy`（6 个） | 7 → 8 |
| `highest_3d_gain_two_buy_same_day` | 5 → 6 |
| `highest_{2,3,4,5}d_gain_two_buy_diff_block`（4 个） | 6 → 7 |
| `highest_gain`、`highest_3d_reports`、`highest_5d_reports`、`highest_3d_reports_top5_gain`、`highest_5d_reports_top5_gain` | 2 → 3 |

`hot_money_ice_*`、`hot_money_reverse_leader`、`hot_money_2/3board_attack`、`hot_money_volume_share_*` 不经 `pickBestStock`，版本不动。

## 四、验证

1. `node --check` 全部改动的 server 文件；前端改动跑 ESLint。
2. 写一次性验证脚本（不落盘到交付目录）调用 `buildExtremeWinPool('20261022')`：
   - 确认返回 stocks 非空、`poolFilterText` 为新口径；
   - 抽查一只「流通市值 > 100 亿且仅首板」的个股能进入候选池（对照 `lianbanSnapshot` 快照）。
3. 重跑回测：`hot_money_extreme_win` 与一个 `highest_3d_gain_emoquick`（如 20260728–20261023），确认缓存版本不匹配触发重算、交易序列按新规则变化，且无异常。
4. 线上：重启后端（3000 端口需结束旧进程），验证 `/api/buy_point_stocks?filterGate=true` 不再出现 `MA3正斜率>4天` 排除原因，开盘实战页龙头池文案为新口径。

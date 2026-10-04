# 买卖点回测独立成菜单页 + 策略分类 Tag 回测

## Context（背景与目标）

「买卖点回测」目前是训练营 `TopBar` 里的一个按钮，点击后以 `<Drawer>` 打开，与训练营耦合（入口、`dates`、代码目录都挂在 `pages/trainingCamp/` 下）。

本次要做两件事：

1. **解耦**：把买卖点回测提升为 App 侧边菜单的一个独立菜单项 + 独立路由页面，训练营 `TopBar` 里的入口与 `BacktestDrawer` 挂载点删除（已与用户确认：完全迁移，不留训练营入口）。
2. **策略分类 Tag**：在「回测全部」按钮旁增加一排分类 Tag（覆盖全部 46 个策略）。点击某个 Tag → **只回测该分类下的策略**，且下方策略下拉框**自动选中该分类在 `STRATEGY_OPTIONS` 中出现的第一个策略**。

## 已核实的关键结论

- **`--strategies` 路径不清缓存**：`clearBacktestCache()` 全仓库只有一处调用（`backtest-worker.js` L645 默认全量分支）；`--strategies` 分支（L621-641）在其之前 `return`，不会执行。该路径只调用 `runStandalone → runStrategies → runRangeBacktestMulti` 并 `writeCachedBacktest`，只覆盖「指定策略 × 精确日期范围」的缓存文件。
- **`runRangeBacktestMulti` 是强制重算**（不读 `readCachedBacktest`），因此分类 Tag 会真正重跑所选策略。
- **`--strategies` 路径没有 prewarm/runPrebuild**，不会报错（`loadTrainingCampData` 会按需构建并落盘），但冷缓存时明显更慢 → 需要给 worker 补一个 `--prebuild` 开关（约 10 行）。
- **emo3 日期范围**：`pickRange` 中 `explicitRange` 判断在前，会覆盖 emo3 固定起点。**结论：分类回测一律由前端传日期**，前端 `emo3DefaultRange` 与后端 `getEmo3DefaultRange()` 同源同值，缓存 key 天然对齐。
- **分类回测不生成汇总报告**（`--strategies` 分支不走到 `aggregate`），UI 文案需如实说明。
- 全仓库只有 `TopBar` 引用 `BacktestDrawer`，删除训练营入口后唯一消费者就是新页面。

## 改动清单

### 一、后端

**1. `server/src/index.js`（`POST /training_camp/backtest/worker`，L2442 起）**
- 接收可选 `strategies`（数组或逗号串）；校验：非空、每项必须存在于 `STRATEGIES`（未知则 400），去重。
- 透传 `--strategies a,b,c`；同时透传 `--prebuild`。
- 原有 `backtestWorkerJob` 单例互斥、`--start/--end` 校验、spawn/日志逻辑保持不变。

**2. `server/script/backtest-worker.js`**
- `parseArgs`（L31-50）新增：`else if (a === '--prebuild') args.prebuild = true;`
- `--strategies` 分支（L621-641）在 `pickRange` 之后、`runStandalone` 之前，插入 `--prebuild` 处理：复用已 import 的 `prewarmKlineCache` + `runPrebuild`；回放数据日期下限按是否含 emo3 策略选择（含则并入 `getTechIndexDates()` 且 `allowMissingFund: true`）。

### 二、前端

**3. `盯盘工具/src/pages/trainingCamp/components/BacktestDrawer/index.jsx`（核心，98KB，仅外壳改造）**

新签名 `({ open = true, onClose, dates = [], embedded = false })`，加 `const isOpen = embedded ? true : open;`：
- L788 / L1033 的 `if (!open) return;` → `if (!isOpen) return;`；L797 / L1047 依赖数组 `[open]` → `[isOpen]`。
- 把 L1195-1230 的 title JSX 抽为 `headerNode`，L1233-1751 的 Drawer children 抽为 `content`。
- 返回值改为条件渲染：`embedded` → 全高容器（sticky 标题栏 `zIndex: 5`，低于 `.app-header-wrapper` 的 9）+ 内容区；否则仍是原 `<Drawer>`。
- 内部业务逻辑（轮询、缓存检查、handleStart/handleCopy、各 Modal）**零改动**。

在 `STRATEGY_OPTIONS`（L85-139）下方新增 `STRATEGY_CATEGORIES`（10 类，并集覆盖全部 46 个策略；允许交叉：研报类 ∩ 快进快出、研报类 ∩ 三日情绪冰点）：

| 分类 | 策略 id |
|---|---|
| 重点板块类 | `key_block_2d/3d/4d/5d_gain` |
| 三日情绪冰点类 | `tail_dip_emo3_3d_gain/3d_fall/3d_reports_top5_gain/1d_gain/1d_fall/1d_resilience` |
| 快进快出类 | `highest_2d/3d/4d/5d_gain_emoquick`、`highest_3d_reports_top5_gain_emoquick` |
| 研报覆盖类 | `highest_3d/5d_reports`、`highest_3d/5d_reports_top5_gain`、`highest_3d_reports_top5_gain_emoquick`、`tail_dip_emo3_3d_reports_top5_gain` |
| 情绪游资类 | `hot_money_ice_2d/3d/4d/5d/10d_gain` |
| N日涨幅最大类 | `highest_gain`、`highest_2d/3d/4d/5d/10d_gain` |
| 尾盘抄底类 | `tail_dip_1d_gain/3d_gain/1d_resilience/3d_resilience/1d_fall/3d_fall/1d_resilience_low` |
| 抗分歧/斜率类 | `highest_3d_ma_slope`、`highest_5d_ma_slope`、`highest_5d_resilience`、`highest_3d_resilience`、`resilience_weak_to_strong` |
| 当日实时口径 | `highest_1d_resilience` |
| 情绪开关系列 | `prev3d/prev2d/prev1d_fall_low5_day_gain_emoswitch` |

- 新增 state：`activeCategory`（Tag 高亮）、`workerMode`（`'all' | 'category'`，仅文案）。
- 新增 `firstStrategyInOptions(ids)`：取 `STRATEGY_OPTIONS` 顺序中第一个命中的 id。
- 新增 `handleRunCategory(cat)`：`running || workerRunning` 时拒绝；`setStrategy(first)` + 按策略大类重置日期范围；`POST /training_camp/backtest/worker { startDate, endDate, strategies: cat.ids }`；`startWorkerPolling({ message: '「X」回测完成' })`。
- Tag UI 插在「回测全部」按钮行之后：`Tag.CheckableTag`（`Tag` 已 import），回测中 `pointerEvents: none` + 半透明。
- 文案微调：`startWorkerPolling(opts)` 支持自定义完成提示；进行中 Alert 与按钮文案按 `workerMode` 分支；`handleRunAll` 内补 `setWorkerMode('all')`。
- 手动改 Select / 日期时 `setActiveCategory(null)`（避免高亮与实际不一致）。

**4. 新页面 `盯盘工具/src/pages/backtest/index.jsx`**
- `useEffect` 拉取 `GET http://${local_ip}:3000/training_camp/dates`；渲染 `<BacktestDrawer embedded dates={dates} />`。

**5. `盯盘工具/src/router.jsx`**
- 顶部 `import Backtest from './pages/backtest/index.jsx';`
- children 中在 `training_camp` 之前插入 `{ path: 'backtest', element: <Backtest /> }`。

**6. `盯盘工具/src/App.jsx`**
- `menuItems` 中在 `/training_camp` 项之前插入 `{ key: '/backtest', icon: <BarChartOutlined />, label: '买卖点回测' }`（`BarChartOutlined` 已在 L3 导入；`key` 必须与路由 path 一致）。

**7. `盯盘工具/src/pages/trainingCamp/components/TopBar/index.jsx`（删除训练营入口）**
- 删除 `BarChartOutlined` import、`import BacktestDrawer`、`backtestOpen` state、L92-99 的「买卖点回测」按钮、L119-123 的 `<BacktestDrawer>` 挂载点。
- `dates` prop 保留（日期 Select / 分组弹窗仍用）。

## 风险与边界

- **分类回测 ≠ 回测全部**：不清其它缓存、只写所选策略的缓存、**不生成汇总报告**（「回测报告」弹窗内容不动），单进程串行（比全量慢）。UI 文案需说明。
- **日期范围**：用「切到该分类首个策略后的有效范围」。研报覆盖类首个策略是常规策略 → 该类整体按常规 60 日窗口跑（其 emo3 成员也按此窗口，属有意取舍；拆两次会撞 worker 单例）。
- **并发保护**：后端 `backtestWorkerJob` 单例，已在跑时再 POST 返回 `{ success:true, running:true }` 而不排队 → 前端 Tag 在回测中禁用，并对 `r.data.running` 给出 warning。
- **轮询复用**：分类回测与全量共用 `/training_camp/backtest/worker/status`；完成回调 `checkCache()` 刷新的正是本次被切换到的首个策略，体验正确。
- **版本一致性**：`--prebuild` 需路由与 worker 同时生效，否则被静默忽略、退回慢路径（不会崩）。

## 验证方法

1. 前端 lint：`npx eslint src/pages/backtest/index.jsx src/pages/trainingCamp/components/BacktestDrawer/index.jsx src/pages/trainingCamp/components/TopBar/index.jsx src/App.jsx src/router.jsx`
2. 后端语法：`node -c src/index.js && node -c script/backtest-worker.js`
3. worker 冒烟（cwd=server）：
   - 基线 `ls src/data/backtest_results | wc -l`
   - `node script/backtest-worker.js --strategies key_block_2d_gain --start 20260728 --end 20260930` → 日志**不出现**「已清空回测缓存」，文件数只 +1，其余 mtime 不变
   - `node script/backtest-worker.js --strategies not_exist --start 20260728 --end 20260930` → 输出「未知策略」且退出码 1
   - 加 `--prebuild` → 日志出现「日K线文件缓存预热完成」与「预构建回放数据缓存」
4. 接口级：`curl -X POST .../training_camp/backtest/worker -d '{"startDate":"20260728","endDate":"20260930","strategies":["key_block_2d_gain","key_block_3d_gain"]}'`，轮询 status 见 running → done；非法 `strategies` 返回 400。
5. 浏览器：菜单出现「买卖点回测」→ URL `/backtest` 直接渲染回测界面（非抽屉），顶部三个按钮可用；逐个点 Tag 验证 ① 高亮 ② Select 切到该分类首个策略（重点板块类→`key_block_2d_gain`、三日情绪冰点类→`tail_dip_emo3_3d_gain`、快进快出类→`highest_2d_gain_emoquick`、研报覆盖类→`highest_3d_reports`、情绪游资类→`hot_money_ice_2d_gain`、N日涨幅最大类→`highest_gain`、尾盘抄底类→`tail_dip_1d_gain`、抗分歧/斜率类→`highest_3d_ma_slope`、当日实时口径→`highest_1d_resilience`、情绪开关系列→`prev3d_fall_low5_day_gain_emoswitch`）③ 出现分类回测 Alert ④ 回测中 Tag 与按钮禁用；训练营 TopBar 不再有该按钮；切走再切回无残留轮询。

## 实施顺序

1. 后端 `index.js` 支持 `strategies` → curl 验证 → worker 补 `--prebuild`
2. 前端 `STRATEGY_CATEGORIES` + `handleRunCategory` + 文案分支
3. `BacktestDrawer` 的 `embedded` 外壳改造
4. 新页面 + 路由 + 菜单
5. TopBar 删除入口
6. lint + worker 冒烟 + 浏览器验证

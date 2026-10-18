# 题材盯盘页改造方案

## Context（背景）

用户原话指向 `OpeningBattle/index.jsx`，但所描述的全部 7 项功能实际位于「题材盯盘」页
[themeMonitor/index.jsx](file:///Users/xieyin/Desktop/盯盘工具/盯盘工具/src/pages/themeMonitor/index.jsx)（路由 `/theme_monitor`）。
经确认，**改造目标为 themeMonitor 页**。

目标：优化板块涨跌幅前十的展示并支持 tooltip 内点击开 K 线；将主线/支线横幅升级为“单行彩色 chips + 新增自定义题材 + 拖拽排序”，并让下方 6 张题材卡片跟随排序前六；题材标题弹窗升级为「题材设置」（基础配置 + 题材回溯两个 tab）；卡片「今日 N 家」支持点击筛选涨停股；调高异动监控高度；放大资金明细字号。

已确认的两个关键决策：
1. 自定义题材、每题材股票增/删、拖拽顺序 → **后端 JSON 文件持久化**（仿 `overlay_stock_groups.json` 模式）。
2. 下方 6 张卡片 = **横幅排序前 6 个**（含自定义题材）。

---

## 一、后端改动（/Users/xieyin/Desktop/盯盘工具/server）

### 1. 新增持久化服务 `src/service/themeCustom.js`（新建）
仿 [overlayStockGroup.js](file:///Users/xieyin/Desktop/盯盘工具/server/src/service/overlayStockGroup.js) 的读写模式，落盘 `src/data/theme_custom.json`（新建），结构：

```json
{
  "themes": [{ "id": "...", "name": "自定义题材名", "stocks": [{"code":"sh600000","name":"浦发银行"}], "createdAt": "..." }],
  "overrides": { "<themeKey>": { "added": [{"code","name"}], "removed": ["sh600000"] } },
  "order": ["半导体", "custom:xxx", "..."]
}
```

导出：`getStore()` / `saveTheme({id,name,stocks})`（有 id 则更新，无则新建并生成 id） / `deleteTheme(id)`（同时从 order 中移除） / `saveOverride(themeKey,{added,removed})` / `saveOrder(order)`。
股票条目规范化为 `{code, name}`，`code` 采用带市前缀的 marketCode（与 specs 一致）。

### 2. 新增路由 `src/index.js`
紧跟现有 `/theme_history` 一带（约 L680 附近）新增：

- `GET  /theme_custom/list` → 返回整份 store
- `POST /theme_custom/save_theme` → `{id?, name, stocks}`
- `POST /theme_custom/delete_theme` → `{id}`
- `POST /theme_custom/save_override` → `{themeKey, added, removed}`
- `POST /theme_custom/save_order` → `{order}`

每个写操作成功后调用 `invalidateThemeAnalysisCache()`（见下），使 60s 的分析缓存立即失效，避免保存后卡片不刷新。

### 3. 改造 `src/service/themeMonitor.js`
- `buildThemeAnalysis()`：
  - 读出 store；对每个系统题材应用 override：`stocks = 原stocks - removed + added(规范化为最小字段)`，同时 `dragons` 过滤掉 removed。
  - 追加自定义题材到返回值新字段 `customThemes`（**不混入 `themes`，避免影响 rank/type/score 排序**）：
    `{ key: 'custom:'+id, board: name, type: '自定义', custom: true, id, stocks: [...]（最小字段）, dragons: [] }`。
  - `mainLines/branches` 保持不动（前端将不再使用，保留以防他处引用）。
- 新增导出 `invalidateThemeAnalysisCache()`（清 `analysisCache`）。
- `/theme_monitor_all`（`src/index.js` L638）中行情 codes 来源：由“`themes.slice(0,6)`”改为“`themes.slice(0, CHIP_THEME_COUNT=9)` + `customThemes`”，保证横幅 9 个 chip 与自定义题材的实时涨幅/涨停判断都有行情。
- `getThemeDayStocks()`（L464）：`changePct` 取值改为 —— 优先 `s.quote?.changePct`（快照当日涨幅），为空时用**同一次 kline 调用**里 `trade_date === Number(dateYmd)` 那条的 `change` 兜底，保证“展示所选交易日的当日涨幅”。`prevChanges` 计算可保留（前端不再渲染）。

---

## 二、前端改动（/Users/xieyin/Desktop/盯盘工具/盯盘工具/src/pages/themeMonitor/index.jsx）

新增依赖（均已在 package.json）：`@dnd-kit/core`、`@dnd-kit/sortable`、`@dnd-kit/utilities`；antd 追加 `Tabs / Input / Button / message / Modal(已有)`。
拖拽可复用 [CustomGantt.jsx](file:///Users/xieyin/Desktop/盯盘工具/盯盘工具/src/pages/shichangdiaoyan/components/CustomGantt.jsx)（L4-6、L23-25、L497-524）的 `DndContext + SortableContext + useSortable + arrayMove` 写法。
股票搜索复用 [StockSearchInput](file:///Users/xieyin/Desktop/盯盘工具/盯盘工具/src/components/StockSearchInput/index.jsx) 同源的 `GET /search_stock?query=`（返回 `[{code,name}]`，code 已含 sh/sz 前缀）做批量解析。

### 1. 状态与数据
- 新增 `customStore`（`{themes, overrides, order}`），挂载时 `GET /theme_custom/list`；提供 `reloadCustom()` 供增删改后刷新，并立即触发一次 `poll()`（把 poll 抽成 `useCallback`）。
- `chipList`（memo）= `[...analysis.themes.slice(0,9), ...customThemes]` 按 `order` 重排（order 中不存在的新 chip 追加到末尾）。
- `cardThemes` = `chipList.slice(0,6)` 映射回原 theme 对象（系统按 key，自定义按 key）。

### 2. 横幅条重构（替代 `MainlineStrip`）
- 一个 `DndContext` 包裹的单行 chips 容器（横向）；每个 chip 绑定 `useSortable`，`onDragEnd` 用 `arrayMove` 重排并 `POST /theme_custom/save_order`。
- 去掉「主线/支线」两个分组 label；**按颜色区分**：主线 chip 红底、支线 chip 灰底、自定义 chip 灰底 + 后缀「自定义」小标。
- chip 显示：题材名 + `今日N家`（沿用 `liveCountOf`）。
- 末尾「新增板块」按钮 → 打开新建弹窗。
- 自定义 chip 绑定 `onDoubleClick` → `Modal.confirm` 二次确认 → `POST /theme_custom/delete_theme` → `reloadCustom()`。
- 保留右侧「个股历史分析」按钮（`onOpenHistoryAnalysis`）。

### 3. 新增弹窗 CustomThemeModal（新增题材）
输入题材名称（Input）+ 批量股票文本框（TextArea，每行一个名称或代码）；提交时逐行 `GET /search_stock` 取第一条解析为 `{code,name}`（解析失败的行提示跳过），`POST /theme_custom/save_theme` → `reloadCustom()`。

### 4. `ThemeHistoryModal` → `ThemeSettingsModal`
- 标题：`「${initialTheme.board}」题材设置`。
- antd `Tabs`：`基础配置` / `题材回溯`。
- **基础配置 tab**：展示当前题材股票列表（名称 + marketCode + 删除按钮，删除即时落库）；下方批量文本框 + 「添加」按钮解析后落库。
  - 系统题材 → `POST /theme_custom/save_override`（key = `theme.key`；新增入 `added`，删除入 `removed`；若删除的是 `added` 项则从 `added` 移除）。
  - 自定义题材 → `POST /theme_custom/save_theme`（直接改其 stocks）。
  - 保存后 `reloadCustom()` 刷新卡片。
- **题材回溯 tab**：沿用现有 `ThemeHistoryModal` 全部内容（对比题材 Select + 图表 + 右侧涨停列表），仅按需求 3 做三处调整。

### 5. 需求 3（回溯 tab 内容调整）
- 市场情绪折线改**紫色虚线**：`borderDash: [6, 4]`（保持 `borderColor:'#7c3aed'`）。
- 右侧股票列表**删除「前3日」列**（去掉 `tm-th-stock-prev`）。
- 涨幅展示 `changePct`（后端已保证为所选交易日当日涨幅）。

### 6. 需求 1（板块涨跌幅前十）
- `BlockRankingStrip` 新增 `onOpenKline` prop；tooltip 内每行股票加 `onClick` → `onOpenKline({ marketCode: s.code, name: s.name })`（板块股 `code` 即 marketCode，已确认）。
- 样式重做（见下），chip 悬浮显示成分股。

### 7. 需求 5（今日 N 家可点击）
- `ThemeCard` 内新增本地 `limitOnly` state；点击「今日 N 家」切换：
  - 激活时 `.tm-theme-today` 加高亮 class（红/主题色）；
  - 列表只渲染 `theme.stocks` 中 `isStockLimitUp(s, quotes[s.marketCode])` 为真的股票（dragons 与 restStocks 各自过滤）；再次点击恢复全量。

### 8. 需求 6
- 见样式：异动监控高度 +150px。

---

## 三、样式改动（themeMonitor/index.scss）

- **板块涨跌幅前十（需求1）**：`.tm-block-ranking` 由横向 chip 列表改为更精致的卡片式：chip 内容 `序号徽标 + 板块名 + 涨跌幅 + 排名箭头`，加大行高/内边距、圆角、悬浮阴影与边框反馈；两组上下排布更清晰。
- **横幅条（需求2）**：`.tm-mainline-strip` 内 chip 改为单行可拖拽；新增 `.tm-line-chip.main/.branch/.custom` 三态配色（主线红底、支线/自定义灰底），新增 `.tm-line-chip-custom-tag`（自定义后缀）；拖拽时 `.is-dragging` 半透明。保留 `.tm-history-analysis-btn`。
- **今日N家**：`.tm-theme-today` 增加 `.active` 高亮态（红字 + 底色）。
- **题材设置 tab**：新增 `.tm-ts-tabs`、`.tm-ts-base`（股票行/删除按钮/批量输入区）等样式。
- **异动监控（需求6）**：`.tm-movement-list` `max-height: 300px → 450px`、`min-height: 120px → 270px`。
- **资金明细（需求7）**：`.tm-fund-detail` 宽度 `150px → 190px`；`.tm-fund-detail-title`、`.tm-fund-switch`、`.tm-fund-item`、`.item-time`、`.item-value`、`.item-diff` 全部 `font-size: 12px`；`.tm-fund-item` padding 增到 `5px 10px`，行间距/标题 padding 一并加大，缓解费眼问题。

---

## 四、验证

1. 语法/构建
   - 后端：`node --check server/src/service/themeCustom.js && node --check server/src/index.js && node --check server/src/service/themeMonitor.js`
   - 前端：`cd 盯盘工具 && npx eslint src/pages/themeMonitor/index.jsx`，再 `npx vite build` 确认无编译错误。
2. 启动后端 + 前端，打开 `/theme_monitor`：
   - 板块 tooltip 内点击股票 → 打开 K 线弹窗。
   - 「新增板块」新建自定义题材 → 出现在横幅末尾并带「自定义」。
   - 双击自定义 chip → 二次确认 → 删除成功。
   - 拖拽 chips → 刷新后顺序保持，下方 6 张卡片跟随前六个（含自定义题材时能正常生成卡片）。
   - 卡片标题点击 → 弹窗标题为「xxx」题材设置，两个 tab；基础配置增/删股票后卡片与横幅即时更新（含自定义题材）。
   - 回溯 tab：市场情绪为紫色虚线；右侧无「前3日」列；切换日期时「涨幅」为该日期当日涨幅。
   - 卡片「今日 N 家」点击 → 高亮并只显示当日涨停股，再点恢复。
   - 异动监控列表高度较原先高约 150px。
   - 资金明细字号统一 12px、间距更宽松。
3. 数据校验：`server/src/data/theme_custom.json` 在增删题材/股票/拖拽后内容符合预期，重载页面后仍生效。

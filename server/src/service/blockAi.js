// 板块 AI 分析服务
// - getBlockAiContext(days): 构建 AI 分析上下文 prompt，用于"拷贝上下文"功能
// - runBlockAiAnalysis(days): 调用 AI 直接生成板块分析
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { getActiveProvider, getHeaders, buildRequestBody } = require('../utils/aiProvider');
const { getJigouReportsData } = require('./jigouReports');
const { getAllIndexKlineData, getAllTechIndexData } = require('./emotion');

const dataDir = path.resolve(__dirname, '../data');
const RESEARCH_REPORTS_DIR = path.join(dataDir, 'research_reports');

// 安全读取 JSON
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8'));
  } catch (e) {
    return [];
  }
};

// 格式化日期 YYYYMMDD -> YYYY-MM-DD
const fmtDate = (d) => {
  const s = String(d);
  return `${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}`;
};

/**
 * 构建板块 AI 分析上下文 prompt
 * @param {number} days 取最近多少天的日级数据
 */
const getBlockAiContext = async (days = 10) => {
  // 1. 板块涨跌幅日历史
  const blockDayHistoryRaw = readJson('block_data_day_history.json');
  const blockDayHistory = (blockDayHistoryRaw || []).slice(0, Math.max(1, days));

  // 2. 板块资金日历史
  const blockMoneyDayHistoryRaw = readJson('block_money_change_day_history.json');
  const blockMoneyDayHistory = (blockMoneyDayHistoryRaw || []).slice(0, Math.max(1, days));

  // 3. 板块资金分时（今日）
  const blockMoneyTimeRaw = readJson('blockMoneyChangeTime.json');
  const blockMoneyTime = (blockMoneyTimeRaw || [])
    .filter(item => {
      const raw = String(item.time || '').replace(/\D/g, '');
      if (raw.length < 4) return true;
      const hh = parseInt(raw.slice(0, 2), 10);
      const mm = parseInt(raw.slice(2, 4), 10);
      return hh * 60 + mm <= 15 * 60;
    })
    .slice(-12);

  // 4. 板块涨跌幅分时（今日）
  const blockChangeTimeRaw = readJson('block_data_change_time.json');
  const blockChangeTime = (blockChangeTimeRaw || [])
    .filter(item => {
      const raw = String(item.time || '').replace(/\D/g, '');
      if (raw.length < 4) return true;
      const hh = parseInt(raw.slice(0, 2), 10);
      const mm = parseInt(raw.slice(2, 4), 10);
      return hh * 60 + mm <= 15 * 60;
    })
    .slice(-12);

  // 5. 最近十天研究报告内容（排除"今日复盘"）
  const researchReportsContent = (() => {
    try {
      const menuPath = path.join(RESEARCH_REPORTS_DIR, 'menu.json');
      if (!fs.existsSync(menuPath)) return [];
      const data = JSON.parse(fs.readFileSync(menuPath, 'utf-8'));
      if (!Array.isArray(data)) return [];
      const folders = data.filter(f => f.type === 'folder');
      const recentFolders = folders.slice(-Math.min(10, folders.length));
      const reports = [];
      recentFolders.forEach(folder => {
        (folder.children || []).forEach(report => {
          if (report.type === 'report' && report.name && report.name !== '今日复盘') {
            let content = '';
            try {
              const reportFile = path.join(RESEARCH_REPORTS_DIR, `${report.id}.json`);
              if (fs.existsSync(reportFile)) {
                const reportData = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
                content = reportData.content || '';
              }
            } catch (e) {
              content = '';
            }
            reports.push({
              date: folder.name,
              title: report.name,
              content: content.length > 1500 ? content.slice(0, 1500) + '...(truncated)' : content,
            });
          }
        });
      });
      return reports;
    } catch (e) {
      return [];
    }
  })();

  // 6. 机构调研研报（jigouReports.json）
  const { reports: jigouReports } = getJigouReportsData();

  // 7. 创业板指最近30天K线数据
  let cybKlineData = [];
  try {
    const indexKlineData = await getAllIndexKlineData();
    cybKlineData = (indexKlineData.chuangyebanData || []).slice(-30);
  } catch (e) {
    cybKlineData = [];
  }

  // 8. 科技板块情绪数据（最近30条）
  const techIndexData = getAllTechIndexData().slice(-30);

  // 日期范围显示
  const dateList = blockDayHistory.map(d => fmtDate(d.date));
  const dateDisplay = dateList.length > 0
    ? `${dateList[dateList.length - 1]} ~ ${dateList[0]}`
    : dayjs().format('YYYY-MM-DD');

  // 格式化板块涨跌幅日历史
  const blockDayLines = blockDayHistory.map(d => {
    const blocks = d.blocks || {};
    const entries = Object.entries(blocks)
      .map(([name, v]) => ({ name, avgChange: v?.avgChange ?? 0 }))
      .sort((a, b) => b.avgChange - a.avgChange);
    const top5 = entries.slice(0, 5).map(e => `${e.name}(${e.avgChange >= 0 ? '+' : ''}${e.avgChange}%)`).join('、');
    const bottom5 = entries.slice(-5).map(e => `${e.name}(${e.avgChange >= 0 ? '+' : ''}${e.avgChange}%)`).join('、');
    return `${fmtDate(d.date)} | 涨幅前5: ${top5} | 跌幅前5: ${bottom5}`;
  });

  // 格式化板块资金日历史
  const blockMoneyDayLines = blockMoneyDayHistory.map(d => {
    const list = (d.data || []).slice().sort((a, b) => b.money - a.money);
    const top5 = list.slice(0, 5).map(e => `${e.block}(${(e.money / 1e8).toFixed(2)}亿)`).join('、');
    const bottom5 = list.slice(-5).map(e => `${e.block}(${(e.money / 1e8).toFixed(2)}亿)`).join('、');
    return `${fmtDate(d.date)} | 净流入前5: ${top5} | 净流出前5: ${bottom5}`;
  });

  // 格式化板块资金分时
  const blockMoneyTimeLines = blockMoneyTime.map(item => {
    const data = (item.data || []).slice(0, 8).map(d => `${d.block}:${(d.money / 1e8).toFixed(1)}亿`).join('、');
    return `${item.time} | ${data}`;
  });

  // 格式化板块涨跌幅分时
  const blockChangeTimeLines = blockChangeTime.map(item => {
    const data = (item.blockData || []).slice(0, 8).map(d => `${d.blockName}:${d.avgChange >= 0 ? '+' : ''}${d.avgChange}%`).join('、');
    return `${item.time} | ${data}`;
  });

  // 格式化最近十天研究报告
  const researchReportLines = researchReportsContent
    .map(r => `[${r.date}] ${r.title}\n${r.content}`)
    .join('\n\n');

  // 格式化机构调研研报
  const jigouReportLines = (jigouReports || [])
    .slice(0, 30)
    .map(r => {
      const title = r.title || '无标题';
      const text = String(r.text || '').slice(0, 400);
      return `【${title}】${text}${r.text && r.text.length > 400 ? '...(truncated)' : ''}`;
    })
    .join('\n');

  // 格式化创业板指K线数据（最近30天）
  const cybKlineLines = (cybKlineData || [])
    .map(k => {
      const date = k.trade_date || '';
      const open = k.open_px || 0;
      const high = k.high_px || 0;
      const low = k.low_px || 0;
      const close = k.close_px || 0;
      const change = k.change || 0;
      const turnover = k.business_balance || 0;
      return `${date} | 开:${open} 高:${high} 低:${low} 收:${close} | 涨跌:${change >= 0 ? '+' : ''}${change}% | 成交:${(turnover / 1e8).toFixed(2)}亿`;
    })
    .join('\n');

  // 格式化科技板块情绪数据（最近30条）
  const techIndexLines = (techIndexData || [])
    .map(t => {
      const date = fmtDate(t.date);
      const changeSum = t.changeSumResult?.toFixed(2) ?? '-';
      const rawSum = t.rawSum?.toFixed(2) ?? '-';
      const base = t.baseEmotion?.toFixed(2) ?? '-';
      const penalty = t.pullbackPenalty?.toFixed(2) ?? '-';
      const hasIce = t.hasIce ? ' [冰点]' : '';
      return `${date} | 情绪指数:${changeSum >= 0 ? '+' : ''}${changeSum} | 原始值:${rawSum >= 0 ? '+' : ''}${rawSum} | 基础情绪:${base >= 0 ? '+' : ''}${base} | 冲高回落惩罚:${penalty}${hasIce}`;
    })
    .join('\n');

  // 主线题材历史检验六条（硬编码知识，供 AI 分析时参考）
  const mainThemeChecklist = `为了判断一个题材是否能成为持续性的主线，请你结合数据与以下"主线题材历史检验六条"逐一检验候选题材：

1. **题材是否足够新颖**。同一个题材第一次炒作和第二次、第三次拿出来炒作是完全不同的激情度。例如机器人、商业航天在过去已经经历过大幅度的炒作了，所以如今再出现一些非实质性的利好催化，只是单纯的情绪催化，就没有办法产生持续性行情，往往一日游。
2. **题材诞生的时间是否正确**。题材诞生的时间点一定要跟当下情绪做多氛围相关。一般需要满足指数向上、成交量放大活跃、风险偏好高等条件。如果这些条件都满足，那么一个中等的利好催化就有可能被资金猛猛干成大题材。反过来也是一样的，如果指数向下、市场大幅度缩量，市场风险偏好低的话，那么再大的利好催化也无法走出来持续性。
3. **看有没有唯一性**。市场在同一个时间不可能同时有很多个主线题材，往往只有一两个，不然就会形成各个板块互相争抢流动性，那就谁也走不出来。
4. **看散户究竟认不认可**。这个题材概念不能太高深，最好能简单用两句话说清楚，这样散户才会愿意持续入场购买。
5. **看题材板块的容量够不够**。如果一个题材板块的资金容量太小，都是一些小市值的票，那么大资金就没有办法参与。如果板块盘子太大，里面有几百甚至上千只股票，那么就太分散，资金无法聚焦。最好是有中军作为情绪压舱石，给大资金参与。然后游资参与高弹性的小票向上持续大高度，还有其他资金持续挖掘产业链补涨。形成一个完整的上涨梯队。
6. **看有没有持续不断地利好催化**。如果只有一次性的利好消息，那么资金最多炒作几天就会一而再，再而三，情绪就衰竭了。除非能持续不断地出现利好催化，那么每次在情绪衰竭的时候，就会被新的催化点燃做多情绪，资金再接着炒。比如 AI 硬件过去几年就是每次当炒作了一段时间市场情绪开始衰竭的时候，总会出现新的技术方向和利好催化，于是再次点燃市场做多情绪动能，相关股票连续不断创下新高。`;

  const prompt = `你是专业的A股市场题材分析师。请基于以下板块走势、资金流向、机构调研、研究报告、指数K线与科技情绪等多维数据，结合"主线题材历史检验六条"对当下热门题材进行系统性研判。

【分析区间】${dateDisplay}（共 ${blockDayHistory.length} 个交易日）

【数据说明】
1. 板块涨跌幅日历史：每天全部板块按平均涨跌幅排序的头部与尾部
2. 板块资金日历史：每天板块主力净流入的头部与尾部
3. 今日板块资金分时：采样收盘前最新若干时点的净流入板块
4. 今日板块涨跌幅分时：采样收盘前最新若干时点的涨跌幅板块
5. 最近十天研究报告：来自 research_reports 目录下最近 10 个交易日的研报内容
6. 机构调研研报：来自 jigouReports.json 中的机构调研交流圈帖子
7. 创业板指K线：创业板指(sz399006)最近30天日K线数据，含开高低收、涨跌幅、成交额
8. 科技板块情绪指数：科技板块情绪数据最近30条记录，含情绪指数、原始值、基础情绪、冲高回落惩罚、冰点标记

========== 板块涨跌幅日历史 ==========
格式：日期 | 涨幅前5 | 跌幅前5

${blockDayLines.join('\n') || '无数据'}

========== 板块资金日历史 ==========
格式：日期 | 净流入前5(亿) | 净流出前5(亿)

${blockMoneyDayLines.join('\n') || '无数据'}

========== 今日板块资金分时（最新12个采样点） ==========
格式：HH:mm | 板块:净流入(亿)

${blockMoneyTimeLines.join('\n') || '无数据'}

========== 今日板块涨跌幅分时（最新12个采样点） ==========
格式：HH:mm | 板块:涨跌幅%

${blockChangeTimeLines.join('\n') || '无数据'}

========== 最近十天研究报告 ==========

${researchReportLines || '无数据'}

========== 机构调研研报 ==========

${jigouReportLines || '无数据'}

========== 创业板指K线（最近30天） ==========
格式：日期 | 开:xx 高:xx 低:xx 收:xx | 涨跌:xx% | 成交:xx亿

${cybKlineLines || '无数据'}

========== 科技板块情绪指数（最近30条） ==========
格式：日期 | 情绪指数 | 原始值 | 基础情绪 | 冲高回落惩罚 [冰点]

${techIndexLines || '无数据'}

========== 主线题材历史检验六条 ==========

${mainThemeChecklist}

========== 分析任务 ==========

请你作为资深题材分析师，结合上述数据与"主线题材历史检验六条"，完成以下分析任务：

1. **候选题材列表**：从板块涨跌幅、资金流向、机构调研、研究报告、创业板指走势与科技情绪指数中识别当下市场正在炒作或潜在的题材（至少列出 5 个候选）。
2. **逐条检验**：用"主线题材历史检验六条"对每个候选题材进行逐条评估，说明六条中每一条的通过/不通过情况与依据。
3. **主线题材推荐**：从候选题材中推荐 **3 个** 最有可能成为（或延续成为）主线的题材，分别给出：
   - 题材名称
   - 成为主线的核心理由（结合检验六条与数据）
   - 潜在的风险与证伪条件
   - 可跟踪的观察指标（如中军股、情绪风向标、关键催化节点）
4. **板块格局研判**：当前主线 / 轮动 / 退潮板块的结构性判断，以及 1-3 天的重点跟踪方向。

要求：
1. 分析必须基于上述数据，引用具体数值（涨幅百分比、资金净流入规模、研报关键词、指数涨跌幅、情绪指数等）
2. 必须对照"主线题材历史检验六条"逐条检验候选题材，不要跳过
3. 结合创业板指K线走势判断市场整体风险偏好变化
4. 结合科技板块情绪指数判断科技题材的情绪温度与退潮冰点
5. 区分短期情绪催化与趋势性主线
6. 不要复述数据本身，要给出有洞察的研判
7. 用中文输出，结构清晰，使用小标题分段`;

  return {
    success: true,
    prompt,
    dateDisplay,
    days: blockDayHistory.length,
    dataInfo: {
      blockDayHistoryCount: blockDayHistory.length,
      blockMoneyDayHistoryCount: blockMoneyDayHistory.length,
      blockMoneyTimeCount: blockMoneyTime.length,
      blockChangeTimeCount: blockChangeTime.length,
      researchReportsCount: researchReportsContent.length,
      jigouReportsCount: jigouReports.length,
      cybKlineCount: cybKlineData.length,
      techIndexCount: techIndexData.length,
    },
  };
};

/**
 * 调用 AI 执行板块分析，返回分析文本
 */
const runBlockAiAnalysis = async (days = 10) => {
  const ctx = await getBlockAiContext(days);
  if (!ctx.success) {
    throw new Error('构建上下文失败');
  }
  const provider = getActiveProvider();
  console.log(`[blockAiAnalysis] 调用 ${provider.name} ${provider.model} 进行板块分析`);

  const response = await fetch(provider.apiUrl, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(buildRequestBody({
      messages: [
        {
          role: 'system',
          content: '你是专业的A股市场板块分析师，擅长根据板块涨跌幅、资金流向、板块轮动分类等数据，洞察板块走势规律与资金切换节奏。分析务必基于数据、引用具体数值，给出有可操作性的研判。用中文输出。',
        },
        { role: 'user', content: ctx.prompt },
      ],
      temperature: 0.7,
      stream: false,
      thinking: false,
      maxTokens: 8192,
    })),
  });

  if (!response.ok) {
    throw new Error(`${provider.name}API请求失败: ${response.status}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0] || {};
  const content = choice.message?.content || choice.message?.reasoning_content || '';
  if (!content) {
    throw new Error(`${provider.name}返回内容为空`);
  }

  return {
    success: true,
    analysis: content,
    dateDisplay: ctx.dateDisplay,
    provider: provider.name,
    model: provider.model,
  };
};

module.exports = {
  getBlockAiContext,
  runBlockAiAnalysis,
};

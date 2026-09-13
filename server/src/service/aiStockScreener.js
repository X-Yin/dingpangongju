const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { getActiveProvider, getHeaders, buildRequestBody } = require('../utils/aiProvider');
const { getJigouReportsData, getRecentResearchReports } = require('./jigouReports');

const dataDir = path.resolve(__dirname, '../data');
const RESEARCH_REPORTS_DIR = path.join(dataDir, 'research_reports');

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8'));
  } catch (e) {
    return null;
  }
};

const safeReadJson = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (e) {}
  return null;
};

const fmtMoney = (val) => {
  if (val === undefined || val === null) return '';
  if (typeof val === 'number') {
    return `${val >= 0 ? '+' : ''}${(val / 1e8).toFixed(2)}亿`;
  }
  return String(val);
};

const parseMoneyStr = (str) => {
  if (!str) return 0;
  const s = String(str).trim();
  if (s.startsWith('+')) return parseFloat(s.slice(1)) || 0;
  return parseFloat(s) || 0;
};

const parseAmountTime = (timeStr) => {
  const s = String(timeStr || '').replace(/\D/g, '');
  if (s.length < 4) return '';
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
};

const parseBlockTime = (timeStr) => {
  const s = String(timeStr || '').replace(/\D/g, '');
  if (s.length < 4) return '';
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
};

/**
 * 获取最近 N 天的研究报告内容
 */
const getRecentResearchReportsContent = (days = 10) => {
  try {
    const menuPath = path.join(RESEARCH_REPORTS_DIR, 'menu.json');
    if (!fs.existsSync(menuPath)) return [];
    const data = JSON.parse(fs.readFileSync(menuPath, 'utf-8'));
    if (!Array.isArray(data)) return [];

    const folders = data.filter(f => f.type === 'folder');
    const recentFolders = folders.slice(-days);

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
            content: content.length > 2000 ? content.slice(0, 2000) + '...(truncated)' : content,
          });
        }
      });
    });
    return reports;
  } catch (error) {
    return [];
  }
};

/**
 * 构建 AI 选股上下文
 */
const buildAiScreenContext = () => {
  const now = dayjs();

  // 1. 板块资金流向分时数据
  const blockMoneyRaw = readJson('blockMoneyChangeTime.json') || [];
  const blockMoneyData = blockMoneyRaw
    .filter(item => {
      const raw = String(item.time || '').replace(/\D/g, '');
      if (raw.length < 4) return true;
      const hh = parseInt(raw.slice(0, 2), 10);
      const mm = parseInt(raw.slice(2, 4), 10);
      return hh * 60 + mm <= 15 * 60;
    })
    .slice(-10)
    .map(item => {
      const topBlocks = (item.data || [])
        .sort((a, b) => Math.abs(b.money) - Math.abs(a.money))
        .slice(0, 10)
        .map(d => `${d.block}(${fmtMoney(d.money)})`)
        .join('、');
      return `${parseBlockTime(item.time)} | ${topBlocks}`;
    });

  // 2. 大盘资金流向分时
  const amountRaw = readJson('amount.json') || [];
  const amountData = amountRaw
    .filter(item => {
      const raw = String(item[0] || '').replace(/\D/g, '');
      if (raw.length < 4) return true;
      const hh = parseInt(raw.slice(0, 2), 10);
      const mm = parseInt(raw.slice(2, 4), 10);
      return hh * 60 + mm <= 15 * 60;
    })
    .filter((_, i, arr) => i % Math.max(1, Math.floor(arr.length / 15)) === 0)
    .slice(-15)
    .map(item => {
      const time = parseAmountTime(item[0]);
      const obj = item[1] || {};
      return `${time} | 主力资金:${obj.mainMoney || ''} | 成交量变化:${obj.amountChangeDiff || ''} | 总成交:${obj.totalAmount || ''}`;
    });

  // 3. 个股涨跌幅数据
  const stockDataRaw = readJson('stockData.json') || {};
  const stockList = Object.entries(stockDataRaw).map(([code, item]) => {
    const kline = item.kline?.[0] || {};
    return {
      code,
      name: item.stockName || '',
      change: kline.change ?? null,
      close: kline.close_px ?? null,
      open: kline.open_px ?? null,
      high: kline.high_px ?? null,
      low: kline.low_px ?? null,
      volume: kline.business_amount ?? null,
      turnover: kline.business_balance ?? null,
      ma5: kline.ma5_px ?? null,
      ma10: kline.ma10_px ?? null,
      ma20: kline.ma20_px ?? null,
    };
  });

  // 按涨幅排序
  const topGainers = stockList
    .filter(s => s.change !== null && s.change > 0)
    .sort((a, b) => b.change - a.change)
    .slice(0, 30)
    .map(s => `${s.name}(${s.change >= 0 ? '+' : ''}${s.change.toFixed(2)}%)`);

  const topLosers = stockList
    .filter(s => s.change !== null && s.change < 0)
    .sort((a, b) => a.change - b.change)
    .slice(0, 10)
    .map(s => `${s.name}(${s.change.toFixed(2)}%)`);

  const aboveMA5 = stockList.filter(s => s.close !== null && s.ma5 !== null && s.close > s.ma5).length;
  const aboveMA10 = stockList.filter(s => s.close !== null && s.ma10 !== null && s.close > s.ma10).length;
  const totalStocks = stockList.filter(s => s.change !== null).length;

  // 4. 板块涨跌幅分时
  const blockChangeRaw = readJson('block_data_change_time.json') || [];
  const blockChangeData = blockChangeRaw
    .filter(item => {
      const raw = String(item.time || '').replace(/\D/g, '');
      if (raw.length < 4) return true;
      const hh = parseInt(raw.slice(0, 2), 10);
      const mm = parseInt(raw.slice(2, 4), 10);
      return hh * 60 + mm <= 15 * 60;
    })
    .slice(-10)
    .map(item => {
      const blocks = (item.blockData || [])
        .sort((a, b) => b.avgChange - a.avgChange)
        .slice(0, 8)
        .map(b => `${b.blockName}(${b.avgChange >= 0 ? '+' : ''}${b.avgChange.toFixed(2)}%)`)
        .join('、');
      return `${item.time} | ${blocks}`;
    });

  // 5. 机构调研研报
  const { reports: jigouReports } = getJigouReportsData();
  const jigouReportTexts = jigouReports
    .slice(0, 20)
    .map(r => `【${r.title || '无标题'}】${(r.text || '').slice(0, 300)}`)
    .join('\n');

  // 6. 最近10天研究报告
  const researchReports = getRecentResearchReportsContent(10);
  const researchTexts = researchReports
    .map(r => `[${r.date}] ${r.title}\n${r.content}`)
    .join('\n\n');

  // 7. 汇总统计
  const limitUpCount = stockList.filter(s => s.change !== null && s.change >= 9.5).length;
  const limitDownCount = stockList.filter(s => s.change !== null && s.change <= -9.5).length;

  let marketSentiment = '中性';
  if (limitUpCount > limitDownCount * 3) marketSentiment = '强势';
  else if (limitDownCount > limitUpCount * 3) marketSentiment = '弱势';
  else if (limitUpCount > limitDownCount) marketSentiment = '偏强';
  else if (limitDownCount > limitUpCount) marketSentiment = '偏弱';

  const context = {
    timestamp: now.format('YYYY-MM-DD HH:mm:ss'),
    marketOverview: {
      sentiment: marketSentiment,
      limitUp: limitUpCount,
      limitDown: limitDownCount,
      aboveMA5,
      aboveMA10,
      totalStocks,
    },
    blockMoneyFlow: blockMoneyData.join('\n') || '无数据',
    amountFlow: amountData.join('\n') || '无数据',
    topGainers: topGainers.join('、') || '无数据',
    topLosers: topLosers.join('、') || '无数据',
    blockChanges: blockChangeData.join('\n') || '无数据',
    jigouReports: jigouReportTexts || '无数据',
    researchReports: researchTexts || '无数据',
  };

  return context;
};

/**
 * 构建 AI Prompt
 */
const buildAiPrompt = (context) => {
  return `你是专业的A股市场分析师。请根据以下实时市场数据，结合资金流向、板块涨跌、个股表现和研报推荐，筛选出当日最值得关注的推荐个股。

【当前时间】${context.timestamp}

【大盘概况】
市场情绪: ${context.marketOverview.sentiment}
涨停/跌停: ${context.marketOverview.limitUp} / ${context.marketOverview.limitDown}
站上5日线/10日线: ${context.marketOverview.aboveMA5} / ${context.marketOverview.aboveMA10}
总个股数: ${context.marketOverview.totalStocks}

【板块资金流向（按净流入排序，最新10个采样点）】
格式：时间 | 板块:净流入
${context.blockMoneyFlow}

【大盘主力资金流向（分时采样）】
格式：时间 | 主力资金 | 成交量变化 | 总成交
${context.amountFlow}

【板块涨跌幅（最新10个采样点）】
格式：时间 | 涨幅前8板块
${context.blockChanges}

【今日涨幅前30个股】
${context.topGainers}

【今日跌幅前10个股】
${context.topLosers}

【机构调研交流圈最新帖子】
${context.jigouReports}

【最近10天研报内容】
${context.researchReports}

========== 分析任务 ==========

请你根据以上数据，结合以下维度筛选推荐个股：

1. 资金共振：主力资金持续流入的板块中，个股涨幅居前
2. 研报共振：有机构研报推荐或调研提及的个股
3. 板块涨幅共振：所在板块涨幅领先且有资金流入
4. 技术形态：站上5日线和10日线，多头排列

请推荐数量不限的个股，输出严格的JSON格式：
{
  "recommendations": [
    {
      "stockName": "个股名称",
      "code": "股票代码",
      "change": 涨跌幅百分比(数字),
      "reason": "推荐理由（结合数据说明为什么推荐，例如：主力资金连续流入+板块涨幅领先+有研报推荐）"
    }
  ]
}

要求：
1. 推荐理由必须基于数据，引用具体的板块名称、资金流向、研报等信息
2. 优先推荐有资金共振（主力流入）、研报共振（有推荐）、技术形态良好的个股
3. 用中文输出reason字段
4. 严格按照上述JSON格式输出，不要输出其他任何内容`;
};

/**
 * 获取 AI 选股上下文（用于复制功能）
 */
const getAiScreenContext = () => {
  const context = buildAiScreenContext();
  const prompt = buildAiPrompt(context);
  return {
    success: true,
    prompt,
    context,
    timestamp: context.timestamp,
  };
};

/**
 * 调用 AI 执行选股
 */
const runAiScreen = async () => {
  const context = buildAiScreenContext();
  const prompt = buildAiPrompt(context);
  const provider = getActiveProvider();

  console.log(`[aiStockScreener] 调用 ${provider.name} ${provider.model} 进行AI选股`);

  const response = await fetch(provider.apiUrl, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(buildRequestBody({
      messages: [
        {
          role: 'system',
          content: '你是专业的A股市场分析师，擅长结合资金流向、板块轮动、研报推荐等多维度数据筛选投资机会。请严格基于数据给出推荐，不要输出JSON以外的任何内容。',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      stream: false,
      thinking: false,
      responseFormat: { type: 'json_object' },
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

  // 解析 JSON
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // 尝试从内容中提取 JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error('AI返回内容无法解析为JSON');
    }
  }

  const recommendations = parsed.recommendations || [];

  return {
    success: true,
    data: {
      recommendations,
      totalCount: recommendations.length,
      timestamp: context.timestamp,
      marketOverview: context.marketOverview,
    },
    provider: provider.name,
    model: provider.model,
  };
};

module.exports = {
  getAiScreenContext,
  runAiScreen,
};
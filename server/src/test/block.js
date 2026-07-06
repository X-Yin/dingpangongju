

// 千问
/**
 * 股票板块逐日分类分析（增强版）
 * 新增：每日市场情绪判断、板块角色变化追踪、涨跌广度分析
 */
function classifySectorBlocksDaily(rawData, windowSize = 5) {
  // ==================== Step 1: 数据预处理 ====================
  const sortedData = [...rawData].sort((a, b) => b.date - a.date);

  const allSectors = new Set();
  sortedData.forEach(day => {
    Object.keys(day.blocks).forEach(sector => allSectors.add(sector));
  });

  const outputDays = sortedData.slice(0, 10);

  // ==================== 辅助函数 ====================
  const avg = arr => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);

  const getRank = (dayData, sector) => {
    const entries = Object.entries(dayData.blocks).sort(([, a], [, b]) => b.avgChange - a.avgChange);
    const rank = entries.findIndex(([name]) => name === sector) + 1;
    return rank > 0 ? rank : entries.length;
  };

  // ---------- 当日市场广度数据提取 ----------
  const getMarketBreadth = (dayData) => {
    const changes = Object.values(dayData.blocks).map(b => b.avgChange);
    const upCount = changes.filter(v => v > 0).length;
    const downCount = changes.filter(v => v < 0).length;
    const flatCount = changes.filter(v => v === 0).length;
    const total = changes.length;
    const marketAvg = avg(changes);
    const maxChange = Math.max(...changes);
    const minChange = Math.min(...changes);
    const upRatio = total > 0 ? upCount / total : 0;
    // 涨幅>2%的板块数
    const strongUp = changes.filter(v => v > 2).length;
    // 跌幅>2%的板块数
    const strongDown = changes.filter(v => v < -2).length;
    return {
      upCount, downCount, flatCount, total,
      marketAvg: +marketAvg.toFixed(2),
      maxChange: +maxChange.toFixed(2),
      minChange: +minChange.toFixed(2),
      upRatio: +upRatio.toFixed(3),
      strongUp, strongDown,
    };
  };

  // ---------- 分类核心逻辑 ----------
  const classifySectors = (recentDays, priorDays, historicalDays, totalSectors) => {
    const topQ = totalSectors * 0.3;

    const result = { 主线: [], 支线: [], 掉队: [], 止跌企稳: [], 弱势: [] };
    const details = {};

    allSectors.forEach(sector => {
      const recentChanges = recentDays.map(d => d.blocks[sector]?.avgChange).filter(v => v !== undefined);
      const priorChanges = priorDays.map(d => d.blocks[sector]?.avgChange).filter(v => v !== undefined);
      const historicalChanges = historicalDays.map(d => d.blocks[sector]?.avgChange).filter(v => v !== undefined);

      const recentAvg = avg(recentChanges);
      const priorAvg = avg(priorChanges);
      const momentum = recentAvg - priorAvg;
      const recentUpDays = recentChanges.filter(v => v > 0).length;
      const tenDayAvg = avg([...recentChanges, ...priorChanges]);

      const recentRanks = recentDays.map(d => getRank(d, sector));
      const avgRecentRank = avg(recentRanks);
      const priorRanks = priorDays.map(d => getRank(d, sector));
      const avgPriorRank = avg(priorRanks);
      const rankImprovement = avgPriorRank - avgRecentRank;

      // ---- 主线 ----
      const isMainLine =
        recentAvg > 0.5 &&
        recentUpDays >= 3 &&
        avgRecentRank <= topQ + 2 &&
        momentum >= -0.5 &&
        tenDayAvg > 0;

      // ---- 掉队 ----
      const isLagging =
        priorAvg > 0 &&
        recentAvg < priorAvg - 1.5 &&
        momentum < -1.5 &&
        rankImprovement < -2;

      // ---- 止跌企稳 ----
      const isStabilizing =
        priorAvg < -0.5 &&
        momentum > 1.0 &&
        recentAvg > priorAvg &&
        (recentAvg > -0.5 || recentUpDays >= 3);

      // ---- 支线 ----
      const isBranchLine =
        recentAvg > 0 &&
        tenDayAvg > -0.5 &&
        !isMainLine && !isLagging && !isStabilizing &&
        (recentUpDays >= 2);

      let category;
      const reasons = [];

      if (isMainLine) {
        category = '主线';
        reasons.push(`近${windowSize}日均值+${recentAvg.toFixed(2)}%，上涨${recentUpDays}/${recentDays.length}天，排名第${avgRecentRank.toFixed(0)}`);
      } else if (isLagging) {
        category = '掉队';
        reasons.push(`前期+${priorAvg.toFixed(2)}%→近期${recentAvg.toFixed(2)}%，动量${momentum.toFixed(2)}%，排名${avgPriorRank.toFixed(0)}→${avgRecentRank.toFixed(0)}`);
      } else if (isStabilizing) {
        category = '止跌企稳';
        reasons.push(`前期${priorAvg.toFixed(2)}%→近期${recentAvg.toFixed(2)}%，动量+${momentum.toFixed(2)}%`);
      } else if (isBranchLine) {
        category = '支线';
        reasons.push(`近${windowSize}日均值+${recentAvg.toFixed(2)}%，上涨${recentUpDays}天，力度偏温和`);
      } else {
        category = '弱势';
        reasons.push(`近${windowSize}日均值${recentAvg.toFixed(2)}%，前期${priorAvg.toFixed(2)}%`);
      }

      result[category].push(sector);
      details[sector] = {
        category, recentAvg: +recentAvg.toFixed(2), priorAvg: +priorAvg.toFixed(2),
        momentum: +momentum.toFixed(2), reasons,
        avgRecentRank: +avgRecentRank.toFixed(1),
        avgPriorRank: +avgPriorRank.toFixed(1),
      };
    });

    Object.keys(result).forEach(cat => {
      result[cat].sort((a, b) => details[b].recentAvg - details[a].recentAvg);
    });

    return { result, details };
  };

  // ==================== Step 2: 逐日滑动窗口分类 ====================
  const dailyResults = [];

  outputDays.forEach((targetDay, idx) => {
    const recentEnd = idx + windowSize;
    const priorEnd = idx + 2 * windowSize;

    const recentSlice = sortedData.slice(idx, Math.min(recentEnd, sortedData.length));
    const priorSlice = sortedData.slice(recentEnd, Math.min(priorEnd, sortedData.length));
    const historicalSlice = sortedData.slice(priorEnd);

    if (recentSlice.length < 3) return;

    const { result, details } = classifySectors(recentSlice, priorSlice, historicalSlice, allSectors.size);
    const breadth = getMarketBreadth(targetDay);

    dailyResults.push({
      date: targetDay.date,
      breadth,
      windowInfo: {
        recentRange: `${recentSlice[recentSlice.length - 1].date} ~ ${recentSlice[0].date}（${recentSlice.length}天）`,
        priorRange: priorSlice.length
          ? `${priorSlice[priorSlice.length - 1].date} ~ ${priorSlice[0].date}（${priorSlice.length}天）`
          : '数据不足',
        historicalRange: historicalSlice.length
          ? `${historicalSlice[historicalSlice.length - 1].date} ~ ${historicalSlice[0].date}（${historicalSlice.length}天）`
          : '无',
      },
      classification: result,
      details,
    });
  });

  // ==================== Step 3: 逐日市场判断 & 板块动态 ====================
  dailyResults.forEach((dr, idx) => {
    const today = dr;
    const yesterday = idx < dailyResults.length - 1 ? dailyResults[idx + 1] : null;
    // 注意: dailyResults 是按日期从新到旧排列的，所以 idx+1 是"前一天"

    // ---- 3.1 板块角色变化（对比前一天） ----
    const changes = {
      新晋主线: [],    // 昨天不是主线，今天是
      退出主线: [],    // 昨天是主线，今天不是
      连续主线: [],    // 昨天和今天都是主线
      新晋掉队: [],    // 昨天不是掉队，今天是
      脱离掉队: [],    // 昨天是掉队，今天不是
      新晋止跌企稳: [],
      新晋支线: [],
    };

    if (yesterday) {
      const todayMain = new Set(today.classification['主线']);
      const yestMain = new Set(yesterday.classification['主线']);
      const todayLag = new Set(today.classification['掉队']);
      const yestLag = new Set(yesterday.classification['掉队']);
      const todayStab = new Set(today.classification['止跌企稳']);
      const yestStab = new Set(yesterday.classification['止跌企稳']);
      const todayBranch = new Set(today.classification['支线']);
      const yestBranch = new Set(yesterday.classification['支线']);

      todayMain.forEach(s => {
        if (yestMain.has(s)) changes['连续主线'].push(s);
        else changes['新晋主线'].push(s);
      });
      yestMain.forEach(s => {
        if (!todayMain.has(s)) changes['退出主线'].push(s);
      });
      todayLag.forEach(s => {
        if (!yestLag.has(s)) changes['新晋掉队'].push(s);
      });
      yestLag.forEach(s => {
        if (!todayLag.has(s)) changes['脱离掉队'].push(s);
      });
      todayStab.forEach(s => {
        if (!yestStab.has(s)) changes['新晋止跌企稳'].push(s);
      });
      todayBranch.forEach(s => {
        if (!yestBranch.has(s)) changes['新晋支线'].push(s);
      });
    }

    // ---- 3.2 市场情绪综合判断 ----
    const b = today.breadth;
    const mainCount = today.classification['主线'].length;
    const lagCount = today.classification['掉队'].length;
    const stabCount = today.classification['止跌企稳'].length;
    const branchCount = today.classification['支线'].length;
    const weakCount = today.classification['弱势'].length;
    const totalSectors = allSectors.size;

    // 主线数量变化
    const prevMainCount = yesterday ? yesterday.classification['主线'].length : null;
    const prevLagCount = yesterday ? yesterday.classification['掉队'].length : null;
    const mainCountDelta = prevMainCount !== null ? mainCount - prevMainCount : 0;
    const lagCountDelta = prevLagCount !== null ? lagCount - prevLagCount : 0;

    // 情绪评分 (0~100)
    let sentimentScore = 50;
    sentimentScore += (b.upRatio - 0.5) * 40;                    // 涨跌比贡献 ±20
    sentimentScore += (mainCount / totalSectors - 0.15) * 60;    // 主线占比贡献
    sentimentScore -= (lagCount / totalSectors) * 40;            // 掉队拖累
    sentimentScore += (stabCount / totalSectors) * 20;           // 企稳加分
    sentimentScore -= (b.strongDown / totalSectors) * 30;        // 大跌板块扣分
    sentimentScore += (b.strongUp / totalSectors) * 20;          // 大涨板块加分
    sentimentScore = Math.max(0, Math.min(100, Math.round(sentimentScore)));

    // 情绪标签
    let sentimentLabel = '';
    let sentimentEmoji = '';
    if (sentimentScore >= 80) {
      sentimentLabel = '大面积高潮';
      sentimentEmoji = '🔥';
    } else if (sentimentScore >= 65) {
      sentimentLabel = '偏强活跃';
      sentimentEmoji = '🟢';
    } else if (sentimentScore >= 50) {
      sentimentLabel = '温和震荡';
      sentimentEmoji = '🟡';
    } else if (sentimentScore >= 35) {
      sentimentLabel = '偏弱分化';
      sentimentEmoji = '🟠';
    } else if (sentimentScore >= 20) {
      sentimentLabel = '退潮萎缩';
      sentimentEmoji = '🔻';
    } else {
      sentimentLabel = '冰点恐慌';
      sentimentEmoji = '🧊';
    }

    // ---- 3.3 生成文字摘要 ----
    const summaryLines = [];

    // 情绪总览
    summaryLines.push(
      `${sentimentEmoji} 市场情绪：【${sentimentLabel}】（评分 ${sentimentScore}/100）` +
      `  涨${b.upCount}/跌${b.downCount}/平${b.flatCount}  ` +
      `板块均值${b.marketAvg > 0 ? '+' : ''}${b.marketAvg}%`
    );

    // 主线变化
    if (changes['新晋主线'].length > 0) {
      summaryLines.push(`🆕 新晋主线：${changes['新晋主线'].join('、')} — 关注持续性`);
    }
    if (changes['退出主线'].length > 0) {
      summaryLines.push(`⚠️ 退出主线：${changes['退出主线'].join('、')} — 注意高位风险`);
    }
    if (changes['连续主线'].length > 0) {
      summaryLines.push(`👑 连续主线：${changes['连续主线'].join('、')} — 核心方向不变`);
    }

    // 掉队变化
    if (changes['新晋掉队'].length > 0) {
      summaryLines.push(`💀 新晋掉队：${changes['新晋掉队'].join('、')} — 资金撤离，回避`);
    }
    if (changes['脱离掉队'].length > 0) {
      summaryLines.push(`♻️ 脱离掉队：${changes['脱离掉队'].join('、')} — 最坏阶段或已过`);
    }

    // 止跌企稳
    if (changes['新晋止跌企稳'].length > 0) {
      summaryLines.push(`🌱 新晋止跌企稳：${changes['新晋止跌企稳'].join('、')} — 左侧关注`);
    }

    // 支线
    if (changes['新晋支线'].length > 0) {
      summaryLines.push(`🔸 新晋支线：${changes['新晋支线'].join('、')} — 观察能否升级为主线`);
    }

    // 综合研判
    const judgments = [];
    if (mainCountDelta > 0 && lagCountDelta <= 0) {
      judgments.push('主线扩容，赚钱效应扩散');
    } else if (mainCountDelta > 0 && lagCountDelta > 0) {
      judgments.push('主线扩容但掉队增多，市场分化加剧');
    } else if (mainCountDelta < 0 && lagCountDelta > 0) {
      judgments.push('主线收缩+掉队扩大，退潮信号明显');
    } else if (mainCountDelta < 0 && lagCountDelta <= 0) {
      judgments.push('主线收缩但掉队未扩散，高位分化');
    }

    if (b.strongDown >= totalSectors * 0.3) {
      judgments.push('大面积杀跌，大面退潮！控制仓位');
    }
    if (b.strongUp >= totalSectors * 0.4) {
      judgments.push('大面积强势上攻，普涨高潮！注意追高风险');
    }
    if (stabCount >= totalSectors * 0.25 && mainCount <= 2) {
      judgments.push('大量板块止跌企稳但主线稀缺，底部震荡蓄势');
    }
    if (weakCount >= totalSectors * 0.6) {
      judgments.push('超过六成板块弱势，市场极度低迷');
    }
    if (changes['新晋主线'].length >= 3) {
      judgments.push('多板块同时新晋主线，可能迎来新一轮行情');
    }
    if (changes['退出主线'].length >= 3) {
      judgments.push('多板块同时退出主线，旧周期瓦解，等待新方向');
    }

    if (judgments.length > 0) {
      summaryLines.push(`📋 综合研判：${judgments.join('；')}`);
    }

    dr.marketJudgment = {
      sentimentScore,
      sentimentLabel,
      sentimentEmoji,
      changes,
      mainCountDelta,
      lagCountDelta,
      summaryLines,
    };
  });

  // ==================== Step 4: 板块演变轨迹 ====================
  const sectorTrajectory = {};
  allSectors.forEach(sector => {
    sectorTrajectory[sector] = dailyResults.map(dr => ({
      date: dr.date,
      category: dr.details[sector].category,
    }));
  });

  // ==================== Step 5: 构建最终输出 ====================
  return {
    analysisInfo: {
      totalDays: sortedData.length,
      outputDays: outputDays.map(d => d.date),
      windowSize,
      totalSectors: allSectors.size,
      sectors: [...allSectors],
    },
    dailyResults,
    sectorTrajectory,
  };
}


function test() {
    const data = require('../data/block_data_day_history.json');
    const result = classifySectorBlocksDaily(data);
    const fs = require('fs');
    fs.writeFileSync('./result.json', JSON.stringify(result, null,2));
}

test();
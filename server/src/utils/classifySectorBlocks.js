// 板块分类工具：将板块按"主线 / 轮动 / 退潮"三类进行逐日滑动窗口分类
// - 主线：近期涨幅稳定靠前、动能为正、上涨天数过半的强势板块
// - 轮动：处于过渡状态，动能震荡、排名中段的板块（既非持续强势也非持续退潮）
// - 退潮：近期持续走弱、排名下滑、动能为负的板块

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
    const strongUp = changes.filter(v => v > 2).length;
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

  // ---------- 分类核心逻辑（3 类） ----------
  const classifySectors = (recentDays, priorDays, historicalDays, totalSectors) => {
    const topQ = Math.max(1, totalSectors * 0.3);   // 前 30% 视为头部
    const bottomQ = Math.max(1, totalSectors * 0.5); // 后 50% 视为尾部
    const halfWindow = Math.ceil(recentDays.length / 2);

    const result = { 主线: [], 轮动: [], 退潮: [] };
    const details = {};

    allSectors.forEach(sector => {
      const recentChanges = recentDays.map(d => d.blocks[sector]?.avgChange).filter(v => v !== undefined);
      const priorChanges = priorDays.map(d => d.blocks[sector]?.avgChange).filter(v => v !== undefined);

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

      // ---- 主线：稳定强势、排名靠前、动能非负、上涨天数过半 ----
      const isMainLine =
        recentAvg > 0.3 &&
        recentUpDays >= halfWindow &&
        avgRecentRank <= topQ + 1 &&
        momentum >= -0.5 &&
        tenDayAvg > 0;

      // ---- 退潮：持续走弱、排名下滑、动能为负、近期均值转负 ----
      const isEbbing =
        (recentAvg < -0.3 && momentum < 0.3) ||
        (momentum < -1.0 && rankImprovement < -1) ||
        (recentAvg < priorAvg - 1.0 && avgRecentRank >= bottomQ);

      let category;
      const reasons = [];

      if (isMainLine) {
        category = '主线';
        reasons.push(`近${windowSize}日均值+${recentAvg.toFixed(2)}%，上涨${recentUpDays}/${recentDays.length}天，排名第${avgRecentRank.toFixed(0)}`);
      } else if (isEbbing) {
        category = '退潮';
        reasons.push(`近${windowSize}日均值${recentAvg.toFixed(2)}%，动量${momentum.toFixed(2)}%，排名${avgPriorRank.toFixed(0)}→${avgRecentRank.toFixed(0)}`);
      } else {
        category = '轮动';
        reasons.push(`近${windowSize}日均值${recentAvg.toFixed(2)}%，动量${momentum.toFixed(2)}%，排名第${avgRecentRank.toFixed(0)}，处于过渡状态`);
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

    // ---- 3.1 板块角色变化（对比前一天） ----
    const changes = {
      新晋主线: [],
      退出主线: [],
      连续主线: [],
      新晋退潮: [],
      脱离退潮: [],
      新晋轮动: [],
    };

    if (yesterday) {
      const todayMain = new Set(today.classification['主线']);
      const yestMain = new Set(yesterday.classification['主线']);
      const todayEbb = new Set(today.classification['退潮']);
      const yestEbb = new Set(yesterday.classification['退潮']);
      const todayRot = new Set(today.classification['轮动']);
      const yestRot = new Set(yesterday.classification['轮动']);

      todayMain.forEach(s => {
        if (yestMain.has(s)) changes['连续主线'].push(s);
        else changes['新晋主线'].push(s);
      });
      yestMain.forEach(s => {
        if (!todayMain.has(s)) changes['退出主线'].push(s);
      });
      todayEbb.forEach(s => {
        if (!yestEbb.has(s)) changes['新晋退潮'].push(s);
      });
      yestEbb.forEach(s => {
        if (!todayEbb.has(s)) changes['脱离退潮'].push(s);
      });
      todayRot.forEach(s => {
        if (!yestRot.has(s)) changes['新晋轮动'].push(s);
      });
    }

    // ---- 3.2 市场情绪综合判断 ----
    const b = today.breadth;
    const mainCount = today.classification['主线'].length;
    const ebbCount = today.classification['退潮'].length;
    const rotCount = today.classification['轮动'].length;
    const totalSectors = allSectors.size;

    const prevMainCount = yesterday ? yesterday.classification['主线'].length : null;
    const prevEbbCount = yesterday ? yesterday.classification['退潮'].length : null;
    const mainCountDelta = prevMainCount !== null ? mainCount - prevMainCount : 0;
    const ebbCountDelta = prevEbbCount !== null ? ebbCount - prevEbbCount : 0;

    // 情绪评分 (0~100)
    let sentimentScore = 50;
    sentimentScore += (b.upRatio - 0.5) * 40;                    // 涨跌比贡献 ±20
    sentimentScore += (mainCount / totalSectors - 0.15) * 60;    // 主线占比贡献
    sentimentScore -= (ebbCount / totalSectors) * 40;            // 退潮拖累
    sentimentScore += (rotCount / totalSectors) * 10;            // 轮动小幅加分（市场有活跃度）
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

    summaryLines.push(
      `${sentimentEmoji} 市场情绪：【${sentimentLabel}】（评分 ${sentimentScore}/100）` +
      `  涨${b.upCount}/跌${b.downCount}/平${b.flatCount}  ` +
      `板块均值${b.marketAvg > 0 ? '+' : ''}${b.marketAvg}%`
    );

    if (changes['新晋主线'].length > 0) {
      summaryLines.push(`🆕 新晋主线：${changes['新晋主线'].join('、')} — 关注持续性`);
    }
    if (changes['退出主线'].length > 0) {
      summaryLines.push(`⚠️ 退出主线：${changes['退出主线'].join('、')} — 注意高位风险`);
    }
    if (changes['连续主线'].length > 0) {
      summaryLines.push(`👑 连续主线：${changes['连续主线'].join('、')} — 核心方向不变`);
    }

    if (changes['新晋退潮'].length > 0) {
      summaryLines.push(`💀 新晋退潮：${changes['新晋退潮'].join('、')} — 资金撤离，回避`);
    }
    if (changes['脱离退潮'].length > 0) {
      summaryLines.push(`♻️ 脱离退潮：${changes['脱离退潮'].join('、')} — 最坏阶段或已过`);
    }

    if (changes['新晋轮动'].length > 0) {
      summaryLines.push(`🌀 新晋轮动：${changes['新晋轮动'].join('、')} — 观察能否升级为主线`);
    }

    // 综合研判
    const judgments = [];
    if (mainCountDelta > 0 && ebbCountDelta <= 0) {
      judgments.push('主线扩容，赚钱效应扩散');
    } else if (mainCountDelta > 0 && ebbCountDelta > 0) {
      judgments.push('主线扩容但退潮增多，市场分化加剧');
    } else if (mainCountDelta < 0 && ebbCountDelta > 0) {
      judgments.push('主线收缩+退潮扩大，退潮信号明显');
    } else if (mainCountDelta < 0 && ebbCountDelta <= 0) {
      judgments.push('主线收缩但退潮未扩散，高位分化');
    }

    if (b.strongDown >= totalSectors * 0.3) {
      judgments.push('大面积杀跌，大面退潮！控制仓位');
    }
    if (b.strongUp >= totalSectors * 0.4) {
      judgments.push('大面积强势上攻，普涨高潮！注意追高风险');
    }
    if (rotCount >= totalSectors * 0.5 && mainCount <= 2) {
      judgments.push('过半板块处于轮动状态且主线稀缺，市场缺乏方向');
    }
    if (ebbCount >= totalSectors * 0.6) {
      judgments.push('超过六成板块退潮，市场极度低迷');
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
      ebbCountDelta,
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

exports.classifySectorBlocksDaily = classifySectorBlocksDaily;

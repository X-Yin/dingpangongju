import { useMemo } from 'react';

/**
 * 根据科技情绪数据生成交易建议的 Hook
 * @param {Array} techIndexData 科技情绪数据数组
 * @returns {Object|null} 建议对象 { message, description, type }
 */
export const useEmotionSuggestion = (techIndexData) => {
  return useMemo(() => {
    if (!techIndexData || techIndexData.length === 0) return null;

    const latestTechData = techIndexData[techIndexData.length - 1];
    const techEmotion = parseFloat(latestTechData.changeSumResult) || 0;
    
    // 检查是否连续两天情绪大于 100
    const prevTechData = techIndexData.length > 1 ? techIndexData[techIndexData.length - 2] : null;
    const prevTechEmotion = prevTechData ? parseFloat(prevTechData.changeSumResult) : 0;
    
    const isContinuousHigh = techEmotion > 100 && prevTechEmotion > 100;
    const isContinuousNegative = techEmotion < 0 && prevTechEmotion < 0;

    if (isContinuousHigh) {
      return {
        message: '🚨 连续高潮风险预警：科技情绪已连续两天超过 100',
        description: '千万不能调仓换股！此时风险远远大于机会。建议要么空仓等待，要么持股观望。若次日冲高应果断减仓，绝对不能出手，随时可能出现开盘大幅度兑现或冲高回落。',
        type: 'error'
      };
    }

    if (isContinuousNegative) {
      return {
        message: '🔥 连续冰点修复预警：科技情绪已连续两天为负',
        description: '市场情绪极度低迷后蕴含转机。次日如果竞价抢筹高开，并且开盘后高举高打，可以考虑果断全仓出手博弈反弹。',
        type: 'success'
      };
    }

    if (techEmotion > 140) {
      return {
        message: '⚠️ 科技情绪过热预警：科技情绪已超过 140',
        description: '次日回调风险较大，防止冲高回落，次日冲高适合减仓观望。完全不适合出手博弈',
        type: 'error'
      };
    } else if (techEmotion < -100) {
      return {
        message: '🚀 科技情绪修复预期：科技情绪低于 -100',
        description: '次日修复的概率极大，第二天找竞价抢筹，并且开盘高举高打，表现强势的龙头，开盘可以全仓出手。',
        type: 'success'
      };
    } else if (techEmotion < 0 && techEmotion >= -100) {
      return {
        message: '科技情绪略微低迷：当前科技情绪介于 -100 到 0 之间',
        description: '次日有一定修复概率，但是也有继续下探的风险，如果次日竞价抢筹，并且高举高打，可以考虑全仓出手。如果次日开盘继续往下砸，就不适合出手',
        type: 'success'
      };
    } else {
      return {
        message: '🔎 科技情绪混沌期：当前情绪处于 0 到 140 之间',
        description: '当前科技情绪处于略微高潮期，当前建议保持之前的持仓耐心持股，如果要调仓换股，建议最多半仓出手，因为随时会有冲高回落的风险',
        type: 'info'
      };
    }
  }, [techIndexData]);
};

const { loadTrainingCampData, getTrainingCampDates, calcDailyMaInfo, getKlineCached } = require('../trainingCamp');
const { getSingleStockTlineDataByDate, getSingleStockTlineDataByDateLean, clearTlineMemCache } = require('../stock');
const { calculateResilience, getLimitTypeByCode } = require('../stockDiagnose');
const { isStockInWatchlistAt, getMonitorStocks } = require('../monitorStock');
const { batchParallel } = require('../../utils');
const { getKeyBlockConstituents, getKeyBlockTagMap, ensureKeyBlockBars, ensureBarsForCodes, stockWindowGain, stockWindowRangePct, getStockCloseOnOrBefore, getHistoricalLianbanDefenseStocks, scanAllLianbanCodesInRange, getHongliMultiLianbanStocks, scanHongliMultiLianbanCodesInRange, getLeaderPool, hasRecentVolumeSurge, getPastTradingDates, getRecentMultiLianbanStocks, getRecentMultiLianbanOccurrences, stockVolumeRatio, stockPriorAvgVolume, stockVolumeRatioAt, getTopLianbanBoardStocks, stockDailyChange, getBoardCountAtDate } = require('../keyBlockData');
const { loadIndexKline } = require('../sentimentHotMoney');
const { isOscExcluded, runWithOscExclude } = require('../backtestOscContext');
const { getSimContext, isSimStock, runWithSimContext } = require('../backtestSimContext');
const { getAllTechIndexData } = require('../emotion');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');

module.exports = {
  loadTrainingCampData, getTrainingCampDates, calcDailyMaInfo, getKlineCached,
  getSingleStockTlineDataByDate, getSingleStockTlineDataByDateLean, clearTlineMemCache,
  calculateResilience, getLimitTypeByCode,
  isStockInWatchlistAt, getMonitorStocks,
  batchParallel,
  getKeyBlockConstituents, getKeyBlockTagMap, ensureKeyBlockBars, ensureBarsForCodes, stockWindowGain, stockWindowRangePct, getStockCloseOnOrBefore, getHistoricalLianbanDefenseStocks, scanAllLianbanCodesInRange, getHongliMultiLianbanStocks, scanHongliMultiLianbanCodesInRange, getLeaderPool, hasRecentVolumeSurge, getPastTradingDates, getRecentMultiLianbanStocks, getRecentMultiLianbanOccurrences, stockVolumeRatio, stockPriorAvgVolume, stockVolumeRatioAt, getTopLianbanBoardStocks, stockDailyChange, getBoardCountAtDate,
  loadIndexKline,
  isOscExcluded, runWithOscExclude,
  getSimContext, isSimStock, runWithSimContext,
  getAllTechIndexData,
  fs, path, dayjs,
};

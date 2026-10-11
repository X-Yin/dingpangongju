const { loadTrainingCampData, getTrainingCampDates, calcDailyMaInfo, getKlineCached } = require('../trainingCamp');
const { getSingleStockTlineDataByDate } = require('../stock');
const { calculateResilience, getLimitTypeByCode } = require('../stockDiagnose');
const { isStockInWatchlistAt, getMonitorStocks } = require('../monitorStock');
const { batchParallel } = require('../../utils');
const { getKeyBlockConstituents, getKeyBlockTagMap, ensureKeyBlockBars, ensureBarsForCodes, stockWindowGain, getStockCloseOnOrBefore, getHistoricalLianbanDefenseStocks, scanAllLianbanCodesInRange, getHongliMultiLianbanStocks, scanHongliMultiLianbanCodesInRange, getLeaderPool, hasRecentVolumeSurge } = require('../keyBlockData');
const { loadIndexKline } = require('../sentimentHotMoney');
const { isOscExcluded, runWithOscExclude } = require('../backtestOscContext');
const { getSimContext, isSimStock, runWithSimContext } = require('../backtestSimContext');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');

module.exports = {
  loadTrainingCampData, getTrainingCampDates, calcDailyMaInfo, getKlineCached,
  getSingleStockTlineDataByDate,
  calculateResilience, getLimitTypeByCode,
  isStockInWatchlistAt, getMonitorStocks,
  batchParallel,
  getKeyBlockConstituents, getKeyBlockTagMap, ensureKeyBlockBars, ensureBarsForCodes, stockWindowGain, getStockCloseOnOrBefore, getHistoricalLianbanDefenseStocks, scanAllLianbanCodesInRange, getHongliMultiLianbanStocks, scanHongliMultiLianbanCodesInRange, getLeaderPool, hasRecentVolumeSurge,
  loadIndexKline,
  isOscExcluded, runWithOscExclude,
  getSimContext, isSimStock, runWithSimContext,
  fs, path, dayjs,
};

const fs = require('fs');
const path = require('path');

const MARKET_RHYTHM_DATA_PATH = path.resolve(__dirname, '../data/marketRhythm.json');

const ensureDataFile = () => {
  if (!fs.existsSync(MARKET_RHYTHM_DATA_PATH)) {
    fs.writeFileSync(MARKET_RHYTHM_DATA_PATH, JSON.stringify(null), 'utf-8');
  }
};

const getMarketRhythmData = () => {
  ensureDataFile();
  const data = JSON.parse(fs.readFileSync(MARKET_RHYTHM_DATA_PATH, 'utf-8'));
  return data;
};

const writeMarketRhythmData = (data) => {
  ensureDataFile();
  fs.writeFileSync(MARKET_RHYTHM_DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
};

const updateMarketRhythmItem = (item) => {
  const newItem = {
    ...item,
    updatedAt: new Date().toISOString()
  };
  writeMarketRhythmData(newItem);
  return newItem;
};

module.exports = {
  getMarketRhythmData,
  updateMarketRhythmItem
};

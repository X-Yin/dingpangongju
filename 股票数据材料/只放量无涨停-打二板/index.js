const fs = require('fs');
const { isPotentialBullWashout } = require('./washout');

const md = JSON.parse(
  fs.readFileSync('闽东电力.json', 'utf8')
);
console.log('闽东电力', isPotentialBullWashout(md, 20260909)); // 预期 true

const ym = JSON.parse(
  fs.readFileSync('一鸣食品.json', 'utf8')
);
console.log('一鸣食品', isPotentialBullWashout(ym, 20260728)); // 预期 true

const cz = JSON.parse(
  fs.readFileSync('传智教育.json', 'utf8')
);
console.log('传智教育', isPotentialBullWashout(cz, 20260727)); // 预期 true

// 分辨市场主线和支线的服务
const fs = require('fs');
const path = require('path');

const marketMainLinePath = path.resolve(__dirname, '../data/marketMainLine.json');

/**
 * [{
  "blockName": "半导体",
  "stocks": [{
    "stockName": "拓荆科技",
    "change": 3.5,
    "code": "sh688123"
  }],
  "reason": "成为主线 or 支线的理由",
  "lineType": "main/branch"
}]
*/

const updateMainLine = (data) => {
    fs.writeFileSync(marketMainLinePath, JSON.stringify(data, null, 2));
};

const getMainLine = () => {
    return JSON.parse(fs.readFileSync(marketMainLinePath, 'utf8'));
};

exports.updateMainLine = updateMainLine;
exports.getMainLine = getMainLine;
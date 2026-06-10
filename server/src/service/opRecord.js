// 买卖操作记录服务
const fs = require('fs');
const path = require('path');

const opRecordPath = path.resolve(__dirname, '../data/opRecord.json');

// record: [{ date: '20260610', recordList: [{ stockName: '寒武纪', opType: 'sell or buy', time: '10:25', reason: '理由', thought: '反思' }] }]
const updateOpRecord = (record) => {
    fs.writeFileSync(opRecordPath, JSON.stringify(record, null, 2));
};

const getOpRecord = () => {
    return JSON.parse(fs.readFileSync(opRecordPath, 'utf8'));
};

exports.updateOpRecord = updateOpRecord;
exports.getOpRecord = getOpRecord;
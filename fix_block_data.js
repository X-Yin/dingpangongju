const fs = require('fs');
const path = require('path');

const dataPath = path.resolve(__dirname, 'server/src/data/block_data_day_history.json');

// 读取数据文件
const rawData = fs.readFileSync(dataPath, 'utf-8');
const blockDayHistory = JSON.parse(rawData);

// 处理和修复数据
const fixedData = [];
const seenDates = new Set();

// 倒序处理，保留最新的记录
for (let i = blockDayHistory.length - 1; i >= 0; i--) {
    const item = blockDayHistory[i];
    
    if (!item.date) continue;
    
    // 如果这个日期已经处理过了，跳过
    if (seenDates.has(item.date)) continue;
    seenDates.add(item.date);
    
    // 确定 blocks 数据
    let blocksData = item.blocks || item.blockData;
    
    // 转换为对象格式
    const blocksObj = {};
    if (Array.isArray(blocksData)) {
        // 数组格式转换为对象格式
        blocksData.forEach(b => {
            if (b.blockName) {
                blocksObj[b.blockName] = {
                    avgChange: b.avgChange
                };
            }
        });
    } else if (blocksData && typeof blocksData === 'object') {
        // 已经是对象格式，直接使用
        Object.assign(blocksObj, blocksData);
    }
    
    // 只保留有有效 blocks 数据的记录
    if (Object.keys(blocksObj).length > 0) {
        fixedData.unshift({
            date: item.date,
            blocks: blocksObj
        });
    }
}

// 保存修复后的数据
fs.writeFileSync(dataPath, JSON.stringify(fixedData, null, 2));

console.log('数据修复完成！');
console.log(`处理了 ${seenDates.size} 个日期的数据`);
console.log('修复后的数据已保存到:', dataPath);

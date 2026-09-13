const fs = require('fs');
const path = require('path');

// 删除竞价抢筹、开盘主动拉升、开盘持续下挫目录下的所有文件
const clearDirectories = () => {
    const directories = [
        path.resolve(__dirname, '../src/data/kaipanzhudong'),
        path.resolve(__dirname, '../src/data/jingjiaqiangchou'),
        path.resolve(__dirname, '../src/data/kaipanxiacuo')
    ];

    directories.forEach(dir => {
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            files.forEach(file => {
                const filePath = path.join(dir, file);
                // 确保只删除文件而非目录（如果需要递归删除目录可使用 fs.rmSync）
                if (fs.statSync(filePath).isFile()) {
                    fs.unlinkSync(filePath);
                }
            });
            console.log(`已成功清理目录: ${dir}`);
        } else {
            console.warn(`目录不存在，跳过清理: ${dir}`);
        }
    });

    // 清空 amount.json 文件
    fs.writeFileSync(path.resolve(__dirname, '../src/data/amount.json'), '[]');

    // 清空 jisuyidong.json 文件
    fs.writeFileSync(path.resolve(__dirname, '../src/data/jisuyidong.json'), '{}');
    // 清空 block_data_change_time.json 文件
    fs.writeFileSync(path.resolve(__dirname, '../src/data/block_data_change_time.json'), '[]');
    // 清空 blockMoneyChangeTime.json 文件
    fs.writeFileSync(path.resolve(__dirname, '../src/data/blockMoneyChangeTime.json'), '[]');
    // 清空 blockMoneyChange.json 文件
    fs.writeFileSync(path.resolve(__dirname, '../src/data/blockMoneyChange.json'), '[]');
    // 清空 monitor_alarms.json 文件
    fs.writeFileSync(path.resolve(__dirname, '../src/data/monitor_alarms.json'), '[]');
    // 清空 stock_position_fund_flow.json 文件
     fs.writeFileSync(path.resolve(__dirname, '../src/data/stock_position_fund_flow.json'), '{}');
     // 清空 stock_position_analysis.json 文件
     fs.writeFileSync(path.resolve(__dirname, '../src/data/stock_position_analysis.json'), '');
    // 清空 strategy_state.json 文件
    fs.writeFileSync(path.resolve(__dirname, '../src/data/strategy_state.json'), '{}');
    // 清空 strategy_records.json 文件
    fs.writeFileSync(path.resolve(__dirname, '../src/data/strategy_records.json'), '[]');
};

clearDirectories();

const fs = require('fs');
const path = require('path');

// 自选股全量股票过去分时数据目录
const DATA_DIR = path.resolve(__dirname, '../../自选股全量股票过去分时数据');

// 保留最近 N 天的数据
const KEEP_DAYS = 30;

// 计算截止日期（YYYYMMDD 数字格式），早于该日期的数据将被过滤掉
const now = new Date();
const cutoffDate = new Date(now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000);
const cutoff = Number(
    `${cutoffDate.getFullYear()}${String(cutoffDate.getMonth() + 1).padStart(2, '0')}${String(cutoffDate.getDate()).padStart(2, '0')}`
);

const cleanFile = (filePath) => {
    if (!fs.existsSync(filePath)) return null;

    let data;
    try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.warn(`  解析失败，跳过: ${path.basename(filePath)} (${e.message})`);
        return null;
    }

    if (!Array.isArray(data)) {
        console.warn(`  非数组格式，跳过: ${path.basename(filePath)}`);
        return null;
    }

    const before = data.length;
    const filtered = data.filter(item => {
        const tradeDate = typeof item?.trade_date === 'number' ? item.trade_date : Number(item?.trade_date);
        return !Number.isNaN(tradeDate) && tradeDate >= cutoff;
    });
    const after = filtered.length;

    if (after === before) return { name: path.basename(filePath), before, after, removed: 0 };

    // 写入临时文件后重命名，避免写入中断损坏数据
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(filtered));
    fs.renameSync(tmpPath, filePath);

    return { name: path.basename(filePath), before, after, removed: before - after };
};

const cleanDirectory = () => {
    if (!fs.existsSync(DATA_DIR)) {
        console.warn(`目录不存在，跳过: ${DATA_DIR}`);
        return;
    }

    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    console.log(`开始清理 ${files.length} 个股票分时数据文件，保留最近 ${KEEP_DAYS} 天（截止 ${cutoff}）...`);

    let totalRemoved = 0;
    let totalFiles = 0;

    files.forEach(file => {
        const result = cleanFile(path.join(DATA_DIR, file));
        if (result && result.removed > 0) {
            totalFiles++;
            totalRemoved += result.removed;
            console.log(`  ${result.name}: ${result.before} 天 → ${result.after} 天（移除 ${result.removed} 天）`);
        }
    });

    console.log(`清理完成：${totalFiles} 个文件被过滤，共移除 ${totalRemoved} 天的数据`);
};

cleanDirectory();

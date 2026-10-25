// 板块成交量占比轮询
// - 每 10 分钟计算一次各板块当日成交量占比，写入 src/data/block_volume_ratio_intraday.json
// - 默认仅在交易日的交易时段、且 10:00 之后执行（避开开盘初期成交量不稳定）
// - npm run block_amount_poll        常驻轮询
// - npm run block_amount_poll --now  立即执行一次（不判断交易日/时间），执行完退出
// - 追加 --all：强制走多平台轮询兜底（同花顺/财联社/新浪/东财/腾讯）
const dayjs = require('dayjs');
const { isTradingDay, isMiddayBreak, isAfterMarketClose } = require('./utils');
const { runAndSaveIntradayPoint } = require('./service/blockVolumeRatio');

const POLL_INTERVAL = 10 * 60 * 1000;
const CHECK_INTERVAL = 60 * 1000;
const START_MINUTE = 10 * 60; // 10:00 之后才开始

// npm 会把 `npm run xxx --now` 解析成 npm_config_now，因此两种方式都兼容
const NOW = process.argv.includes('--now')
    || String(process.env.npm_config_now || '').toLowerCase() === 'true';

// --all：跳过全 A 股实时行情，强制走多平台轮询兜底
const ALL = process.argv.includes('--all')
    || String(process.env.npm_config_all || '').toLowerCase() === 'true';

// 是否处于允许轮询的时段：交易日、非午休、未收盘、且已过 10:00
const isInPollWindow = (now = new Date()) => {
    if (!isTradingDay(now)) return false;
    if (isMiddayBreak(now) || isAfterMarketClose(now)) return false;
    return now.getHours() * 60 + now.getMinutes() >= START_MINUTE;
};

const formatTime = (date = new Date()) => dayjs(date).format('HH:mm:ss');

// 终端进度条：完成比例 + 当前时间 + 命中率（行情匹配率 / 临时缓存命中率）
const renderProgress = ({ done, total, hitRate, current, label }) => {
    const percent = total > 0 ? done / total : 0;
    const width = 24;
    const filled = Math.round(percent * width);
    const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
    const rateText = `${label || '命中率'} ${(hitRate * 100).toFixed(1)}% (${done}/${total})`;
    const line = `[${formatTime()}] ${bar} ${(percent * 100).toFixed(1).padStart(5)}% (${done}/${total}) ${rateText} 当前:${current}`;
    process.stdout.write(`\r${line}${' '.repeat(6)}`);
};

const runOnce = async () => {
    const startedAt = Date.now();
    console.log(`\n[${formatTime()}] 开始计算板块成交量占比...`);

    try {
        const { point, payload, stats } = await runAndSaveIntradayPoint({ onProgress: renderProgress, forcePolling: ALL });
        process.stdout.write('\n');

        const cost = ((Date.now() - startedAt) / 1000).toFixed(1);
        const ratioText = Object.entries(point.ratios)
            .filter(([, value]) => value !== null)
            .sort((a, b) => b[1] - a[1])
            .map(([name, value]) => `${name} ${value.toFixed(2)}%`)
            .join(' | ');

        console.log(`[${formatTime()}] 计算完成（${stats.mode === 'poll' ? '多平台轮询兜底' : '全 A 股实时行情'}），耗时 ${cost}s，全市场成交额 ${point.marketTotalAmount} 亿`);
        if (stats.mode === 'poll') {
            console.log(`兜底轮询目标交易日 ${stats.targetDate}，覆盖 ${stats.matched}/${stats.total} 条成分股`);
        }
        console.log(`占比: ${ratioText}`);
        console.log(`已写入分时缓存（${payload.points.length} 个时点）: ${payload.date}`);
        return true;
    } catch (error) {
        process.stdout.write('\n');
        console.error(`[${formatTime()}] 计算失败:`, error.message);
        return false;
    }
};

const main = async () => {
    console.log(`板块成交量占比轮询启动，间隔 ${POLL_INTERVAL / 60000} 分钟，${START_MINUTE / 60}:00 之后执行`);

    if (NOW) {
        console.log('--now 模式：忽略交易日与交易时段限制，立即执行一次');
        if (ALL) console.log('--all 模式：跳过全 A 股实时行情，强制走多平台轮询兜底');
        await runOnce();
        process.exit(0);
    }

    let lastRunAt = 0;

    const tick = async () => {
        const now = new Date();
        if (!isInPollWindow(now)) return;

        if (lastRunAt && Date.now() - lastRunAt < POLL_INTERVAL - 30 * 1000) return;

        lastRunAt = Date.now();
        await runOnce();
    };

    // 启动时若已在允许时段内，立即执行一次
    if (isInPollWindow(new Date())) {
        lastRunAt = Date.now();
        await runOnce();
    } else {
        console.log('当前不在允许执行的时段（交易日 10:00 之后），等待下一次检查...');
    }

    setInterval(tick, CHECK_INTERVAL);
};

main().catch((error) => {
    console.error('轮询进程异常退出:', error);
    process.exit(1);
});

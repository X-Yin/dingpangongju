// 板块成交量占比轮询
// - 每 5 分钟计算一次各板块当日成交量占比，写入 src/data/block_volume_ratio_intraday.json
// - 每次写完后触发一次即时情绪周期运算（与点击盯盘页情绪周期按钮同一套链路），
//   大盘情绪温度 ≥60 且板块全面高潮/一致加速时由后端 WS 推送共振提示
// - 默认仅在交易日的交易时段、且 9:30 开盘之后执行
// - npm run block_amount_poll        常驻轮询
// - npm run block_amount_poll --now  立即执行一次（不判断交易日/时间），执行完退出
// - 追加 --all：强制走多平台轮询兜底（同花顺/财联社）
const axios = require('axios');
const dayjs = require('dayjs');
const { isTradingDay, isMiddayBreak, isAfterMarketClose } = require('./utils');
const { runAndSaveIntradayPoint } = require('./service/blockVolumeRatio');

const POLL_INTERVAL = 5 * 60 * 1000;
const CHECK_INTERVAL = 60 * 1000;
const START_MINUTE = 9 * 60 + 30; // 9:30 开盘之后才开始
// 校验失败 / 请求失败时的重试：等待 10s 后强制重新拉取行情（不复用同一份异常快照）
const MAX_ATTEMPTS = 3;
const RETRY_DELAY = 10 * 1000;
// 后端服务端口（共振检查走服务端进程，才能通过 WS 广播到前端）
const SERVER_PORT = process.env.SERVER_PORT || 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// npm 会把 `npm run xxx --now` 解析成 npm_config_now，因此两种方式都兼容
const NOW = process.argv.includes('--now')
    || String(process.env.npm_config_now || '').toLowerCase() === 'true';

// --all：跳过全 A 股实时行情，强制走多平台轮询兜底
const ALL = process.argv.includes('--all')
    || String(process.env.npm_config_all || '').toLowerCase() === 'true';

// 是否处于允许轮询的时段：交易日、非午休、未收盘、且已过 9:30
const isInPollWindow = (now = new Date()) => {
    if (!isTradingDay(now)) return false;
    if (isMiddayBreak(now) || isAfterMarketClose(now)) return false;
    return now.getHours() * 60 + now.getMinutes() >= START_MINUTE;
};

const formatTime = (date = new Date()) => dayjs(date).format('HH:mm:ss');

// 终端进度条：完成比例 + 明细（已请求/匹配数量）
const renderProgress = ({ done, total, current, detail }) => {
    const percent = total > 0 ? done / total : 0;
    const width = 24;
    const filled = Math.round(percent * width);
    const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
    const detailText = detail ? ` ${detail}` : '';
    const line = `[${formatTime()}] ${bar} ${(percent * 100).toFixed(1).padStart(5)}% (${done}/${total})${detailText} 当前:${current}`;
    process.stdout.write(`\r${line}\x1b[K`);
};

// 触发服务端即时情绪周期运算：服务端进程内完成同花顺+财联社实时快照与四维立体重算，
// 满足共振条件时由服务端 WS 广播给前端弹窗（本进程无法直接广播）
const triggerEmotionResonanceCheck = async () => {
    try {
        const res = await axios.post(
            `http://127.0.0.1:${SERVER_PORT}/emotion_resonance/check`,
            {},
            { timeout: 60 * 1000 }
        );
        const d = res.data || {};
        const blocks = Array.isArray(d.blocks) ? d.blocks : [];
        if (blocks.length) {
            console.log(`[${formatTime()}] 情绪共振：大盘 ${d.marketTemperature}°，${blocks.map((b) => `${b.board} ${b.phase}`).join('、')}`);
        } else {
            console.log(`[${formatTime()}] 即时情绪周期：大盘 ${d.marketTemperature ?? '--'}°，未触发共振`);
        }
    } catch (error) {
        console.warn(`[${formatTime()}] 即时情绪周期运算失败：${error.message}`);
    }
};

const runOnce = async () => {
    const startedAt = Date.now();
    console.log(`\n[${formatTime()}] 开始计算板块成交量占比...`);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            const { point, payload, stats } = await runAndSaveIntradayPoint({
                onProgress: renderProgress,
                forcePolling: ALL,
            });
            process.stdout.write('\n');

            const cost = ((Date.now() - startedAt) / 1000).toFixed(1);
            const ratioText = Object.entries(point.ratios)
                .filter(([, value]) => value !== null)
                .sort((a, b) => b[1] - a[1])
                .map(([name, value]) => `${name} ${value.toFixed(2)}%`)
                .join(' | ');

            // 暂时注释：板块强度分时轮询（日收盘写入 block_strength_daily.json 的逻辑保留在 poll.js）
            // try {
            //     const { runAndSaveStrengthPoint } = require('./service/blockStrengthIntraday');
            //     await runAndSaveStrengthPoint();
            // } catch (strengthError) {
            //     console.warn(`[${formatTime()}] 计算板块强度分时失败：${strengthError.message}`);
            // }

            console.log(`[${formatTime()}] 计算完成（${stats.mode === 'poll' ? '多平台轮询兜底' : '同花顺全量行情'}），耗时 ${cost}s，全市场成交额 ${point.marketTotalAmount} 亿`);
            if (stats.mode === 'poll') {
                console.log(`兜底轮询目标交易日 ${stats.targetDate}，覆盖 ${stats.matched}/${stats.total} 条成分股`);
            }
            console.log(`占比: ${ratioText}`);
            console.log(`已写入分时缓存（${payload.points.length} 个时点）: ${payload.date}`);
            // 每次成交量占比写完后，顺带跑一次即时情绪周期共振检查
            await triggerEmotionResonanceCheck();
            return true;
        } catch (error) {
            process.stdout.write('\n');
            if (attempt < MAX_ATTEMPTS) {
                console.warn(`[${formatTime()}] 第 ${attempt} 次计算失败：${error.message}，${RETRY_DELAY / 1000}s 后重试`);
                await sleep(RETRY_DELAY);
            } else {
                console.error(`[${formatTime()}] 连续 ${MAX_ATTEMPTS} 次计算失败，本次跳过（不写入分时缓存，避免画出假突刺）：${error.message}`);
            }
        }
    }

    return false;
};

const main = async () => {
    const startText = `${String(Math.floor(START_MINUTE / 60)).padStart(2, '0')}:${String(START_MINUTE % 60).padStart(2, '0')}`;
    console.log(`板块成交量占比轮询启动，间隔 ${POLL_INTERVAL / 60000} 分钟，${startText} 之后执行`);

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
        console.log('当前不在允许执行的时段（交易日 09:30 之后），等待下一次检查...');
    }

    setInterval(tick, CHECK_INTERVAL);
};

main().catch((error) => {
    console.error('轮询进程异常退出:', error);
    process.exit(1);
});

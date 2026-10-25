// 多平台个股日K请求（板块成交量占比轮询兜底使用）
// - 同花顺 / 财联社：复用线上已有的 HTTP 请求逻辑
// - 东财 / 新浪 / 腾讯：通过 ak/api.py 的常驻 worker 批量获取（进程内复用 akshare）
// 统一返回 [{ date: 'YYYYMMDD', amount: 成交额(元), close: 收盘价 }]，按日期升序
const axios = require('axios');
const path = require('path');
const { spawn } = require('child_process');
const dayjs = require('dayjs');
const { getClsReqUrl } = require('../utils');
const { fetchStockKline } = require('./stockKlineCache');

const PYTHON_BIN = 'python3';
const AK_SCRIPT = path.resolve(__dirname, '../../../ak/api.py');
const WORKER_TIMEOUT = 60 * 1000;

// 平台标识 → 展示名称
const PLATFORM_NAMES = {
    ths: '同花顺',
    cls: '财联社',
    sina: '新浪',
    em: '东财',
    tx: '腾讯',
};

// python worker 负责的三种平台（东财接口用 6 位代码，新浪/腾讯需要市场前缀）
const PY_PLATFORMS = new Set(['sina', 'em', 'tx']);

const toPlainCode = (code) => String(code || '').trim().replace(/^[a-zA-Z]+/, '');

const toPrefixedCode = (code) => {
    const raw = String(code || '').trim();
    if (/^(sh|sz|bj)/i.test(raw)) return raw.toLowerCase();
    const plain = toPlainCode(raw);
    if (/^[69]/.test(plain)) return `sh${plain}`;
    if (/^[48]/.test(plain)) return `bj${plain}`;
    return `sz${plain}`;
};

// 把各平台返回的 K 线统一成 { date, amount, close } 并过滤脏数据
const normalizeRows = (rows) => (Array.isArray(rows) ? rows : [])
    .map((item) => {
        const date = String(item && item.date !== undefined ? item.date : '').replace(/-/g, '').slice(0, 8);
        const amount = Number(item && item.amount);
        const close = Number(item && item.close);
        if (date.length !== 8 || !/^\d{8}$/.test(date)) return null;
        return {
            date,
            amount: Number.isFinite(amount) ? amount : null,
            close: Number.isFinite(close) ? close : null,
        };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));

// 同花顺日K（线上已有逻辑）
const fetchThsKline = async (code, startDate) => {
    const rows = await fetchStockKline(toPlainCode(code), startDate);
    return normalizeRows(rows);
};

// 财联社日K（线上已有逻辑，代码需要 sh/sz 前缀）
const fetchClsKline = async (code, startDate) => {
    const limit = Math.min(Math.max(dayjs().diff(dayjs(startDate), 'day'), 10), 30);
    const resp = await axios.get(getClsReqUrl(toPrefixedCode(code), limit), { timeout: 15000 });
    const body = resp.data;
    if (!body || Number(body.code) !== 200 || !Array.isArray(body.data)) {
        throw new Error(`财联社日K返回异常: ${(body && body.msg) || 'unknown'}`);
    }
    return normalizeRows(body.data.map((item) => ({
        date: item.trade_date,
        amount: item.business_balance,
        close: item.close_px,
    })));
};

// 常驻 python worker：spawn 一次后通过 stdin/stdout 按行收发批量日K请求
class PythonKlineWorker {
    constructor(platform) {
        this.platform = platform;
        this.child = null;
        this.buffer = '';
        this.pending = new Map();
        this.seq = 0;
    }

    _start() {
        const child = spawn(PYTHON_BIN, [AK_SCRIPT, 'kline_worker'], {
            cwd: path.resolve(__dirname, '../../..'),
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.child = child;
        this.buffer = '';
        child.stdout.on('data', (chunk) => this._handleStdout(chunk.toString('utf-8')));
        child.stderr.on('data', () => { /* akshare 警告信息忽略 */ });
        child.on('error', () => {
            this.child = null;
            this._failAll('python 日K进程启动失败');
        });
        child.on('close', () => {
            this.child = null;
            this._failAll('python 日K进程已退出');
        });
    }

    _handleStdout(text) {
        this.buffer += text;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('{')) continue;

            let payload;
            try {
                payload = JSON.parse(trimmed);
            } catch (e) {
                continue;
            }

            const task = this.pending.get(payload.id);
            if (!task) continue;
            this.pending.delete(payload.id);
            clearTimeout(task.timer);

            if (payload.success) task.resolve(payload.data || {});
            else task.reject(new Error(payload.message || 'python 日K请求失败'));
        }
    }

    _failAll(message) {
        for (const task of this.pending.values()) {
            clearTimeout(task.timer);
            task.reject(new Error(message));
        }
        this.pending.clear();
    }

    request(symbols, startDate, endDate) {
        if (!this.child) this._start();

        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('python 日K请求超时'));
            }, WORKER_TIMEOUT);

            this.pending.set(id, { resolve, reject, timer });

            try {
                this.child.stdin.write(`${JSON.stringify({
                    id,
                    platform: this.platform,
                    symbols,
                    start_date: startDate,
                    end_date: endDate,
                })}\n`);
            } catch (error) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(error);
            }
        });
    }

    close() {
        this._failAll('python 日K worker 已关闭');
        if (this.child) {
            try {
                this.child.stdin.end();
                this.child.kill();
            } catch (e) {
                // ignore
            }
            this.child = null;
        }
    }
}

const pythonWorkers = {
    sina: new PythonKlineWorker('sina'),
    em: new PythonKlineWorker('eastmoney'),
    tx: new PythonKlineWorker('tencent'),
};

// 单只股票日K：主平台失败时由调用方再走兜底链
const fetchSingleKline = async (platform, code, startDate, endDate) => {
    if (platform === 'ths') return fetchThsKline(code, startDate);
    if (platform === 'cls') return fetchClsKline(code, startDate);

    const worker = pythonWorkers[platform];
    if (!worker) throw new Error(`未知平台: ${platform}`);

    const symbol = platform === 'em' ? toPlainCode(code) : toPrefixedCode(code);
    const data = await worker.request([symbol], startDate, endDate);
    return normalizeRows(data[symbol] || []);
};

// 批量日K：同平台一次请求，返回 Map(code → rows)
const fetchKlineBatch = async (platform, codes, startDate, endDate) => {
    const result = new Map();
    if (!codes || codes.length === 0) return result;

    if (PY_PLATFORMS.has(platform)) {
        const worker = pythonWorkers[platform];
        if (!worker) throw new Error(`未知平台: ${platform}`);

        const symbolOf = (code) => (platform === 'em' ? toPlainCode(code) : toPrefixedCode(code));
        const symbols = codes.map(symbolOf);
        const data = await worker.request(symbols, startDate, endDate);
        codes.forEach((code) => {
            result.set(code, normalizeRows(data[symbolOf(code)] || []));
        });
        return result;
    }

    const settled = await Promise.allSettled(
        codes.map((code) => fetchSingleKline(platform, code, startDate, endDate))
    );
    settled.forEach((item, index) => {
        result.set(codes[index], item.status === 'fulfilled' ? item.value : []);
    });
    return result;
};

const closeKlineWorkers = () => {
    Object.values(pythonWorkers).forEach((worker) => worker.close());
};

exports.PLATFORM_NAMES = PLATFORM_NAMES;
exports.PY_PLATFORMS = PY_PLATFORMS;
exports.fetchSingleKline = fetchSingleKline;
exports.fetchKlineBatch = fetchKlineBatch;
exports.closeKlineWorkers = closeKlineWorkers;

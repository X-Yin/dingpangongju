/**
 * 临时脚本：回填过去 N 个交易日的连板网「热点题材」连板数据
 *
 * 用法：
 *   node script/fetch-lianban-history.js          # 默认回填最近 50 个交易日，已存在的文件跳过
 *   node script/fetch-lianban-history.js 30       # 回填最近 30 个交易日
 *   node script/fetch-lianban-history.js 50 --force   # 已存在也重新抓取覆盖
 */
const fs = require('fs');
const dayjs = require('dayjs');
const { getRecentTradingDays } = require('../src/utils/tradingDay');
const { saveLianbanDay, lianbanFilePath } = require('../src/service/lianban');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const days = parseInt(args.find((a) => /^\d+$/.test(a)), 10) || 50;

  const dates = getRecentTradingDays(days);
  if (dates.length === 0) {
    console.log('未取到交易日，退出');
    return;
  }

  console.log(`[lianban-history] 准备回填 ${dates.length} 个交易日：${dayjs(dates[0]).format('YYYY-MM-DD')} ~ ${dayjs(dates[dates.length - 1]).format('YYYY-MM-DD')}（force=${force}）`);

  let ok = 0;
  let skip = 0;
  const failed = [];

  for (let i = 0; i < dates.length; i += 1) {
    const ymd = dayjs(dates[i]).format('YYYYMMDD');
    const dash = dayjs(dates[i]).format('YYYY-MM-DD');
    const file = lianbanFilePath(ymd);

    if (!force && fs.existsSync(file)) {
      skip += 1;
      console.log(`[${i + 1}/${dates.length}] ${dash} 已存在，跳过`);
      continue;
    }

    try {
      const data = await saveLianbanDay(dates[i]);
      ok += 1;
      console.log(`[${i + 1}/${dates.length}] ${dash} 抓取成功：${data.summary.themeCount} 个题材 / ${data.summary.totalCount} 只涨停（连板 ${data.summary.lianbanCount}）`);
    } catch (error) {
      failed.push({ date: dash, message: error.message });
      console.error(`[${i + 1}/${dates.length}] ${dash} 抓取失败：${error.message}`);
    }

    // 请求间隔（1.5~3s），避免触发站点浏览频率限制（最后一次不用等）
    if (i < dates.length - 1) {
      await sleep(1500 + Math.floor(Math.random() * 1500));
    }
  }

  console.log('--------------------------------------------------');
  console.log(`[lianban-history] 完成：成功 ${ok}，跳过 ${skip}，失败 ${failed.length}`);
  if (failed.length > 0) {
    console.log('失败明细：');
    failed.forEach((f) => console.log(`  ${f.date}: ${f.message}`));
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error('[lianban-history] 执行异常：', error);
  process.exit(1);
});

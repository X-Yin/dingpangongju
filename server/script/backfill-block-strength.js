// 回溯一级板块日强度（默认最近 30 个交易日）
// 用法：node script/backfill-block-strength.js [days]
// 数据写入 src/data/block_strength_daily.json
const { backfillDailyStrength } = require('../src/service/blockStrengthDaily');

const days = Number(process.argv[2]) || 30;

let lastLogAt = 0;
backfillDailyStrength({
  days,
  onProgress: (done, total) => {
    if (Date.now() - lastLogAt < 3000 && done < total) return;
    lastLogAt = Date.now();
    process.stdout.write(`\r拉取日K ${done}/${total}\x1b[K`);
  },
})
  .then((payload) => {
    process.stdout.write('\n');
    console.log(`回溯完成：${payload.blocks.length} 个板块，${payload.fromDate} ~ ${payload.toDate}`);
  })
  .catch((error) => {
    process.stdout.write('\n');
    console.error('回溯失败:', error.message);
    process.exit(1);
  });

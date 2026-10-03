// 临时验证脚本：完整回测 8.27-9.30 emoquick 策略，验证真分时口径下第二笔交易的选股与抗分歧门槛
const { runRangeBacktest } = require('../src/service/buySellBacktest.js');
(async () => {
  const r = await runRangeBacktest('20260827', '20260930', 'highest_3d_gain_emoquick', null, {});
  const trades = r?.trades || [];
  console.log('success:', r?.success, ' trades:', trades.length);
  trades.forEach(t => console.log(`[${t.seq}] ${t.code} ${t.stockName} 买入 ${t.buyDate} ${t.buyTime} @${t.buyPrice}（涨幅${t.buyChange}%）卖出 ${t.sellDate} ${t.sellTime} 收益 ${t.returnRate}% | ${t.sellReason?.substring(0, 60)}`));
  const t2 = trades[1];
  if (t2) {
    const rg = (t2.buyChecks || []).find(c => c.id === 'resilience_gate');
    console.log('\n=== 第二笔 resilience_gate ===');
    console.log('value:', rg?.value, '| reason:', (rg?.reason || '').substring(0, 260));
    (rg?.skippedStocks || []).slice(0, 8).forEach(s => console.log('  顺延:', JSON.stringify(s)));
  }
})().catch(e => { console.error('ERR', e); process.exit(1); });

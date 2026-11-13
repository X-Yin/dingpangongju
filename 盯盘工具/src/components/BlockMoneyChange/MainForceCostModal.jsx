import { useEffect, useMemo, useState } from 'react';
import { Modal, Spin, Empty, Tag, Typography, Descriptions, Space } from 'antd';
import axios from 'axios';
import { local_ip } from '../../constant';
import StockKLine from '../StockKLine';

const { Text } = Typography;

// 金额（元）→ 亿，保留两位
const formatYi = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)))
  ? '--'
  : `${(Number(v) / 1e8).toFixed(2)}亿`;
// 股数（股）→ 亿股
const formatSharesYi = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)))
  ? '--'
  : `${(Number(v) / 1e8).toFixed(3)}亿股`;

/**
 * 主力成本测算弹窗（历史资金折线图标题点击打开）
 * 思路：取板块内总市值最大的股票，用板块每日净流入/净流出作为主力当日买卖金额，
 * 买入价 = 当日涨幅一半的位置（昨收 × (1 + 涨幅/2)），卖出同理按跌幅一半的位置成交，
 * 最后得出两条成本线：
 *   持仓成本线 = 累计买入金额 / 累计买入股数（严格按持仓成本）
 *   摊薄成本线 = (累计买入 - 卖出回款) / 剩余持股（净投入摊薄）
 */
const MainForceCostModal = ({ visible, data, onClose }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const block = data?.block;
  const blockCode = data?.blockCode;
  // { date(YYYYMMDD): money(元) }：板块每日净流入
  const flowMap = useMemo(() => {
    const map = {};
    (data?.flows || []).forEach((f) => {
      if (f?.date) map[String(f.date)] = Number(f.money) || 0;
    });
    return map;
  }, [data]);

  useEffect(() => {
    if (!visible || !blockCode) return;
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      setResult(null);
      try {
        // 1) 板块内总市值最大的股票
        const capRes = await axios.get(`http://${local_ip}:3000/block_max_cap_stock`, {
          params: { blockCode, name: block },
          timeout: 15000,
        });
        const stock = capRes.data?.stock;
        if (!capRes.data?.success || !stock?.code) {
          throw new Error(capRes.data?.message || '未找到板块内最大市值股票');
        }
        // 2) 该股日 K（数据从新到旧）
        const kRes = await axios.get(`http://${local_ip}:3000/stock_data`, {
          params: { code: stock.code },
          timeout: 20000,
        });
        // 全量有效日 K。/stock_data 有财联社、同花顺两个数据源：财联社从旧到新、同花顺从新到旧，
        // 顺序不统一，这里按日期统一排成"从新到旧"，后续逻辑不依赖数据源顺序
        const allBarsDesc = (Array.isArray(kRes.data) ? kRes.data : [])
          .filter(k => k && k.trade_date && k.open_px != null && k.close_px != null)
          .sort((a, b) => String(b.trade_date).localeCompare(String(a.trade_date)));
        // 成本测算范围：仅所选筛选区间内有资金流的交易日
        let klineDesc = allBarsDesc.filter(k => flowMap && Object.keys(flowMap).length > 0
          ? String(k.trade_date) in flowMap
          : true);
        if (klineDesc.length === 0) throw new Error('所选时间范围内暂无该股 K 线数据');
        // K 线图展示：最近 50 个交易日
        const chartKline = allBarsDesc.slice(0, 50);

        // 3) 模拟主力买卖：时间从旧到新逐日推演
        const klineAsc = [...klineDesc].reverse();
        let buyAmount = 0;   // 累计买入金额（元）
        let buyShares = 0;   // 累计买入股数
        let sellAmount = 0;  // 累计卖出回款（元）
        let sellShares = 0;  // 累计卖出股数
        klineAsc.forEach((k, i) => {
          // 涨跌幅优先用 K 线自带的 change 字段（反推昨收，避免窗口首日无前收盘），
          // 缺失时回退用窗口内前一交易日收盘价计算
          const hasChange = typeof k.change === 'number' && Number.isFinite(k.change) && (100 + k.change) !== 0;
          let prevClose;
          let chg;
          if (hasChange) {
            chg = k.change / 100;
            prevClose = Number(k.close_px) / (1 + chg);
          } else {
            prevClose = i > 0 ? Number(klineAsc[i - 1].close_px) : Number(k.open_px);
            if (!(prevClose > 0)) return;
            chg = (Number(k.close_px) - prevClose) / prevClose;
          }
          if (!(prevClose > 0)) return;
          // 成交价：当日涨（跌）幅一半的位置
          const tradePrice = prevClose * (1 + chg / 2);
          const flow = flowMap[String(k.trade_date)] ?? 0;
          if (flow > 0 && tradePrice > 0) {
            buyAmount += flow;
            buyShares += flow / tradePrice;
          } else if (flow < 0 && tradePrice > 0) {
            sellAmount += -flow;
            sellShares += (-flow) / tradePrice;
          }
        });
        const remainShares = buyShares - sellShares;
        const holdCost = buyShares > 0 ? buyAmount / buyShares : null;         // 持仓成本线
        const diluteCost = remainShares > 0 ? (buyAmount - sellAmount) / remainShares : null; // 摊薄成本线
        // 最新价：K 线数据从新到旧，第一条即最新收盘价
        const latestPrice = chartKline.length > 0 ? Number(chartKline[0].close_px) : null;
        // 主力盈亏 =（最新价 − 摊薄成本）× 剩余持股
        const profitAmount = (Number.isFinite(latestPrice) && Number.isFinite(diluteCost))
          ? (latestPrice - diluteCost) * remainShares
          : null;
        const profitPct = (Number.isFinite(latestPrice) && diluteCost > 0)
          ? ((latestPrice / diluteCost) - 1) * 100
          : null;

        if (alive) {
          setResult({
            stock,
            kline: chartKline,
            stats: {
              buyAmount, buyShares, sellAmount, sellShares, remainShares, holdCost, diluteCost,
              netInvest: buyAmount - sellAmount, latestPrice, profitAmount, profitPct,
            },
          });
        }
      } catch (e) {
        console.error('主力成本测算失败:', e);
        if (alive) setError(e.message || '主力成本测算失败');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [visible, block, blockCode, flowMap]);

  // 已清仓判定：
  // ① 区间板块资金为净流出 → 直接视为已清仓
  // ② 资金净流入时，持仓市值（剩余持股 × 最新价）≥ 20 亿才展示成本线和收益，否则也视为已清仓
  const flowSum = useMemo(
    () => (data?.flows || []).reduce((s, f) => s + (Number(f.money) || 0), 0),
    [data],
  );
  const holdingsValue = (result?.stats && Number.isFinite(result.stats.latestPrice))
    ? result.stats.remainShares * result.stats.latestPrice
    : 0;
  const isClearedOut = !result?.stats || flowSum < 0 || holdingsValue < 20e8;
  const priceLines = useMemo(() => {
    if (!result?.stats || isClearedOut) return [];
    if (Number.isFinite(result.stats.diluteCost)) {
      return [{ price: result.stats.diluteCost, color: '#9333ea', title: '摊薄成本' }];
    }
    return [];
  }, [result, isClearedOut]);

  return (
    <Modal
      title={`${block || ''} - 板块最大市值股主力成本测算`}
      open={visible}
      onCancel={onClose}
      footer={null}
      width={1200}
      centered
      destroyOnClose
    >
      {loading ? (
        <div style={{ height: 420, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spin tip="正在拉取板块最大市值股并测算主力成本..." size="large" />
        </div>
      ) : error ? (
        <Empty description={error} style={{ padding: '60px 0' }} />
      ) : result ? (
        <>
          <div style={{ marginBottom: 12 }}>
            <Descriptions
              size="small"
              column={3}
              items={[
                {
                  key: 'stock',
                  label: '最大市值股',
                  children: (
                    <Space size={6}>
                      <Text strong>{result.stock.name}</Text>
                      <Text type="secondary">{result.stock.code}</Text>
                      {result.stock.marketCap != null && (
                        <Tag color="purple">总市值 {formatYi(result.stock.marketCap)}</Tag>
                      )}
                    </Space>
                  ),
                },
                {
                  key: 'buy',
                  label: '累计买入 / 卖出',
                  children: `${formatYi(result.stats.buyAmount)} / ${formatYi(result.stats.sellAmount)}`,
                },
                {
                  key: 'shares',
                  label: '剩余持股',
                  children: isClearedOut
                    ? <Tag color="default">已清仓</Tag>
                    : `${formatSharesYi(result.stats.remainShares)}（净投入 ${formatYi(result.stats.netInvest)}）`,
                },
                // 资金净流出或持仓市值不足 20 亿视为已清仓，不再展示成本线与收益
                ...(isClearedOut ? [] : [
                  {
                    key: 'diluteCost',
                    label: '摊薄成本线',
                    children: (
                      <Space size={8}>
                        <Text strong style={{ color: '#9333ea' }}>
                          {result.stats.diluteCost != null ? `¥${result.stats.diluteCost.toFixed(2)}` : '--'}
                        </Text>
                        <Text type="secondary">最新价</Text>
                        <Text strong>
                          {result.stats.latestPrice != null ? `¥${result.stats.latestPrice.toFixed(2)}` : '--'}
                        </Text>
                      </Space>
                    ),
                  },
                  {
                    key: 'profit',
                    label: '主力盈亏',
                    children: (
                      <Text strong style={{ color: result.stats.profitAmount == null ? undefined : (result.stats.profitAmount >= 0 ? '#e11d48' : '#059669') }}>
                        {result.stats.profitAmount != null
                          ? `${result.stats.profitAmount >= 0 ? '+' : '−'}${formatYi(Math.abs(result.stats.profitAmount))}`
                          : '--'}
                        {result.stats.profitPct != null && (
                          <span style={{ marginLeft: 6, fontWeight: 400 }}>
                            （{result.stats.profitPct >= 0 ? '+' : '−'}{Math.abs(result.stats.profitPct).toFixed(2)}%）
                          </span>
                        )}
                      </Text>
                    ),
                  },
                ]),
              ]}
            />
            <div style={{ marginTop: 4, fontSize: 12, color: '#94a3b8' }}>
              测算口径：以板块每日净流入额作为主力当日买入金额、净流出额作为卖出金额；成交价取当日涨（跌）幅一半的位置（昨收 × (1 ± 涨跌幅/2)）。
              摊薄成本线 =（累计买入 − 卖出回款）÷ 剩余持股。
            </div>
          </div>
          <StockKLine data={result.kline} height={460} priceLines={priceLines} />
        </>
      ) : null}
    </Modal>
  );
};

export default MainForceCostModal;

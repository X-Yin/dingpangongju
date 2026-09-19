import { useState, useEffect, useRef } from 'react';
import { Drawer, Select, Tag, Empty, Spin, message } from 'antd';
import { SwapOutlined } from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../../../constant';
import StockKLine from '../../../../components/StockKLine';

// 两个对照指数（与回放页口径一致：创业板指数 sz399006 / 科创指数 sh000688）
const INDEX_DEFS = [
  { code: 'sz399006', name: '创业板指数' },
  { code: 'sh000688', name: '科创指数' },
];

// 个股指数对照抽屉：上方创业板/科创板日K对照，下方自选股多选后按三列展示个股日K
const StockIndexCompareDrawer = ({ open, onClose, stockOptions = [] }) => {
  const [indexData, setIndexData] = useState({}); // code -> 日K数组
  const [indexLoading, setIndexLoading] = useState(false);
  const [selectedCodes, setSelectedCodes] = useState([]);
  const [stockData, setStockData] = useState({}); // code -> 日K数组（含缓存）
  const [loadingCodes, setLoadingCodes] = useState([]);
  // 已拉取的个股日K缓存：取消再重新选中时无需重复请求
  const klineCacheRef = useRef({});

  // 打开抽屉时拉取创业板/科创板指数日K
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const run = async () => {
      try {
        setIndexLoading(true);
        const r = await axios.post(`http://${local_ip}:3000/data_center/indexes_kline`, {
          codes: INDEX_DEFS.map(i => i.code),
          limit: 100,
        });
        if (cancelled) return;
        setIndexData(r.data?.data || {});
      } catch {
        if (!cancelled) message.error('获取指数K线数据失败');
      } finally {
        if (!cancelled) setIndexLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 选中股票变化时增量拉取日K（带缓存）
  useEffect(() => {
    if (!open) return;
    const missing = selectedCodes.filter(code => klineCacheRef.current[code] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    const run = async () => {
      try {
        setLoadingCodes(missing);
        const r = await axios.post(`http://${local_ip}:3000/data_center/stocks_kline`, { codes: missing, limit: 100 });
        if (cancelled) return;
        const data = r.data?.data || {};
        missing.forEach(code => {
          const arr = Array.isArray(data[code]) ? data[code] : [];
          klineCacheRef.current[code] = arr;
        });
        setStockData({ ...klineCacheRef.current });
      } catch {
        if (cancelled) return;
        message.error('获取个股K线数据失败');
        // 失败的股票缓存为空数组，避免死循环重试
        missing.forEach(code => {
          klineCacheRef.current[code] = [];
        });
        setStockData({ ...klineCacheRef.current });
      } finally {
        if (!cancelled) setLoadingCodes([]);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [open, selectedCodes]);

  const nameOf = (code) => {
    const s = (stockOptions || []).find(item => item.code === code);
    return s ? `${s.name}` : code;
  };

  const removeCode = (code) => setSelectedCodes(prev => prev.filter(c => c !== code));

  const cardBoxShadow = '0 1px 4px rgba(18,33,58,0.06)';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="70%"
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SwapOutlined style={{ color: '#1677ff' }} />
          <span style={{ fontSize: 15, fontWeight: 700, color: '#12213a' }}>个股指数对照</span>
        </div>
      }
      styles={{ body: { padding: 16, background: '#f7f9fc', overflow: 'auto' } }}
    >
      {/* 第一行：创业板 + 科创板 K线图，平分宽度 */}
      <div style={{ display: 'flex', gap: 12 }}>
        {INDEX_DEFS.map(idx => {
          const kline = Array.isArray(indexData[idx.code]) ? indexData[idx.code] : [];
          return (
            <div key={idx.code} style={{ flex: 1, minWidth: 0, background: '#fff', borderRadius: 12, padding: 12, boxShadow: cardBoxShadow }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: '#12213a' }}>{idx.name}</span>
                <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: "'SF Mono', monospace" }}>{idx.code}</span>
              </div>
              {indexLoading ? (
                <div style={{ height: 360, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Spin />
                </div>
              ) : kline.length > 0 ? (
                <StockKLine data={kline} height={360} />
              ) : (
                <div style={{ height: 360, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Empty description="暂无指数K线数据" />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 自选股多选 */}
      <div style={{ background: '#fff', borderRadius: 12, padding: 12, marginTop: 12, boxShadow: cardBoxShadow }}>
        <Select
          mode="multiple"
          value={selectedCodes}
          onChange={setSelectedCodes}
          placeholder="选择自选股（可多选）"
          style={{ width: '100%' }}
          maxTagCount={0}
          maxTagPlaceholder={omitted => `已选 ${omitted.length} 只`}
          showSearch
          optionFilterProp="label"
          allowClear
          options={(stockOptions || []).map(s => ({ label: `${s.name}（${s.code}）`, value: s.code }))}
        />
        {/* 已选股票以 tag 展示，右上角 x 可取消选中 */}
        {selectedCodes.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {selectedCodes.map(code => (
              <Tag
                key={code}
                closable
                onClose={() => removeCode(code)}
                style={{ display: 'flex', alignItems: 'center', gap: 4, marginInlineEnd: 0 }}
              >
                {nameOf(code)}
                <span style={{ color: '#9ca3af', fontSize: 11, fontFamily: "'SF Mono', monospace" }}>{code}</span>
              </Tag>
            ))}
          </div>
        )}
      </div>

      {/* 选中的股票按一行两列展示 K 线图 */}
      {selectedCodes.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginTop: 12 }}>
          {selectedCodes.map(code => {
            const kline = Array.isArray(stockData[code]) ? stockData[code] : [];
            const loading = loadingCodes.includes(code);
            return (
              <div key={code} style={{ background: '#fff', borderRadius: 12, padding: 12, boxShadow: cardBoxShadow }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#12213a' }}>{nameOf(code)}</span>
                  <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: "'SF Mono', monospace" }}>{code}</span>
                </div>
                {loading ? (
                  <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Spin />
                  </div>
                ) : kline.length > 0 ? (
                  <StockKLine data={kline} height={300} />
                ) : (
                  <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Empty description="暂无K线数据" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Drawer>
  );
};

export default StockIndexCompareDrawer;

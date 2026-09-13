import { useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Spin, Table, Tag, Space, message } from 'antd';
import { ReloadOutlined, RiseOutlined, CopyOutlined } from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../constant';
import { getThemeColor } from '../../utils/theme';

/**
 * 复制文本到剪贴板（带降级方案，与 data_center 模块一致）
 */
const copyToClipboard = async (text) => {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    // 降级到 execCommand
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch (e) {
    return false;
  }
};

/**
 * 趋势诊断
 * 取全部自选股最近 20 日涨幅前 30，默认筛出最新一日未跌破 10 日线者
 */
const TrendDiagnosisTab = ({ onStockClick }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [copying, setCopying] = useState(false);

  const fetchTrend = async (forceRefresh = false) => {
    setLoading(true);
    setError('');
    try {
      const query = forceRefresh ? '?refresh=1' : '';
      const res = await axios.get(`http://${local_ip}:3000/trend_diagnosis${query}`);
      if (res.data?.success) {
        setData(res.data.data || null);
      } else {
        setError(res.data?.message || '趋势诊断加载失败');
        message.error(res.data?.message || '趋势诊断加载失败');
      }
    } catch (err) {
      console.error('趋势诊断失败:', err);
      const msg = err?.response?.data?.message || err.message || '趋势诊断加载失败';
      setError(msg);
      message.error(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTrend();
  }, []);

  const topGainers = data?.topGainers || [];
  const filtered = data?.filtered || [];

  const handleCopyContext = async () => {
    if (!filtered.length) {
      message.warning('当前没有筛选结果可复制');
      return;
    }
    setCopying(true);
    try {
      const reportRes = await axios.get(`http://${local_ip}:3000/research_reports_context?folders=30`);
      const folders = reportRes.data?.data?.folders || [];
      const totalReports = reportRes.data?.data?.totalReports || 0;

      const lines = [];
      lines.push('## 趋势诊断结果');
      lines.push('');
      lines.push('以下为自选股最近 20 日涨幅前 30 名中最新一日未跌破 10 日线的股票（按 20 日涨幅降序）：');
      lines.push('');
      lines.push('| 排名 | 股票名称 | 代码 | 20日涨幅 | 当日涨跌幅 | MA10斜率均值 | MA5 | MA10 | MA20 | 收盘距MA10 |');
      lines.push('|------|----------|------|----------|------------|--------------|-----|------|------|-----------|');
      filtered.forEach((item, idx) => {
        const fmtPct = (v) => (v == null ? '-' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
        const fmtPct3 = (v) => (v == null ? '-' : `${v > 0 ? '+' : ''}${v.toFixed(3)}%/日`);
        const fmtPrice = (v) => (v == null ? '-' : v.toFixed(2));
        let closeMa10 = '-';
        if (item.close != null && item.ma10 != null) {
          const diff = item.close - item.ma10;
          const pct = (diff / item.ma10) * 100;
          closeMa10 = `+${diff.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
        }
        lines.push(`| ${idx + 1} | ${item.stockName} | ${item.code} | ${fmtPct(item.change20d)} | ${fmtPct(item.todayChange)} | ${fmtPct3(item.ma10SlopeAvg)} | ${fmtPrice(item.ma5)} | ${fmtPrice(item.ma10)} | ${fmtPrice(item.ma20)} | ${closeMa10} |`);
      });
      lines.push('');

      lines.push('## 最近 30 个交易日的研报资料');
      lines.push('');
      for (const folder of folders) {
        lines.push(`### ${folder.folderName}`);
        lines.push('');
        for (const report of folder.reports) {
          const tag = report.isImportant ? ' [重点]' : report.isPinned ? ' [置顶]' : '';
          lines.push(`#### ${report.name}${tag}`);
          lines.push('');
          lines.push(report.content || '(无内容)');
          lines.push('');
          lines.push('---');
          lines.push('');
        }
      }

      lines.push('## 提问词');
      lines.push('');
      lines.push('这些是筛选出来的最近涨幅前二十名 & 一直沿着 10 日线攀升的表现优异的股票。结合最近 30 天内的所有研报资料，分别分析一下为什么他们可以表现这么强势？有哪些新的逻辑变化值得机构去持续做趋势，未来的展望如何？将这些个股的逻辑强度（未来谁能涨的更远，涨的更持久）进行排序，分别打分，并且说明为什么');
      lines.push('');

      const text = lines.join('\n');
      const ok = await copyToClipboard(text);
      if (ok) {
        message.success(`已复制上下文（${filtered.length} 只股票 + ${totalReports} 篇研报）`);
      } else {
        message.error('剪贴板不可用，请手动复制');
      }
    } catch (err) {
      console.error('复制上下文失败:', err);
      const msg = err?.response?.data?.message || err.message || '复制上下文失败';
      message.error(msg);
    } finally {
      setCopying(false);
    }
  };

  const renderStockName = (text, record) => (
    <span
      className="stock-name clickable"
      onClick={() => onStockClick?.({ code: record.code, stockName: record.stockName })}
      style={{ fontWeight: 500, cursor: onStockClick ? 'pointer' : 'default', color: getThemeColor() }}
    >
      {text || '-'}
    </span>
  );

  const renderChange = (val) => {
    if (val == null) return '-';
    return (
      <span style={{ fontWeight: 600, color: val > 0 ? '#cf1322' : val < 0 ? '#389e0d' : '#8c8c8c' }}>
        {val > 0 ? '+' : ''}{val.toFixed(2)}%
      </span>
    );
  };

  const renderPrice = (val) => {
    if (val == null) return '-';
    return <span style={{ color: '#1a1a1a', fontWeight: 500 }}>{val.toFixed(2)}</span>;
  };

  const columns = [
    {
      title: '排名',
      key: 'rank',
      width: 60,
      align: 'center',
      render: (_, __, index) => (
        <span className={`rank-badge rank-${index < 3 ? 'top' : 'normal'}`}>
          {index + 1}
        </span>
      ),
    },
    {
      title: '股票名称',
      dataIndex: 'stockName',
      key: 'stockName',
      width: 130,
      render: renderStockName,
    },
    {
      title: '代码',
      dataIndex: 'code',
      key: 'code',
      width: 100,
      render: (text) => (
        <span style={{ color: '#595959', fontSize: '13px', fontFamily: 'monospace' }}>{text}</span>
      ),
    },
    {
      title: '20日涨幅',
      dataIndex: 'change20d',
      key: 'change20d',
      width: 110,
      align: 'right',
      sorter: (a, b) => (a.change20d ?? -9999) - (b.change20d ?? -9999),
      defaultSortOrder: 'descend',
      render: (val) => {
        if (val == null) return '-';
        const color = val > 0 ? '#cf1322' : val < 0 ? '#389e0d' : '#8c8c8c';
        return (
          <span style={{ fontWeight: 700, fontSize: 15, color }}>
            {val > 0 ? '+' : ''}{val.toFixed(2)}%
          </span>
        );
      },
    },
    {
      title: '当日涨跌幅',
      dataIndex: 'todayChange',
      key: 'todayChange',
      width: 110,
      align: 'right',
      sorter: (a, b) => (a.todayChange ?? -9999) - (b.todayChange ?? -9999),
      render: renderChange,
    },
    {
      title: 'MA10斜率均值',
      dataIndex: 'ma10SlopeAvg',
      key: 'ma10SlopeAvg',
      width: 130,
      align: 'right',
      sorter: (a, b) => (a.ma10SlopeAvg ?? -9999) - (b.ma10SlopeAvg ?? -9999),
      render: (val) => {
        if (val == null) return '-';
        const color = val > 0 ? '#cf1322' : val < 0 ? '#389e0d' : '#8c8c8c';
        return (
          <span style={{ fontWeight: 600, color }}>
            {val > 0 ? '+' : ''}{val.toFixed(3)}%/日
          </span>
        );
      },
    },
    {
      title: 'MA5',
      dataIndex: 'ma5',
      key: 'ma5',
      width: 90,
      align: 'right',
      render: renderPrice,
    },
    {
      title: 'MA10',
      dataIndex: 'ma10',
      key: 'ma10',
      width: 90,
      align: 'right',
      render: (val) => {
        if (val == null) return '-';
        return <span style={{ color: '#cf1322', fontWeight: 500 }}>{val.toFixed(2)}</span>;
      },
    },
    {
      title: 'MA20',
      dataIndex: 'ma20',
      key: 'ma20',
      width: 90,
      align: 'right',
      render: renderPrice,
    },
    {
      title: '收盘距MA10',
      key: 'closeMa10Diff',
      width: 110,
      align: 'right',
      sorter: (a, b) => {
        const da = a.close != null && a.ma10 != null ? a.close - a.ma10 : -Infinity;
        const db = b.close != null && b.ma10 != null ? b.close - b.ma10 : -Infinity;
        return da - db;
      },
      render: (_, record) => {
        if (record.close == null || record.ma10 == null) return '-';
        const diff = record.close - record.ma10;
        const pct = (diff / record.ma10) * 100;
        return (
          <span style={{ color: '#cf1322', fontWeight: 500 }}>
            +{diff.toFixed(2)} ({pct >= 0 ? '+' : ''}{pct.toFixed(2)}%)
          </span>
        );
      },
    },
  ];

  const toolbar = (
    <Card className="diagnosis-card backtest-toolbar-card" bordered={false}>
      <div className="backtest-toolbar">
        <Space>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            onClick={() => fetchTrend(true)}
            loading={loading}
            className="trade-primary-btn"
          >
            刷新诊断
          </Button>
          <Button
            icon={<CopyOutlined />}
            onClick={handleCopyContext}
            loading={copying}
            disabled={loading || !filtered.length}
            className="trade-secondary-btn"
          >
            复制上下文
          </Button>
          {!loading && data && (
            <span style={{ color: '#5b6b86', fontSize: 13 }}>
              共扫描 {data.totalScanned} 只自选股，{data.totalValid} 只有有效数据，取 20 日涨幅前 {data.topN}，筛出最新一日未跌破 10 日线 {filtered.length} 只
            </span>
          )}
        </Space>
        {!loading && data && filtered.length > 0 && (
          <Tag color="success">
            <RiseOutlined /> 筛选通过 {filtered.length} 只
          </Tag>
        )}
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginTop: 14, borderRadius: 12, border: '1px solid rgba(19, 194, 194, 0.2)' }}
        message="趋势诊断说明"
        description={
          <div style={{ fontSize: 12, lineHeight: 1.8, color: '#5b6b86' }}>
            <div><strong style={{ color: getThemeColor() }}>第一步</strong>：扫描全部自选股，按最近 <strong>20 个交易日</strong>涨幅降序，取前 <strong>30 名</strong>。</div>
            <div><strong style={{ color: getThemeColor() }}>第二步</strong>：在前 30 名中筛出「最新一日未跌破 10 日线」者 —— 最新收盘价 &gt; 最新 MA10。</div>
            <div><strong>MA10斜率均值</strong>列：最近 10 个交易日内 MA10 每日变化百分比的均值，越大代表 10 日线抬升越陡峭（红=上升、绿=下降）。<strong>收盘距MA10</strong>列：最新收盘价相对 MA10 的差值与百分比。点击列头可排序，点击股票名可查看 K 线。</div>
          </div>
        }
      />
    </Card>
  );

  if (error) {
    return (
      <div className="backtest-diagnosis-tab">
        {toolbar}
        <Alert
          type="error"
          showIcon
          message="趋势诊断失败"
          description={error}
          style={{ marginTop: 14, borderRadius: 12 }}
        />
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="backtest-diagnosis-tab">
        {toolbar}
        <Card className="diagnosis-card" bordered={false} style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '50px 0' }}>
            <Spin size="large" />
            <div style={{ marginTop: 14, color: '#7b8ba6', fontSize: 14, fontWeight: 500 }}>
              正在扫描自选股 20 日涨幅并计算 10 日线状态，请耐心等待...
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (!data || topGainers.length === 0) {
    return (
      <div className="backtest-diagnosis-tab">
        {toolbar}
        <Card className="diagnosis-card" bordered={false} style={{ marginTop: 14 }}>
          <Empty
            description="暂无趋势诊断数据，请点击「刷新诊断」"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ padding: '50px 0' }}
          />
        </Card>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="backtest-diagnosis-tab">
        {toolbar}
        <Card className="diagnosis-card" bordered={false} style={{ marginTop: 14 }}>
          <Empty
            description="前 30 名中所有股票最新一日已跌破 10 日线，可等待行情演进后再刷新"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ padding: '50px 0' }}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="backtest-diagnosis-tab">
      {toolbar}

      <Card
        className="diagnosis-card"
        bordered={false}
        style={{ marginTop: 14 }}
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <RiseOutlined style={{ color: getThemeColor() }} />
            <span style={{ fontWeight: 600 }}>
              20 日涨幅前 30 名中最新一日未跌破 10 日线（{filtered.length} 只）
            </span>
          </div>
        }
      >
        <div style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(18, 33, 58, 0.06)' }}>
          <Table
            columns={columns}
            dataSource={filtered}
            rowKey="code"
            size="middle"
            pagination={false}
            scroll={{ x: 1200 }}
          />
        </div>
      </Card>
    </div>
  );
};

export default TrendDiagnosisTab;

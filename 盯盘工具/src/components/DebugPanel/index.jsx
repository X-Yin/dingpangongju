import { useState, useEffect } from 'react';
import { Drawer, Card, Button, Space, Typography, message, InputNumber } from 'antd';
import {
  BugOutlined, SyncOutlined, CheckCircleFilled, WarningFilled, RocketOutlined, FallOutlined, ClockCircleOutlined,
  BulbOutlined,
} from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../constant';
import { sendRaw, subscribeDebugWs } from '../../utils/buyPointWs';

const { Text, Paragraph } = Typography;

// WS 双向自检间隔（每轮结束后等待 5s 再开始下一轮）
const WS_CHECK_INTERVAL_MS = 5000;
// 每轮等待双向完成的窗口（后端在收到前端 ping 后 1s 才推送）
const WS_ROUND_WINDOW_MS = 2500;

// 调试面板：右侧悬浮「debug」按钮（位于「看股」下方），点击打开抽屉
const DebugPanel = () => {
  const [pos] = useState({ x: window.innerWidth - 76, y: window.innerHeight / 2 - 28 + 100 + 80 + 64 });
  const [drawerOpen, setDrawerOpen] = useState(false);
  // WS 稳定性：testing | ok | error
  const [wsStatus, setWsStatus] = useState('testing');
  const [buyMocking, setBuyMocking] = useState(false);
  const [sellMocking, setSellMocking] = useState(false);
  const [iceMocking, setIceMocking] = useState(false);
  // 首板起爆 MOCK：auction_buy | burst_buy | sell
  const [fwbMocking, setFwbMocking] = useState(null);
  // 二板起爆 MOCK：buy | sell
  const [sbwMocking, setSbwMocking] = useState(null);

  // 意志力锻炼弹窗间隔（分钟）：默认 5，持久化到 localStorage
  const [willpowerInterval, setWillpowerInterval] = useState(() => {
    try {
      const raw = localStorage.getItem('willpower_interval_min');
      const n = raw ? parseInt(raw, 10) : 5;
      return (Number.isFinite(n) && n >= 1 && n <= 60) ? n : 5;
    } catch (_) { return 5; }
  });

  // 模块一：WS 双向对等自检
  //   每轮流程：前端发 debug_ping → 后端回 debug_pong（方向一）；
  //             1s 后后端主动推 debug_ping → 前端回 debug_pong → 后端回 debug_pong_ack（方向二）；
  //   两个方向都收到才算通过；每 5s 自动重复一轮。
  useEffect(() => {
    if (!drawerOpen) return undefined;
    let cancelled = false;
    const timers = [];
    let seq = 0;
    const schedule = (fn, delay) => {
      const t = setTimeout(fn, delay);
      timers.push(t);
      return t;
    };

    const runRound = () => {
      seq += 1;
      const cur = seq;
      const got = { pong: false, serverPing: false, ack: false };
      setWsStatus('testing');
      const unsub = subscribeDebugWs((msg) => {
        if (!msg || msg.seq !== cur) return;
        if (msg.type === 'debug_pong' && msg.src === 'server') got.pong = true;
        else if (msg.type === 'debug_ping' && msg.src === 'server') got.serverPing = true;
        else if (msg.type === 'debug_pong_ack') got.ack = true;
      });
      const startedAt = Date.now();
      // 连接可能尚未就绪，短间隔重试发送；发出后进入 2.5s 判定窗口
      const trySend = () => {
        if (cancelled) return;
        if (sendRaw({ type: 'debug_ping', seq: cur, src: 'client' })) {
          schedule(() => {
            unsub();
            if (cancelled) return;
            setWsStatus(got.pong && got.serverPing && got.ack ? 'ok' : 'error');
            schedule(runRound, WS_CHECK_INTERVAL_MS);
          }, WS_ROUND_WINDOW_MS);
        } else if (Date.now() - startedAt < 3000) {
          schedule(trySend, 250);
        } else {
          unsub();
          if (cancelled) return;
          setWsStatus('error');
          schedule(runRound, WS_CHECK_INTERVAL_MS);
        }
      };
      trySend();
    };

    // 第一秒开始第一次检测
    schedule(runRound, 1000);
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [drawerOpen]);

  const triggerMock = async (kind) => {
    const setLoading = kind === 'buy' ? setBuyMocking : setSellMocking;
    setLoading(true);
    try {
      const res = await axios.post(`http://${local_ip}:3000/debug/mock_${kind}_point`);
      const d = res.data;
      if (d?.success) {
        message.success(`已模拟${kind === 'buy' ? '买点' : '卖点'}命中：${d.target?.name}（${d.target?.code}）`);
      } else {
        message.error(d?.error || 'mock 触发失败');
      }
    } catch (e) {
      message.error(`mock 请求失败：${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  // 冰点转折延时观察 MOCK：只广播等待卡片，不发飞书、不影响真实延时状态
  const triggerIceMock = async () => {
    setIceMocking(true);
    try {
      const res = await axios.post(`http://${local_ip}:3000/debug/mock_ice_delay`);
      const d = res.data;
      if (d?.success) {
        message.success('已模拟冰点转折延时观察提示');
      } else {
        message.error(d?.error || 'mock 触发失败');
      }
    } catch (e) {
      message.error(`mock 请求失败：${e.message}`);
    } finally {
      setIceMocking(false);
    }
  };

  // 首板起爆 MOCK：与线上同一条 WS 推送 + 飞书链路（竞价买点 / 开盘 +8% 买点 / 卖点）
  const triggerFirstBoardWashMock = async (kind) => {
    if (fwbMocking) return;
    setFwbMocking(kind);
    const label = kind === 'auction_buy' ? '竞价买点' : (kind === 'burst_buy' ? '开盘买点（+8%）' : '卖点');
    try {
      const res = await axios.post(`http://${local_ip}:3000/debug/mock_first_board_wash_${kind}`);
      const d = res.data;
      if (d?.success) {
        message.success(`已模拟首板起爆${label}命中：${d.target?.name}（${d.target?.code}）`, 4);
      } else {
        message.error(d?.error || 'mock 触发失败');
      }
    } catch (e) {
      message.error(`mock 请求失败：${e.message}`);
    } finally {
      setFwbMocking(null);
    }
  };

  // 二板起爆 MOCK：与线上同一条 WS 推送 + 飞书链路（盘中 +8% 买点 / 卖点）
  const triggerSecondBoardWashMock = async (kind) => {
    if (sbwMocking) return;
    setSbwMocking(kind);
    const label = kind === 'buy' ? '买点' : '卖点';
    try {
      const res = await axios.post(`http://${local_ip}:3000/debug/mock_second_board_wash_${kind}`);
      const d = res.data;
      if (d?.success) {
        message.success(`已模拟二板起爆${label}命中：${d.target?.name}（${d.target?.code}）`, 4);
      } else {
        message.error(d?.error || 'mock 触发失败');
      }
    } catch (e) {
      message.error(`mock 请求失败：${e.message}`);
    } finally {
      setSbwMocking(null);
    }
  };

  const statusView = {
    testing: { color: '#1677ff', bg: 'rgba(22, 119, 255, 0.08)', icon: <SyncOutlined spin />, text: '正在检测 WS 服务稳定性…' },
    ok: { color: '#52c41a', bg: 'rgba(82, 196, 26, 0.10)', icon: <CheckCircleFilled />, text: 'WS 服务正常' },
    error: { color: '#ff4d4f', bg: 'rgba(255, 77, 79, 0.10)', icon: <WarningFilled />, text: 'WS 通信异常，请重启服务' },
  }[wsStatus] || {};

  return (
    <>
      <div
        className="floating-stock-viewer"
        style={{ left: pos.x, top: pos.y }}
        onClick={() => setDrawerOpen(true)}
      >
        <div className="fsv-content">
          <div className="fsv-icon-wrap">
            <BugOutlined className="fsv-icon" />
          </div>
          <span className="fsv-label">debug</span>
        </div>
      </div>

      <Drawer
        title={<span><BugOutlined style={{ color: '#fa8c16', marginRight: 8 }} />调试面板</span>}
        placement="right"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={560}
        className="debug-panel-drawer"
        destroyOnClose={false}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {/* 模块一：WS 服务稳定性 */}
          <Card size="small" title="1. WS 服务稳定性">
            <Paragraph type="secondary" style={{ marginBottom: 12, fontSize: 12 }}>
              每 5s 自动执行一次双向对等自检：前端发请求→后端响应，随后后端主动推送→前端响应；
              两个方向均正常才判定服务正常。
            </Paragraph>
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 14px', borderRadius: 8,
                color: statusView.color, background: statusView.bg,
                fontWeight: 600, fontSize: 14,
              }}
            >
              <span style={{ display: 'inline-flex', color: statusView.color }}>{statusView.icon}</span>
              <span>{statusView.text}</span>
            </div>
          </Card>

          {/* 模块二：买点诊断 MOCK */}
          <Card size="small" title="2. 买点诊断 Mock 卡片">
            <Paragraph type="secondary" style={{ marginBottom: 12, fontSize: 12 }}>
              从全量自选股随机取一只，模拟命中买点诊断：向后端推送 WS 消息（打开弹窗/抽屉）并发送飞书卡片，
              飞书卡片中会标注为 MOCK 测试。
            </Paragraph>
            <Button
              type="primary"
              icon={<RocketOutlined />}
              loading={buyMocking}
              onClick={() => triggerMock('buy')}
            >
              触发 Mock 买点命中
            </Button>
          </Card>

          {/* 模块三：卖点诊断 MOCK */}
          <Card size="small" title="3. 卖点诊断 Mock 卡片">
            <Paragraph type="secondary" style={{ marginBottom: 12, fontSize: 12 }}>
              优先从当前持仓随机取一仓（无持仓则从全量自选股随机取一只），模拟命中卖点诊断：
              向后端推送 WS 消息（打开弹窗/抽屉）并发送飞书卡片，飞书卡片中会标注为 MOCK 测试。
            </Paragraph>
            <Button
              type="primary"
              danger
              icon={<FallOutlined />}
              loading={sellMocking}
              onClick={() => triggerMock('sell')}
            >
              触发 Mock 卖点命中
            </Button>
          </Card>

          {/* 模块四：冰点转折延时触发 MOCK */}
          <Card size="small" title="4. 冰点转折延时触发">
            <Paragraph type="secondary" style={{ marginBottom: 12, fontSize: 12 }}>
              模拟冰点转折买点触发：向后端推送 WS 消息，打开全局「冰点转折 · 延时观察」提示卡片
              （含买点触发时间与 15 分钟后的计划买入时间）；仅展示等待提示，不发送飞书。
            </Paragraph>
            <Button
              type="primary"
              icon={<ClockCircleOutlined />}
              loading={iceMocking}
              onClick={triggerIceMock}
              style={{ background: '#d97706', borderColor: '#d97706' }}
            >
              触发冰点转折延时提示
            </Button>
          </Card>

          {/* 模块五：首板起爆 买点 / 卖点 MOCK */}
          <Card size="small" title="5. 首板起爆 买点 / 卖点 Mock">
            <Paragraph type="secondary" style={{ marginBottom: 12, fontSize: 12 }}>
              标的优先取自首板起爆候选股（非交易日 / 盘前取上一交易日候选），无候选则从全量自选股随机取一只。
              卡片中的买入时间与买入条件（竞价 ≥ 5% → 9:30 直接买入；9:30-9:40 分时 +8%、最多 1 次回落、起爆价 ≥ 平台高点 ×0.80）
              及卖出条件（跌破 5 日线、成本 -3% 连续 5 分钟 / -5% 立即、盘中 ≤ -9%、涨停次日收盘未涨停、次日竞价低开）
              均使用线上真实阈值；触发后通过 WS 推送并发送飞书。
            </Paragraph>
            <Space wrap>
              <Button
                type="primary"
                icon={<RocketOutlined />}
                loading={fwbMocking === 'auction_buy'}
                onClick={() => triggerFirstBoardWashMock('auction_buy')}
              >
                竞价买点诊断
              </Button>
              <Button
                type="primary"
                icon={<RocketOutlined />}
                loading={fwbMocking === 'burst_buy'}
                onClick={() => triggerFirstBoardWashMock('burst_buy')}
              >
                开盘买点诊断
              </Button>
              <Button
                danger
                icon={<FallOutlined />}
                loading={fwbMocking === 'sell'}
                onClick={() => triggerFirstBoardWashMock('sell')}
              >
                卖点诊断
              </Button>
            </Space>
          </Card>

          {/* 模块六：二板起爆 买点 / 卖点 MOCK */}
          <Card size="small" title="6. 二板起爆 买点 / 卖点 Mock">
            <Paragraph type="secondary" style={{ marginBottom: 12, fontSize: 12 }}>
              标的优先取自二板起爆候选股（非交易日 / 盘前取上一交易日候选），无候选则从全量自选股随机取一只。
              卡片中的买入条件（竞价必须高开、9:30-14:30 分时 +8% 首次触发）及卖出条件（跌破 5 日线、成本 -3% 连续 5 分钟 /
              -5% 立即、盘中 ≤ -9%、未拉开 +20% 前竞价低开 -3% → 9:30 卖出、收盘未涨停 → 收盘卖出）
              均使用线上真实阈值；触发后通过 WS 推送并发送飞书。
            </Paragraph>
            <Space wrap>
              <Button
                type="primary"
                icon={<RocketOutlined />}
                loading={sbwMocking === 'buy'}
                onClick={() => triggerSecondBoardWashMock('buy')}
              >
                买点诊断
              </Button>
              <Button
                danger
                icon={<FallOutlined />}
                loading={sbwMocking === 'sell'}
                onClick={() => triggerSecondBoardWashMock('sell')}
              >
                卖点诊断
              </Button>
            </Space>
          </Card>

          {/* 模块七：意志力锻炼弹窗手动触发 */}
          <Card size="small" title="7. 意志力锻炼弹窗">
            <Paragraph type="secondary" style={{ marginBottom: 12, fontSize: 12 }}>
              交易日交易时段（9:30-11:30、13:00-15:00）按设定间隔周期性弹出。
              支持自定义间隔（1-60 分钟），保存在 localStorage，应用重启后生效。
            </Paragraph>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <span style={{ fontSize: 13, color: '#595959' }}>弹出间隔：</span>
              <InputNumber
                min={1}
                max={60}
                step={1}
                value={willpowerInterval}
                onChange={(v) => { if (v != null) setWillpowerInterval(v); }}
                style={{ width: 100 }}
                suffix="分钟"
              />
              <Button
                type="primary"
                onClick={() => {
                  const n = willpowerInterval;
                  if (n < 1 || n > 60) { message.error('间隔需在 1 ~ 60 分钟之间'); return; }
                  localStorage.setItem('willpower_interval_min', String(n));
                  window.dispatchEvent(new CustomEvent('willpower-interval-changed'));
                  message.success(`已保存：每 ${n} 分钟弹出一次`);
                }}
              >
                保存设置
              </Button>
            </div>
            <Button
              type="primary"
              icon={<BulbOutlined />}
              onClick={() => window.dispatchEvent(new CustomEvent('willpower-modal-test'))}
              style={{ background: '#722ed1', borderColor: '#722ed1' }}
            >
              立即测试弹窗
            </Button>
          </Card>

          <Text type="secondary" style={{ fontSize: 12 }}>
            提示：MOCK 触发不受 5 分钟时间桶频控限制，点击即刻推送。
          </Text>
        </Space>
      </Drawer>
    </>
  );
};

export default DebugPanel;

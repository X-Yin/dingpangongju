import { useState, useEffect } from 'react';
import { Drawer, Card, Button, Space, Typography, message } from 'antd';
import {
  BugOutlined, SyncOutlined, CheckCircleFilled, WarningFilled, RocketOutlined, FallOutlined,
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

          <Text type="secondary" style={{ fontSize: 12 }}>
            提示：MOCK 触发不受 5 分钟时间桶频控限制，点击即刻推送。
          </Text>
        </Space>
      </Drawer>
    </>
  );
};

export default DebugPanel;

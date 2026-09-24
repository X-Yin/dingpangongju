import { useState } from 'react';
import { Modal, InputNumber, Typography, Button, Empty } from 'antd';
import { EyeInvisibleOutlined, UndoOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';

const { Text } = Typography;

// 暂时隐藏股票弹窗：设置隐藏的自然日天数，同时可查看/恢复已隐藏的股票
// openTs：父组件打开弹窗事件中记录的时间戳，用于计算剩余天数与过滤已过期记录
const TempHideStockModal = ({ open, openTs, onCancel, onOk, stock, hiddenStockMap, onUnhide }) => {
    const [days, setDays] = useState(7);
    // 渲染期状态重置（React 推荐模式）：每次打开弹窗时重置天数
    const [prevOpen, setPrevOpen] = useState(open);
    if (open !== prevOpen) {
        setPrevOpen(open);
        if (open) setDays(7);
    }

    // 隐藏 n 个自然日：含今天共 n 天，第 n+1 天 0 点起恢复显示
    const resumeDate = dayjs().startOf('day').add(Math.max(1, Math.floor(Number(days) || 1)), 'day').format('YYYY-MM-DD');

    const hiddenEntries = Object.entries(hiddenStockMap || {})
        .map(([code, entry]) => ({ code, ...entry }))
        .filter((item) => Number(item.until) > openTs)
        .sort((a, b) => a.until - b.until);

    const remainingDays = (until) => Math.max(1, Math.ceil((Number(until) - openTs) / 86400000));

    return (
        <Modal
            title={<span><EyeInvisibleOutlined style={{ marginRight: 8 }} />暂时隐藏股票</span>}
            open={open}
            onCancel={onCancel}
            width={420}
            centered
            footer={
                [
                    <Button key="cancel" onClick={onCancel}>取消</Button>,
                    <Button key="ok" type="primary" disabled={!stock} onClick={() => onOk(days)}>确认隐藏</Button>,
                ]
            }
        >
            <div style={{ marginBottom: 16 }}>
                <Text type="secondary" style={{ fontSize: 13 }}>股票</Text>
                <div style={{ marginTop: 4, fontSize: 14, fontWeight: 500 }}>
                    {stock ? `${stock.stockName || ''}（${stock.code}）` : '--'}
                </div>
            </div>
            <div style={{ marginBottom: 8 }}>
                <Text type="secondary" style={{ fontSize: 13 }}>隐藏时长（自然日）</Text>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <InputNumber
                    min={1}
                    max={365}
                    precision={0}
                    value={days}
                    onChange={(v) => setDays(v)}
                    style={{ width: 120 }}
                />
                <span style={{ fontSize: 13 }}>天</span>
                <Text type="secondary" style={{ fontSize: 12 }}>
                    至 {resumeDate} 起自动恢复显示
                </Text>
            </div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 16 }}>
                隐藏期间仅不在自选股全量监控、个股幅度异动、自选股涨跌幅前十中显示，其他模块与科技情绪指数计算仍会包含该股票。
            </Text>

            <div style={{ borderTop: '1px solid rgba(60, 60, 67, 0.1)', paddingTop: 12 }}>
                <Text type="secondary" style={{ fontSize: 13 }}>当前已隐藏（{hiddenEntries.length}）</Text>
                {hiddenEntries.length === 0 ? (
                    <Empty description="暂无隐藏股票" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ margin: '12px 0' }} />
                ) : (
                    <div style={{ marginTop: 8, maxHeight: 180, overflowY: 'auto' }}>
                        {hiddenEntries.map((item) => (
                            <div
                                key={item.code}
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0' }}
                            >
                                <div style={{ fontSize: 13 }}>
                                    <span style={{ fontWeight: 500 }}>{item.name}</span>
                                    <Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>
                                        剩余 {remainingDays(item.until)} 天
                                    </Text>
                                </div>
                                <Button
                                    size="small"
                                    icon={<UndoOutlined />}
                                    onClick={() => onUnhide(item.code)}
                                >
                                    恢复显示
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </Modal>
    );
};

export default TempHideStockModal;

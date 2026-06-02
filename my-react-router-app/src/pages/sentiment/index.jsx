import React, { useEffect, useState } from 'react';
import { Card, Typography, Space, Row, Col, Spin, Empty, Tag } from 'antd';
import axios from 'axios';
import { local_ip } from '../../constant';
import StockKLine from '../../components/StockKLine';
import './index.scss';

const { Title, Text } = Typography;

const INDEX_CONFIG = [
    { code: 'sh000001', name: '上证指数' },
    { code: 'sz399001', name: '深证成指' },
    { code: 'sz399006', name: '创业板指' },
    { code: 'sh000688', name: '科创50' },
];

const Sentiment = () => {
    const [indexData, setIndexData] = useState({});
    const [loading, setLoading] = useState(true);
    
    // 写一个函数去分析所有的指数数据，判断依据如下：

    const analyzeIndexData = (klineData) => {
        if (!klineData || klineData.length < 10) {
            return { status: '数据不足', desc: '数据不足，无法分析情绪', color: '#999' };
        }

        // 5 日线字段是 ma5_px，10 日线字段是 ma10_px
        // 计算 5 日线和 10 日线交点最近的那个日期
        const lastCrossDate = klineData.find((item, idx) => {
            return item.ma5_px > item.ma10_px && (idx === 0 || item.ma5_px < klineData[idx - 1].ma5_px);
        })?.trade_date || '';

        if (!lastCrossDate) {
            return { status: '数据不足', desc: '找不到 5 日线和 10 日线的交点，数据不足，无法分析情绪', color: '#999' };
        }

        // 计算最近一天的 5 日线的斜率
        const lastDay5 = klineData[klineData.length - 1].ma5_px;
        const lastDay10 = klineData[klineData.length - 1].ma10_px;
        const lastDay5Slope = (lastDay5 - klineData[klineData.length - 2].ma5_px) / 10;
        // diffDays 从当前日期向交点日期的天数差，在数组里面找交点日期的索引，然后用数组的减去当前日期的索引，就是天数差
       const diffDays = klineData.length - klineData.findIndex((item) => item.trade_date === lastCrossDate) - 1;
        console.log(diffDays, lastDay5Slope, lastCrossDate);

        // 如果 5 日线在上，10 日线在下，并且 5 日线的斜率为正，并且当前日期距离交点的日期在  1-3 天之内，说明处于情绪初期，适合重仓猛干
        if (diffDays >= 1 && diffDays <= 3 && lastDay5Slope > 0 && lastDay10 < lastDay5) {
            return { status: '情绪初期', desc: '当前情绪为初期，适合重仓猛干', color: '#009933' };
        }

        // 如果 5 日线在上，10 日线在下，并且 5 日线的斜率为负，并且当前日期距离交点的日期在 3-5 天，说明处于情绪临近高潮期，适合保持持仓，或者稍微降低一下仓位
        if (diffDays >= 3 && diffDays <= 5 && lastDay5Slope < 0 && lastDay10 < lastDay5) {
            return { status: '情绪临近高潮期', desc: '当前情绪为临近高潮期，适合保持持仓，或者稍微降低一下仓位', color: '#FF9900' };
        }

        // 如果 5 日线在上，10 日线在下，并且 5 日线的斜率为正，并且当前日期距离交点的日期在 5 天以上，说明处于情绪高潮火热期，适合减仓，因为此时随时会监管降温，高管减持，国家队卖出沪深 300 压指数
        if (diffDays > 5 && lastDay5Slope > 0 && lastDay10 < lastDay5) {
            return { status: '情绪高潮火热期', desc: '当前情绪为高潮火热期，适合减仓到 5-6 成仓位，因为此时随时会出现监管降温，高管减持，国家队卖出沪深 300 压指数等操作', color: '#FF3333' };
        }

        // 如果 5 日线在上，10 日线在下，并且 5 日线的斜率为负，并且当前日期距离交点的日期在 1-3 天，说明处于情绪退潮初期，适合空仓
        if (diffDays >= 1 && diffDays <= 3 && lastDay5Slope < 0 && lastDay10 < lastDay5) {
            return { status: '情绪退潮初期', desc: '当前情绪为退潮初期，适合空仓', color: '#FF3333' };
        }

        // 如果 5 日线在下，10 日线在上，并且 5 日线的斜率为负，并且当前日期距离交点的日期在 3-5 天，说明处于情绪退潮末期，适合轻仓低吸强势股，但是切忌不能追高
        if (diffDays >= 3 && diffDays <= 5 && lastDay5Slope > 0 && lastDay10 > lastDay5) {
            return { status: '情绪退潮期', desc: '当前情绪为退潮期，适合轻仓低吸强势股，但是切忌不能追高', color: '#FF9900' };
        }

        // 如果 5 日线在下，10 日线在上，并且 5 日线的斜率为负，并且当前日期距离交点的日期在 5 天以上，说明处于情绪低谷期，也是适合轻仓低吸强势股，但是切忌不能追高
        if (diffDays > 5 && lastDay5Slope < 0 && lastDay10 > lastDay5) {
            return { status: '情绪低谷期', desc: '当前情绪为低谷期，适合轻仓低吸强势股，但是切忌不能追高', color: '#FF3333' };
        }

        return { status: '情绪混沌期', desc: '当前情绪为混沌期，适合轻仓低吸强势股，但是切忌不能追高，随时准备等待大盘放量大阳线的主升', color: '#FF3333' };

    };



    const fetchAllIndexData = async () => {
        setLoading(true);
        try {
            const promises = INDEX_CONFIG.map(index => 
                axios.get(`http://${local_ip}:3000/stock_data`, {
                    params: { code: index.code, limit: 50 }
                })
            );
            const results = await Promise.all(promises);
            const dataMap = {};
            results.forEach((res, idx) => {
                dataMap[INDEX_CONFIG[idx].code] = res.data || [];
            });
            setIndexData(dataMap);
        } catch (error) {
            console.error('Fetch index data failed:', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchAllIndexData();
    }, []);

    return (
        <div className="sentiment-container">
            <div className="page-header" style={{ marginBottom: 24 }}>
                <Title level={4}>情绪复盘</Title>
                <Text type="secondary">四大指数 K 线概览</Text>
            </div>

            {loading ? (
                <div style={{ height: 400, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                    <Spin tip="正在加载指数数据..." size="large" />
                </div>
            ) : (
                <Row gutter={[12, 12]}>
                    {INDEX_CONFIG.map(index => {
                        const analysis = analyzeIndexData(indexData[index.code]);
                        return (
                            <Col xs={24} lg={12} key={index.code}>
                                <Card 
                                    title={
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <Text strong style={{ fontSize: '13px' }}>{index.name}</Text>
                                            <Tag color={analysis.color} style={{ margin: 0, fontSize: '11px', borderRadius: '4px' }}>
                                                {analysis.status}
                                            </Tag>
                                        </div>
                                    }
                                    variant="borderless" 
                                    style={{ borderRadius: 8 }}
                                    bodyStyle={{ padding: '4px' }}
                                    size="small"
                                >
                                    {indexData[index.code]?.length > 0 ? (
                                        <>
                                            <StockKLine data={indexData[index.code]} height={280} />
                                            <div style={{ padding: '8px', borderTop: '1px solid #f0f0f0', backgroundColor: '#fafafa', borderRadius: '0 0 8px 8px' }}>
                                                <Text type="secondary" style={{ fontSize: '11px', lineHeight: '1.4', display: 'block' }}>
                                                    <span style={{ color: analysis.color, fontWeight: 'bold' }}>博弈策略：</span>
                                                    {analysis.desc}
                                                </Text>
                                            </div>
                                        </>
                                    ) : (
                                        <Empty description="暂无数据" />
                                    )}
                                </Card>
                            </Col>
                        );
                    })}
                </Row>
            )}
        </div>
    );
};

export default Sentiment;

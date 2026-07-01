import { useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import { local_ip } from '../../constant';
import { PlayCircleOutlined, PauseCircleOutlined, ReloadOutlined, AppstoreOutlined, BarChartOutlined, StepBackwardOutlined, StepForwardOutlined } from '@ant-design/icons';
import { Button, Checkbox } from 'antd';
import { Bar } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Title as ChartTitle, Tooltip as ChartTooltip, Legend } from 'chart.js';
import './index.scss';

ChartJS.register(CategoryScale, LinearScale, BarElement, ChartTitle, ChartTooltip, Legend);

const DEFAULT_SELECTED_BLOCKS = [
    '光通信模块',
    '液冷概念',
    '保险Ⅱ',
    '银行Ⅱ',
    '证券Ⅱ',
    '半导体概念',
    'PCB',
    '中证500',
    'MLCC',
    '商业航天',
    '机器人概念',
    '锂电池概念',
    '创新药',
    '存储芯片'
];

const PLAYBACK_INTERVAL_MS = 2200;
const BUBBLE_TRANSITION_MS = 1800;
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const getBubbleTextStyle = (radius, blockName) => {
    const diameter = radius * 2;
    const maxNameFontSize = blockName && blockName.length > 4 ? 12 : 15;
    const nameFontSize = Math.min(diameter * 0.18, maxNameFontSize);
    const moneyFontSize = Math.min(diameter * 0.14, 15);
    const contentPadding = clamp(diameter * 0.06, 2, 8);
    const moneyMarginTop = clamp(diameter * 0.035, 1, 4);

    return {
        '--bubble-name-font-size': `${nameFontSize}px`,
        '--bubble-money-font-size': `${moneyFontSize}px`,
        '--bubble-content-padding': `${contentPadding}px`,
        '--bubble-money-margin-top': `${moneyMarginTop}px`
    };
};

const BlockMoneyChange = () => {
    const [timeSeriesData, setTimeSeriesData] = useState([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isRealTime, setIsRealTime] = useState(true);
    const [selectedBlocks, setSelectedBlocks] = useState(DEFAULT_SELECTED_BLOCKS);
    const [viewMode, setViewMode] = useState('bar'); // 'bubble' or 'bar'
    const containerRef = useRef(null);
    const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
    const playIntervalRef = useRef(null);
    // 用 ref 保存最新的 isRealTime，避免 setInterval 闭包捕获到初始值导致回放时被轮询重置到最后一帧
    const isRealTimeRef = useRef(isRealTime);
    useEffect(() => {
        isRealTimeRef.current = isRealTime;
    }, [isRealTime]);

    // 将 time 字段解析为当日分钟数，便于区间过滤；无法解析时返回 -1
    const parseTimeToMinutes = (time) => {
        if (time === undefined || time === null) return -1;
        const digitOnlyTime = String(time).trim().replace(/\D/g, '');
        if (digitOnlyTime.length < 4) return -1;
        const hh = parseInt(digitOnlyTime.slice(0, 2), 10);
        const mm = parseInt(digitOnlyTime.slice(2, 4), 10);
        return hh * 60 + mm;
    };

    // 过滤掉中午休盘(11:30 ~ 13:00)和下午闭盘后(>15:00)的数据
    const filterTradingTime = (data) => {
        return data.filter((item) => {
            const minutes = parseTimeToMinutes(item.time);
            if (minutes < 0) return true; // 无法解析的时间保留
            if (minutes > 11 * 60 + 30 && minutes < 13 * 60) return false; // 午休
            if (minutes > 15 * 60) return false; // 闭盘后
            return true;
        });
    };

    const fetchTimeData = async () => {
        try {
            const response = await axios.get(`http://${local_ip}:3000/get_block_money_change_time`);
            if (response.data && Array.isArray(response.data)) {
                const filtered = filterTradingTime(response.data);
                setTimeSeriesData(filtered);
                if (isRealTimeRef.current && filtered.length > 0) {
                    setCurrentIndex(filtered.length - 1);
                }
            }
        } catch (error) {
            console.error('Fetch block money change time failed:', error);
        }
    };

    useEffect(() => {
        fetchTimeData();
        const timer = setInterval(fetchTimeData, 3000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        if (isPlaying) {
            const tick = () => {
                setCurrentIndex(prev => {
                    if (prev >= timeSeriesData.length - 1) {
                        setIsPlaying(false);
                        return prev;
                    }
                    return prev + 1;
                });
            };
            // 立即推进第一帧，之后按间隔递归
            tick();
            playIntervalRef.current = setTimeout(function run() {
                tick();
                if (playIntervalRef.current) {
                    playIntervalRef.current = setTimeout(run, PLAYBACK_INTERVAL_MS);
                }
            }, PLAYBACK_INTERVAL_MS);
        } else {
            if (playIntervalRef.current) {
                clearTimeout(playIntervalRef.current);
                playIntervalRef.current = null;
            }
        }
        return () => {
            if (playIntervalRef.current) {
                clearTimeout(playIntervalRef.current);
            }
        };
    }, [isPlaying, timeSeriesData.length]);

    const allBlocks = useMemo(() => {
        const blockSet = new Set();
        timeSeriesData.forEach(timeData => {
            timeData.data?.forEach(item => {
                blockSet.add(item.block);
            });
        });
        return Array.from(blockSet).sort();
    }, [timeSeriesData]);

    const currentData = useMemo(() => {
        const data = timeSeriesData[currentIndex]?.data || [];
        return data.filter(item => selectedBlocks.includes(item.block));
    }, [timeSeriesData, currentIndex, selectedBlocks]);

    // 柱状图数据 - 复用 currentData，按资金净流入排序，并计算排名变化
    const barChartData = useMemo(() => {
        if (!currentData || currentData.length === 0) return null;

        // 按资金净流入降序排序（正数在前，负数在后）
        const sortedData = [...currentData].sort((a, b) => b.money - a.money);

        // 计算上一帧的排名（按 money 降序）
        const prevData = timeSeriesData[currentIndex - 1]?.data || [];
        const prevFiltered = prevData.filter(item => selectedBlocks.includes(item.block));
        const prevSorted = [...prevFiltered].sort((a, b) => b.money - a.money);
        const prevRankMap = new Map();
        prevSorted.forEach((item, idx) => {
            prevRankMap.set(item.block, idx);
        });

        // rankChange > 0 表示排名前进（名次数字变小），< 0 表示后退
        const rankChanges = sortedData.map((item, currentRank) => {
            const prevRank = prevRankMap.get(item.block);
            if (prevRank === undefined) return 0; // 上一帧不存在该板块
            return prevRank - currentRank;
        });

        return {
            labels: sortedData.map((item) => item.block),
            datasets: [
                {
                    label: '资金净流入',
                    data: sortedData.map((item) => item.money),
                    backgroundColor: sortedData.map((item) => {
                        if (item.money > 0) return 'rgba(207, 19, 34, 0.6)';
                        if (item.money < 0) return 'rgba(56, 158, 13, 0.6)';
                        return 'rgba(89, 89, 89, 0.6)';
                    }),
                    borderColor: sortedData.map((item) => {
                        if (item.money > 0) return 'rgba(207, 19, 34, 1)';
                        if (item.money < 0) return 'rgba(56, 158, 13, 1)';
                        return 'rgba(89, 89, 89, 1)';
                    }),
                    borderWidth: 1,
                    rankChanges,
                    jumpUrls: sortedData.map((item) => item.jumpUrl),
                },
            ],
        };
    }, [currentData, timeSeriesData, currentIndex, selectedBlocks]);

    // 大幅流入/流出提示 - 对比上一帧，变化超过 5 亿的板块
    const BIG_CHANGE_THRESHOLD = 500000000; // 5 亿
    const bigChanges = useMemo(() => {
        if (currentIndex <= 0) return [];
        const prevData = timeSeriesData[currentIndex - 1]?.data || [];
        const prevMap = new Map();
        prevData.forEach((item) => {
            if (selectedBlocks.includes(item.block)) {
                prevMap.set(item.block, item.money);
            }
        });
        const changes = [];
        currentData.forEach((item) => {
            const prevMoney = prevMap.get(item.block);
            if (prevMoney === undefined) return;
            const diff = item.money - prevMoney;
            if (Math.abs(diff) >= BIG_CHANGE_THRESHOLD) {
                changes.push({
                    block: item.block,
                    diff,
                    type: diff > 0 ? 'inflow' : 'outflow',
                });
            }
        });
        // 按绝对值降序
        changes.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
        return changes;
    }, [timeSeriesData, currentIndex, currentData, selectedBlocks]);

    useEffect(() => {
        if (containerRef.current) {
            setDimensions({
                width: containerRef.current.clientWidth,
                height: containerRef.current.clientHeight
            });
        }
        
        const handleResize = () => {
            if (containerRef.current) {
                setDimensions({
                    width: containerRef.current.clientWidth,
                    height: containerRef.current.clientHeight
                });
            }
        };

        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const layout = useMemo(() => {
        if (!currentData || currentData.length === 0 || dimensions.width === 0) {
            return { bubbles: [], stageHeight: 860, dividerLeft: Math.max(dimensions.width / 2, 0) };
        }
        
        let maxAbsMoney = 0;
        currentData.forEach(item => {
            const money = item.money;
            if (Math.abs(money) > maxAbsMoney) {
                maxAbsMoney = Math.abs(money);
            }
        });

        const upData = currentData.filter(d => d.money >= 0);
        const downData = currentData.filter(d => d.money < 0);
        const dividerWidth = 28;
        const totalColumnWidth = Math.max(dimensions.width - dividerWidth, 560);
        const minColumnWidth = 240;
        const sharedBaseSize = Math.min(totalColumnWidth / 2, 700);
        const minRadius = Math.max(18, sharedBaseSize * 0.032);
        const maxRadius = Math.max(48, sharedBaseSize * 0.125);

        const getGroupDemandScore = (groupData) => {
            if (!groupData.length) {
                return 1;
            }

            const bubbleDemand = groupData.reduce((sum, item) => {
                return sum + Math.sqrt(Math.abs(item.money) / (maxAbsMoney || 1));
            }, 0);

            return groupData.length * 1.15 + bubbleDemand;
        };

        const upDemandScore = getGroupDemandScore(upData);
        const downDemandScore = getGroupDemandScore(downData);
        const rawUpRatio = upDemandScore / (upDemandScore + downDemandScore || 1);
        const upRatio = clamp(rawUpRatio, 0.24, 0.76);
        const upColumnWidth = clamp(totalColumnWidth * upRatio, minColumnWidth, totalColumnWidth - minColumnWidth);
        const downColumnWidth = totalColumnWidth - upColumnWidth;

        const processGroup = (groupData) => {
            groupData.sort((a, b) => Math.abs(b.money) - Math.abs(a.money));
            
            const placed = [];
            let minX = 0;
            let maxX = 0;
            let minY = 0;
            let maxY = 0;

            groupData.forEach(item => {
                const absMoney = Math.abs(item.money);
                let r = minRadius + (maxRadius - minRadius) * Math.sqrt(absMoney / (maxAbsMoney || 1));
                if (r < minRadius) r = minRadius;
                
                let angle = 0;
                const a = 2.5;
                let x = 0;
                let y = 0;
                let isCollision = true;

                while (isCollision) {
                    x = a * angle * Math.cos(angle);
                    y = a * angle * Math.sin(angle);
                    
                    isCollision = false;
                    for (let i = 0; i < placed.length; i++) {
                        const p = placed[i];
                        const dx = x - p.x;
                        const dy = y - p.y;
                        const distance = Math.sqrt(dx * dx + dy * dy);
                        if (distance < r + p.r + 2) {
                            isCollision = true;
                            break;
                        }
                    }
                    angle += 0.5;
                }
                
                minX = Math.min(minX, x - r);
                maxX = Math.max(maxX, x + r);
                minY = Math.min(minY, y - r);
                maxY = Math.max(maxY, y + r);
                
                placed.push({ ...item, r, x, y });
            });

            return {
                placed,
                width: Math.max(maxX - minX, 1),
                minX,
                maxX,
                minY,
                maxY,
                height: Math.max(maxY - minY, 1)
            };
        };
        const upResult = processGroup(upData);
        const downResult = processGroup(downData);
        const upAvailableWidth = Math.max(upColumnWidth - 36, 220);
        const downAvailableWidth = Math.max(downColumnWidth - 36, 220);
        const fitScale = Math.min(
            1,
            upAvailableWidth / upResult.width,
            downAvailableWidth / downResult.width
        );

        const scaleGroup = (groupResult) => {
            const placed = groupResult.placed.map(item => ({
                ...item,
                x: item.x * fitScale,
                y: item.y * fitScale,
                r: item.r * fitScale
            }));

            return {
                placed,
                minX: groupResult.minX * fitScale,
                minY: groupResult.minY * fitScale,
                width: groupResult.width * fitScale,
                height: groupResult.height * fitScale,
                requiredHeight: Math.max(300, (groupResult.height * fitScale) + 100)
            };
        };

        const scaledUpResult = scaleGroup(upResult);
        const scaledDownResult = scaleGroup(downResult);
        const stageHeight = Math.max(scaledUpResult.requiredHeight, scaledDownResult.requiredHeight, 520);
        const upOffsetX = ((upColumnWidth - scaledUpResult.width) / 2) - scaledUpResult.minX;
        const downOffsetX = upColumnWidth + dividerWidth + ((downColumnWidth - scaledDownResult.width) / 2) - scaledDownResult.minX;
        const upOffsetY = ((stageHeight - scaledUpResult.height) / 2) - scaledUpResult.minY;
        const downOffsetY = ((stageHeight - scaledDownResult.height) / 2) - scaledDownResult.minY;

        const bubbles = [
            ...scaledUpResult.placed.map(item => ({
                ...item,
                stageX: upOffsetX + item.x,
                stageY: upOffsetY + item.y,
                directionClass: 'up-bubble'
            })),
            ...scaledDownResult.placed.map(item => ({
                ...item,
                stageX: downOffsetX + item.x,
                stageY: downOffsetY + item.y,
                directionClass: 'down-bubble'
            }))
        ];

        return {
            bubbles,
            stageHeight,
            dividerLeft: upColumnWidth
        };
    }, [currentData, dimensions.width]);

    const formatMoney = (money) => {
        const yi = money / 100000000;
        const sign = money > 0 ? '+' : '';
        return `${sign}${yi.toFixed(1)}亿`;
    };

    const formatTime = (time) => {
        if (!time) {
            return '--:--';
        }

        const rawTime = String(time).trim();
        const hhmmMatch = rawTime.match(/^(\d{2})(\d{2})/);

        if (hhmmMatch) {
            return `${hhmmMatch[1]}:${hhmmMatch[2]}`;
        }

        const digitOnlyTime = rawTime.replace(/\D/g, '');
        if (digitOnlyTime.length >= 4) {
            return `${digitOnlyTime.slice(0, 2)}:${digitOnlyTime.slice(2, 4)}`;
        }

        return rawTime;
    };

    const barChartOptions = useMemo(() => ({
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { bottom: 8 } },
        // 点击柱子跳转 jumpUrl
        onClick: (event, elements) => {
            if (elements && elements.length > 0) {
                const index = elements[0].index;
                const dataset = event.chart.data.datasets[0];
                const url = dataset?.jumpUrls?.[index];
                if (url) {
                    window.open(url, '_blank');
                }
            }
        },
        // 鼠标悬停在可跳转柱子上时显示手型
        onHover: (event, elements) => {
            if (event.native && event.native.target) {
                event.native.target.style.cursor = elements.length > 0 ? 'pointer' : 'default';
            }
        },
        plugins: {
            legend: { position: 'top' },
            title: {
                display: true,
                text: `板块资金净流入 (${formatTime(timeSeriesData[currentIndex]?.time)})`,
            },
            tooltip: {
                callbacks: {
                    label: (context) => {
                        const money = context.parsed.y;
                        const yi = money / 100000000;
                        const sign = money > 0 ? '+' : '';
                        return `资金: ${sign}${yi.toFixed(2)} 亿`;
                    },
                },
            },
        },
        scales: {
            x: {
                title: { display: true, text: '板块名称' },
                ticks: {
                    autoSkip: false,
                    maxRotation: 75,
                    minRotation: 75,
                    padding: 4,
                    font: { size: 12 },
                    // 在标签后追加排名变化箭头
                    callback: function(value, index) {
                        const rankChanges = this.chart.data.datasets[0]?.rankChanges;
                        if (!rankChanges) return this.getLabelForValue(value);
                        const change = rankChanges[index];
                        const label = this.getLabelForValue(value);
                        if (change > 0) return `${label} ↑${change}`;
                        if (change < 0) return `${label} ↓${Math.abs(change)}`;
                        return `${label} -`;
                    },
                    // 根据排名变化设置标签颜色：红涨绿跌
                    color: function(context) {
                        const rankChanges = context.chart.data.datasets[0]?.rankChanges;
                        if (!rankChanges) return '#666';
                        const change = rankChanges[context.index];
                        if (change > 0) return 'rgba(207, 19, 34, 1)';   // 前进-红色
                        if (change < 0) return 'rgba(56, 158, 13, 1)';   // 后退-绿色
                        return '#999'; // 不变-灰色
                    },
                },
            },
            y: {
                title: { display: true, text: '资金净流入 (元)' },
                ticks: {
                    callback: (value) => {
                        const yi = value / 100000000;
                        return `${yi.toFixed(1)}亿`;
                    },
                },
            },
        },
    }), [timeSeriesData, currentIndex]);

    const handleCircleClick = (url) => {
        if (url) {
            window.open(url, '_blank');
        }
    };

    const handlePlay = () => {
        if (timeSeriesData.length === 0) {
            return;
        }

        if (isPlaying) {
            setIsPlaying(false);
            return;
        }

        setIsRealTime(false);
        setCurrentIndex(prev => {
            if (isRealTime || prev >= timeSeriesData.length - 1) {
                return 0;
            }
            return prev;
        });
        setIsPlaying(true);
    };

    const handleReset = () => {
        setIsPlaying(false);
        setIsRealTime(true);
        setCurrentIndex(timeSeriesData.length - 1);
    };

    const handleStep = (direction) => {
        setIsRealTime(false);
        setIsPlaying(false);
        setCurrentIndex((prev) => {
            const next = prev + direction;
            if (next < 0) return 0;
            if (next >= timeSeriesData.length) return timeSeriesData.length - 1;
            return next;
        });
    };

    const handleCheckboxChange = (checkedValues) => {
        setSelectedBlocks(checkedValues);
    };

    const handleCheckAll = (checked) => {
        if (checked) {
            setSelectedBlocks(allBlocks);
        } else {
            setSelectedBlocks([]);
        }
    };

    const handleResetDefaultBlocks = () => {
        setSelectedBlocks(DEFAULT_SELECTED_BLOCKS);
    };

    const currentTime = formatTime(timeSeriesData[currentIndex]?.time);

    return (
        <div
            className="block-money-container"
            ref={containerRef}
            style={{ '--bubble-transition-ms': `${BUBBLE_TRANSITION_MS}ms` }}
        >
            <div className="control-bar">
                <div className="view-toggle">
                    <Button
                        type={viewMode === 'bubble' ? 'primary' : 'default'}
                        icon={<AppstoreOutlined />}
                        onClick={() => setViewMode('bubble')}
                        size="small"
                    >
                        泡泡图
                    </Button>
                    <Button
                        type={viewMode === 'bar' ? 'primary' : 'default'}
                        icon={<BarChartOutlined />}
                        onClick={() => setViewMode('bar')}
                        size="small"
                    >
                        柱状图
                    </Button>
                </div>
            </div>
            
            <div className="filter-bar">
                <div className="filter-header">
                    <span className="filter-title">板块选择:</span>
                    <Checkbox 
                        checked={selectedBlocks.length === allBlocks.length && allBlocks.length > 0}
                        indeterminate={selectedBlocks.length > 0 && selectedBlocks.length < allBlocks.length}
                        onChange={(e) => handleCheckAll(e.target.checked)}
                    >
                        全选
                    </Checkbox>
                    <Button
                        type="link"
                        size="small"
                        onClick={handleResetDefaultBlocks}
                        className="reset-default-btn"
                    >
                        恢复默认
                    </Button>
                </div>
                <Checkbox.Group 
                    options={allBlocks}
                    value={selectedBlocks}
                    onChange={handleCheckboxChange}
                    className="checkbox-group"
                />
            </div>

            <div className="floating-play-controls">
                <div className="floating-time-display">
                    <span className="floating-time-label">当前帧</span>
                    <span className="floating-time-value">{currentTime}</span>
                </div>
                {!isPlaying && !isRealTime && (
                    <Button
                        icon={<StepBackwardOutlined />}
                        onClick={() => handleStep(-1)}
                        disabled={currentIndex <= 0}
                        className="floating-play-btn floating-step-btn"
                    />
                )}
                <Button
                    type="primary"
                    icon={isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                    onClick={handlePlay}
                    disabled={timeSeriesData.length === 0}
                    className="floating-play-btn"
                >
                    {isPlaying ? '暂停' : (isRealTime || currentIndex >= timeSeriesData.length - 1 ? '开始回放' : '继续')}
                </Button>
                {!isPlaying && !isRealTime && (
                    <Button
                        icon={<StepForwardOutlined />}
                        onClick={() => handleStep(1)}
                        disabled={currentIndex >= timeSeriesData.length - 1}
                        className="floating-play-btn floating-step-btn"
                    />
                )}
                <Button
                    icon={<ReloadOutlined />}
                    onClick={handleReset}
                    className="floating-play-btn floating-reset-btn"
                >
                    实时数据
                </Button>
            </div>

            {bigChanges.length > 0 && (
                <div className="big-changes-banner">
                    {bigChanges.map((change) => {
                        const yi = Math.abs(change.diff) / 100000000;
                        const sign = change.diff > 0 ? '+' : '-';
                        return (
                            <span
                                key={change.block}
                                className={`big-change-tag ${change.type}`}
                            >
                                {change.block} {change.type === 'inflow' ? '大幅流入' : '大幅流出'} {sign}{yi.toFixed(1)}亿
                            </span>
                        );
                    })}
                </div>
            )}
            
            {viewMode === 'bubble' ? (
                <div className="bubble-stage" style={{ minHeight: `${layout.stageHeight}px` }}>
                    <div className="bubbles-wrapper">
                        {layout.bubbles.map((item, idx) => (
                            <div
                                key={item.blockCode || item.block || idx}
                                className={`bubble animated-bubble ${item.directionClass}`}
                                style={{
                                    width: item.r * 2,
                                    height: item.r * 2,
                                    left: `${item.stageX - item.r}px`,
                                    top: `${item.stageY - item.r}px`,
                                    ...getBubbleTextStyle(item.r, item.block),
                                }}
                                onClick={() => handleCircleClick(item.jumpUrl)}
                                title={item.block}
                            >
                                <div className="bubble-content">
                                    <div className="block-name">{item.block}</div>
                                    <div className="block-money">{formatMoney(item.money)}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                    <div className="divider divider-overlay divider-vertical" style={{ left: `${layout.dividerLeft}px` }}>
                        <div className="divider-line"></div>
                        <span>板块资金</span>
                        <div className="divider-line"></div>
                    </div>
                </div>
            ) : (
                <div className="bar-chart-stage">
                    {barChartData ? (
                        <Bar data={barChartData} options={barChartOptions} />
                    ) : (
                        <div className="bar-chart-empty">暂无数据</div>
                    )}
                </div>
            )}
        </div>
    );
};

export default BlockMoneyChange;

import { useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import { local_ip } from '../../constant';
import { PlayCircleOutlined, PauseCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Slider, Checkbox } from 'antd';
import './index.scss';

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
    '锂电池概念'
];

const PLAYBACK_INTERVAL_MS = 1300;
const BUBBLE_TRANSITION_MS = 980;
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const BlockMoneyChange = () => {
    const [timeSeriesData, setTimeSeriesData] = useState([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isRealTime, setIsRealTime] = useState(true);
    const [selectedBlocks, setSelectedBlocks] = useState(DEFAULT_SELECTED_BLOCKS);
    const containerRef = useRef(null);
    const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
    const playIntervalRef = useRef(null);

    const fetchTimeData = async () => {
        try {
            const response = await axios.get(`http://${local_ip}:3000/get_block_money_change_time`);
            if (response.data && Array.isArray(response.data)) {
                setTimeSeriesData(response.data);
                if (isRealTime && response.data.length > 0) {
                    setCurrentIndex(response.data.length - 1);
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
            playIntervalRef.current = setInterval(() => {
                setCurrentIndex(prev => {
                    if (prev >= timeSeriesData.length - 1) {
                        setIsPlaying(false);
                        return prev;
                    }
                    return prev + 1;
                });
            }, PLAYBACK_INTERVAL_MS);
        } else {
            if (playIntervalRef.current) {
                clearInterval(playIntervalRef.current);
            }
        }
        return () => {
            if (playIntervalRef.current) {
                clearInterval(playIntervalRef.current);
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

    const handleSliderChange = (value) => {
        setIsRealTime(false);
        setIsPlaying(false);
        setCurrentIndex(value);
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
                <div className="slider-container">
                    <Slider
                        min={0}
                        max={timeSeriesData.length - 1}
                        value={currentIndex}
                        onChange={handleSliderChange}
                        disabled={timeSeriesData.length === 0}
                    />
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
                <Button
                    type="primary"
                    icon={isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                    onClick={handlePlay}
                    disabled={timeSeriesData.length === 0}
                    className="floating-play-btn"
                >
                    {isPlaying ? '暂停回放' : '开始回放'}
                </Button>
                <Button
                    icon={<ReloadOutlined />}
                    onClick={handleReset}
                    className="floating-play-btn floating-reset-btn"
                >
                    实时数据
                </Button>
            </div>
            
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
        </div>
    );
};

export default BlockMoneyChange;

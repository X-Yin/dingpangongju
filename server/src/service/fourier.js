/**
 * A股分时资金频率拆解引擎
 * @param {Array} stockData - 个股过去N天分时数据 (1min)
 * @param {Array} indexData - 对应指数过去N天分时数据 (1min)
 * @returns {Object} 每日频率集合及资金异动分析
 */
function analyzeCapitalFrequencies(stockData, indexData) {
    // ==========================================
    // 1. 数据预处理：对齐与收益率序列化
    // ==========================================
    const tradingMinutes = 240; // A股每日240分钟
    const results = [];

    for (let i = 0; i < stockData.length; i++) {
        const sDay = stockData[i];
        const iDay = indexData.find(d => d.date === sDay.date);
        if (!iDay || sDay.line.length < tradingMinutes) continue;

        // 提取1min收益率序列（去趋势，聚焦波动）
        const stockReturns = sDay.line.map((m, idx) => 
            idx === 0 ? 0 : (m.last_px - sDay.line[idx-1].last_px) / sDay.line[idx-1].last_px
        );
        const indexReturns = iDay.line.map((m, idx) => 
            idx === 0 ? 0 : (m.last_px - iDay.line[idx-1].last_px) / iDay.line[idx-1].last_px
        );

        // ==========================================
        // 2. DFT 核心计算（自定义轻量级实现）
        // ==========================================
        const computeDFT = (signal) => {
            const N = signal.length;
            const spectrum = [];
            // 只计算前 N/2 个频率（奈奎斯特限制）
            for (let k = 0; k <= N / 2; k++) {
                let real = 0, imag = 0;
                for (let n = 0; n < N; n++) {
                    const angle = -2 * Math.PI * k * n / N;
                    real += signal[n] * Math.cos(angle);
                    imag += signal[n] * Math.sin(angle);
                }
                const magnitude = Math.sqrt(real * real + imag * imag) / N;
                const phase = Math.atan2(imag, real);
                spectrum.push({ freq: k, magnitude, phase });
            }
            return spectrum;
        };

        const stockSpectrum = computeDFT(stockReturns);
        const indexSpectrum = computeDFT(indexReturns);

        // ==========================================
        // 3. 频率语义映射与基准识别
        // ==========================================
        // A股240分钟对应的频率含义：
        // k=0: 直流分量(日内趋势) | k=1: 全天周期 | k=2: 半天周期(早盘/尾盘)
        // k=4: 60min周期(机构调仓) | k=8: 30min周期(量化高频) | k>20: 游资/噪声
        
        const FREQ_BANDS = [
            { name: 'INDEX_BETA', label: '指数基准/ETF跟踪', range: [1, 3], isBenchmark: true },
            { name: 'QUANT_MID', label: '中频量化/私募', range: [4, 10], isBenchmark: false },
            { name: 'HOT_MONEY', label: '游资/散户情绪', range: [11, 40], isBenchmark: false },
            { name: 'MICRO_NOISE', label: '微观结构噪声', range: [41, 120], isBenchmark: false }
        ];

        const dayResult = {
            date: sDay.date,
            frequencies: [],
            capitalChanges: []
        };

        // 计算每个频段的能量及与指数的相干性
        FREQ_BANDS.forEach(band => {
            const bandStock = stockSpectrum.filter(s => s.freq >= band.range[0] && s.freq <= band.range[1]);
            const bandIndex = indexSpectrum.filter(s => s.freq >= band.range[0] && s.freq <= band.range[1]);
            
            const stockEnergy = bandStock.reduce((sum, s) => sum + s.magnitude * s.magnitude, 0);
            const indexEnergy = bandIndex.reduce((sum, s) => sum + s.magnitude * s.magnitude, 0);
            
            // 计算加权平均相位（判断多空）
            const avgPhase = bandStock.reduce((sum, s) => sum + s.phase * s.magnitude, 0) / 
                            (bandStock.reduce((sum, s) => sum + s.magnitude, 0) || 1);
            
            // 相干性：该频段是否被指数主导
            const coherence = indexEnergy > 1e-10 ? stockEnergy / indexEnergy : 0;
            
            dayResult.frequencies.push({
                band: band.name,
                label: band.label,
                isBenchmark: band.isBenchmark,
                energy: parseFloat(stockEnergy.toFixed(8)),
                direction: Math.abs(avgPhase) < Math.PI / 2 ? 'UP' : 'DOWN', // 相位决定方向
                strength: parseFloat(Math.sqrt(stockEnergy).toFixed(6)),
                indexCoherence: parseFloat(coherence.toFixed(4))
            });
        });

        // ==========================================
        // 4. 日间变化检测（买卖点信号源）
        // ==========================================
        if (results.length > 0) {
            const prevDay = results[results.length - 1];
            dayResult.frequencies.forEach(curr => {
                const prev = prevDay.frequencies.find(f => f.band === curr.band);
                if (!prev) return;

                const energyDelta = curr.energy - prev.energy;
                const dirChanged = curr.direction !== prev.direction;

                // 信号判定逻辑
                if (curr.band === 'HOT_MONEY' && energyDelta > prev.energy * 0.5 && curr.direction === 'UP') {
                    dayResult.capitalChanges.push({
                        type: 'BUY_SIGNAL',
                        reason: `游资/情绪资金入场: ${curr.label} 能量激增 ${(energyDelta/prev.energy*100).toFixed(1)}%，方向转多`
                    });
                }
                if (curr.band === 'INDEX_BETA' && dirChanged && curr.direction === 'DOWN') {
                    dayResult.capitalChanges.push({
                        type: 'SELL_WARNING',
                        reason: `指数基准频率反空: ETF/量化跟随资金转向卖出`
                    });
                }
                if (curr.band === 'QUANT_MID' && energyDelta < -prev.energy * 0.3) {
                    dayResult.capitalChanges.push({
                        type: 'CAPITAL_EXIT',
                        reason: `中频机构资金离场: ${curr.label} 能量衰减 ${Math.abs(energyDelta/prev.energy*100).toFixed(1)}%`
                    });
                }
            });
        }

        results.push(dayResult);
    }

    return results;
}

module.exports = { analyzeCapitalFrequencies };
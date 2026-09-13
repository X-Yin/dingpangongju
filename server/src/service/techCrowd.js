const fs = require('fs');
const path = require('path');
const { getRZRQData } = require('./rzrq');
const dayjs = require('dayjs');

/**
 * 科技行情交易拥挤度计算
 *
 * 输入:
 *
 * marginBalance:
 * 融资余额数组
 *
 * marginBuy:
 * 融资买入数组
 *
 * techVolumeRatio:
 * 科技成交占比数组
 *
 *
 * 输出:
 *
 * [
 * {
 *   index,
 *   score,
 *   level
 * }
 * ]
 *
 */
const calculateTechCrowdingSeries = (
    marginBalance,
    marginBuy,
    techVolumeRatio,
    window = 30
) => {

    if (
        marginBalance.length !== marginBuy.length ||
        marginBalance.length !== techVolumeRatio.length
    ) {
        throw new Error(
            "数组长度必须一致"
        );
    }

    const mean = arr =>
        arr.reduce(
            (a, b) => a + b,
            0
        ) / arr.length;


    const std = arr => {

        const m = mean(arr);

        const variance =
            arr.reduce(
                (sum, x) =>
                    sum + Math.pow(x - m, 2),
                0
            )
            /
            arr.length;


        return Math.sqrt(variance);

    };


    const zScore = (
        arr,
        index
    ) => {

        const start =
            Math.max(
                0,
                index - window + 1
            );


        const slice =
            arr.slice(
                start,
                index + 1
            );


        if (slice.length < 10)
            return 0;


        const s = std(slice);


        if (s === 0)
            return 0;


        return (
            arr[index]
            -
            mean(slice)
        )
            /
            s;

    };


    const marginFlow =
        marginBuy.map(
            (x, i) =>
                x /
                marginBalance[i]
        );


    const result = [];


    for (
        let i = 0;
        i < marginBalance.length;
        i++
    ) {


        const marginZ =
            zScore(
                marginBalance,
                i
            );


        const flowZ =
            zScore(
                marginFlow,
                i
            );


        const techZ =
            zScore(
                techVolumeRatio,
                i
            );


        const crowdZ =
            marginZ * 0.25
            +
            flowZ * 0.25
            +
            techZ * 0.5;


        let score =
            50 +
            crowdZ * 20;


        score =
            Math.max(
                0,
                Math.min(
                    100,
                    score
                )
            );


        let level;


        if (score >= 85) {

            level = "极端拥挤";

        }
        else if (score >= 70) {

            level = "高度拥挤";

        }
        else if (score >= 55) {

            level = "轻度拥挤";

        }
        else if (score >= 40) {

            level = "正常";

        }
        else {

            level = "低拥挤";

        }


        result.push({

            index: i,

            score:
                Number(
                    score.toFixed(2)
                ),

            level,


            detail: {

                marginZ:
                    Number(
                        marginZ.toFixed(2)
                    ),

                flowZ:
                    Number(
                        flowZ.toFixed(2)
                    ),

                techZ:
                    Number(
                        techZ.toFixed(2)
                    )

            }

        });


    }


    return result;

};

const getTechBlockCrowd = async (startDate, endDate) => {
    const amountDayHistoryPath = path.resolve(__dirname, '../data/amount_day_history.json');
    const techMoneyPath = path.resolve(__dirname, './科技板块拥挤度计算/block_amount_money_result.json');

    if (!fs.existsSync(amountDayHistoryPath)) {
        throw new Error('amount_day_history.json 不存在');
    }
    if (!fs.existsSync(techMoneyPath)) {
        throw new Error('block_amount_money_result.json 不存在');
    }

    const amountDayHistory = JSON.parse(fs.readFileSync(amountDayHistoryPath, 'utf-8'));
    const techMoneyList = JSON.parse(fs.readFileSync(techMoneyPath, 'utf-8'));

    const totalAmountMap = new Map();
    for (const item of amountDayHistory) {
        if (item && item.date && item.totalAmount !== undefined && item.totalAmount !== null) {
            totalAmountMap.set(String(item.date), Number(item.totalAmount));
        }
    }

    const techMoneyMap = new Map();
    for (const item of techMoneyList) {
        if (item && item.date && item.techTotalMoney !== undefined && item.techTotalMoney !== null) {
            techMoneyMap.set(String(item.date), Number(item.techTotalMoney));
        }
    }

    const allDates = Array.from(new Set([
        ...Array.from(totalAmountMap.keys()),
        ...Array.from(techMoneyMap.keys()),
    ])).sort((a, b) => a.localeCompare(b));

    const start = startDate ? String(startDate).replace(/-/g, '') : null;
    const end = endDate ? String(endDate).replace(/-/g, '') : null;

    const techRatioList = [];
    for (const date of allDates) {
        if (start && date < start) continue;
        if (end && date > end) continue;

        const totalAmountYi = totalAmountMap.get(date);
        const techTotalMoney = techMoneyMap.get(date);

        if (totalAmountYi === undefined || techTotalMoney === undefined) continue;
        if (!isFinite(totalAmountYi) || !isFinite(techTotalMoney)) continue;
        if (totalAmountYi <= 0) continue;

        const ratio = (techTotalMoney / (totalAmountYi * 1e8)) * 100;
        techRatioList.push({
            date,
            ratio: Number(ratio.toFixed(4)),
            totalAmount: totalAmountYi,
            techTotalMoney,
        });
    }

    if (techRatioList.length === 0) {
        return [];
    }

    const rzrqStartDate = dayjs(techRatioList[0].date).format('YYYY-MM-DD');
    const rzrqEndDate = dayjs(techRatioList[techRatioList.length - 1].date).format('YYYY-MM-DD');
    const rzrqData = await getRZRQData(rzrqStartDate, rzrqEndDate);

    const rzrqMap = new Map();
    for (const item of rzrqData) {
        if (item && item.date) {
            const dateStr = String(item.date).replace(/-/g, '');
            rzrqMap.set(dateStr, {
                rzBalance: item.rzBalance,
                rzBuy: item.rzBuy,
            });
        }
    }

    const alignedData = [];
    const rzrqDates = new Set(rzrqMap.keys());
    
    for (const item of techRatioList) {
        const rzrqItem = rzrqMap.get(item.date);
        if (rzrqItem && rzrqItem.rzBalance > 0 && rzrqItem.rzBuy >= 0) {
            alignedData.push({
                date: item.date,
                ratio: item.ratio,
                totalAmount: item.totalAmount,
                techTotalMoney: item.techTotalMoney,
                rzBalance: rzrqItem.rzBalance,
                rzBuy: rzrqItem.rzBuy,
                hasRZRQ: true,
            });
        } else {
            alignedData.push({
                date: item.date,
                ratio: item.ratio,
                totalAmount: item.totalAmount,
                techTotalMoney: item.techTotalMoney,
                rzBalance: null,
                rzBuy: null,
                hasRZRQ: false,
            });
        }
    }

    if (alignedData.length === 0) {
        return [];
    }

    const rzrqOnlyData = alignedData.filter(item => item.hasRZRQ);
    const crowdResultMap = new Map();
    
    if (rzrqOnlyData.length > 0) {
        const marginBalance = rzrqOnlyData.map(item => item.rzBalance);
        const marginBuy = rzrqOnlyData.map(item => item.rzBuy);
        const techVolumeRatio = rzrqOnlyData.map(item => item.ratio);

        const crowdResult = calculateTechCrowdingSeries(marginBalance, marginBuy, techVolumeRatio);
        
        rzrqOnlyData.forEach((item, index) => {
            crowdResultMap.set(item.date, crowdResult[index]);
        });
    }

    const finalResult = alignedData.map((item) => {
        const crowdResult = crowdResultMap.get(item.date);
        if (crowdResult) {
            return {
                date: item.date,
                ratio: item.ratio,
                totalAmount: item.totalAmount,
                techTotalMoney: item.techTotalMoney,
                rzBalance: item.rzBalance,
                rzBuy: item.rzBuy,
                ...crowdResult,
            };
        }
        return {
            date: item.date,
            ratio: item.ratio,
            totalAmount: item.totalAmount,
            techTotalMoney: item.techTotalMoney,
            rzBalance: item.rzBalance,
            rzBuy: item.rzBuy,
            score: null,
            level: null,
            detail: null,
        };
    });

    return finalResult;
};

exports.calculateTechCrowdingSeries = calculateTechCrowdingSeries;
exports.getTechBlockCrowd = getTechBlockCrowd;

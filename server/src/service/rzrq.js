const axios = require('axios');
const dayjs = require('dayjs');

const RZRQ_BASE_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

const parseRZRQJson = (jsonpText) => {
    const data = [];
    const jsonMatch = jsonpText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return data;

    try {
        const jsonData = JSON.parse(jsonMatch[0]);
        if (!jsonData.result || !jsonData.result.data) return data;

        for (const item of jsonData.result.data) {
            const dateStr = item.DIM_DATE;
            if (!dateStr) continue;

            const date = dayjs(dateStr).format('YYYY-MM-DD');
            const rzBalance = (item.RZYE || 0) / 100000000;
            const rzBuy = (item.RZMRE || 0) / 100000000;

            if (rzBalance > 0 || rzBuy > 0) {
                data.push({
                    date,
                    rzBalance: parseFloat(rzBalance.toFixed(2)),
                    rzBuy: parseFloat(rzBuy.toFixed(2)),
                });
            }
        }
    } catch (error) {
        console.error('解析融资余额数据失败:', error.message);
    }

    return data;
};

const fetchRZRQPage = async (page) => {
    const url = `${RZRQ_BASE_URL}?callback=datatable${Date.now()}&reportName=RPTA_RZRQ_LSHJ&columns=ALL&source=WEB&sortColumns=dim_date&sortTypes=-1&pageNumber=${page}&pageSize=50&filter=&pageNo=${page}&_=${Date.now()}`;
    const response = await axios.get(url, {
        headers: {
            'Accept': '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Connection': 'keep-alive',
            'Referer': 'https://data.eastmoney.com/rzrq/total.html',
            'Sec-Fetch-Dest': 'script',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': 'same-site',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
            'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"macOS"',
        },
    });
    return parseRZRQJson(response.data);
};

const getRZRQData = async (startDate, endDate) => {
    const allData = [];
    const seenDates = new Set();
    let page = 1;
    const maxPages = 20;
    const startDateObj = dayjs(startDate).startOf('day');
    const endDateObj = dayjs(endDate).endOf('day');

    while (page <= maxPages) {
        const pageData = await fetchRZRQPage(page);
        if (pageData.length === 0) break;

        let hasNewData = false;
        for (const item of pageData) {
            const itemDate = dayjs(item.date);
            const isInRange = itemDate.isAfter(startDateObj) && itemDate.isBefore(endDateObj) ||
                              itemDate.isSame(startDateObj, 'day') || itemDate.isSame(endDateObj, 'day');
            
            if (isInRange && !seenDates.has(item.date)) {
                allData.push(item);
                seenDates.add(item.date);
                hasNewData = true;
            }
        }

        const oldestDate = dayjs(pageData[pageData.length - 1]?.date);
        if (oldestDate.isBefore(startDateObj)) {
            break;
        }

        if (!hasNewData) {
            break;
        }

        page++;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    allData.sort((a, b) => dayjs(a.date).valueOf() - dayjs(b.date).valueOf());
    return allData;
};

exports.getRZRQData = getRZRQData;
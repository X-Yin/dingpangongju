# -*- coding: utf-8 -*-
"""
akshare 行情数据接口封装

每个接口封装为独立函数，返回 DataFrame。
命令行模式：以 JSON 输出结果，供 server（node）通过子进程调用：
    python3 api.py cls_news [全部|重点]   # 财联社新闻
    python3 api.py board_change          # 板块异动
    python3 api.py stock_changes [类型]   # 盘口异动（默认 大笔买入）
    python3 api.py stock_changes_all     # 盘口异动·全部类型合并
    python3 api.py hot_rank              # 东财股票热度前 100
    python3 api.py foreign_commodity [代码]  # 外盘期货行情（新浪，如 OIL 布伦特原油 / GC 纽约金）
"""
import json
import math
import os
import sys
import time as time_mod
import warnings
from datetime import date, datetime, time

warnings.filterwarnings('ignore')

# akshare 请求的是国内站点，直连即可：移除代理环境变量并禁用 macOS 系统代理，
# 避免本机代理不稳定导致 eastmoney 接口请求失败
for _k in ('http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'):
    os.environ.pop(_k, None)

import urllib.request

# 先记录原始代理读取函数，默认强制直连
_ORIG_GETPROXIES = urllib.request.getproxies
urllib.request.getproxies = lambda: {}

import pandas as pd
import akshare as ak
import requests
import requests.utils as _requests_utils

# requests 在导入时绑定了 getproxies 引用，需同步替换以保持直连
_requests_utils.getproxies = urllib.request.getproxies


def get_cls_news(symbol="全部"):
    """财联社新闻 symbol: {"全部", "重点"}"""
    return ak.stock_info_global_cls(symbol=symbol)


def get_board_change():
    """板块异动"""
    return ak.stock_board_change_em()


def get_stock_changes(symbol="大笔买入"):
    """盘口异动 symbol 可选: {'火箭发射', '快速反弹', '大笔买入', '封涨停板', '打开跌停板',
    '有大买盘', '竞价上涨', '60日新高', '60日大幅上涨', '加速下跌', '高台跳水', '大笔卖出',
    '封跌停板', '打开涨停板', '有大卖盘', '竞价下跌', '60日新低', '60日大幅下跌'}"""
    return ak.stock_changes_em(symbol=symbol)


# 盘口异动全部类型（积极在前，消极在后），用于 get_stock_changes_all 全量抓取
STOCK_CHANGES_TYPES = [
    '火箭发射', '快速反弹', '大笔买入', '封涨停板', '打开跌停板', '有大买盘', '竞价上涨', '60日新高', '60日大幅上涨',
    '加速下跌', '高台跳水', '大笔卖出', '封跌停板', '打开涨停板', '有大卖盘', '竞价下跌', '60日新低', '60日大幅下跌',
]

# 合并列表最多保留的条数（按时间倒序截断，避免数据量过大）
STOCK_CHANGES_ALL_LIMIT = 300


def get_stock_changes_all():
    """盘口异动·全部类型：并发抓取 18 种异动类型后合并，按时间倒序返回"""
    from concurrent.futures import ThreadPoolExecutor

    def _fetch_one(symbol):
        try:
            return ak.stock_changes_em(symbol=symbol)
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=6) as pool:
        dfs = list(pool.map(_fetch_one, STOCK_CHANGES_TYPES))
    dfs = [d for d in dfs if d is not None and not d.empty]
    if not dfs:
        raise RuntimeError('盘口异动全部类型均获取失败')
    merged = pd.concat(dfs, ignore_index=True)
    merged = merged.sort_values('时间', ascending=False).head(STOCK_CHANGES_ALL_LIMIT)
    return merged


def _parse_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def get_hot_rank():
    """东财股票热度前 100
    排名取自东财 emappdata 人气榜；价格/涨跌幅字段原依赖 push2 行情接口，
    但该接口在部分网络环境下会被服务端断连，故改用腾讯批量行情补充，
    返回字段与 ak.stock_hot_rank_em 完全一致"""
    resp = requests.post(
        'https://emappdata.eastmoney.com/stockrank/getAllCurrentList',
        json={
            'appId': 'appId01',
            'globalId': '786e4c21-70dc-435a-93bb-38',
            'marketType': '',
            'pageNo': 1,
            'pageSize': 100,
        },
        timeout=15,
    )
    rank_list = resp.json()['data']  # [{sc: 'SH603127', rk: 1}, ...] sc=带市场前缀代码, rk=排名

    # 腾讯批量行情（GBK 编码，~ 分隔）：[1]名称 [3]最新价 [31]涨跌额 [32]涨跌幅
    quotes = {}
    codes = [it['sc'].lower() for it in rank_list]
    for i in range(0, len(codes), 50):
        batch = codes[i:i + 50]
        quote_resp = requests.get('https://qt.gtimg.cn/q=' + ','.join(batch), timeout=15)
        for line in quote_resp.content.decode('gbk', errors='ignore').split(';'):
            line = line.strip()
            if not line.startswith('v_') or '="' not in line:
                continue
            var, raw = line.split('="', 1)
            fields = raw.rstrip('";').split('~')
            if len(fields) > 32:
                quotes[var[2:]] = fields  # v_sh603127 → key 'sh603127'

    rows = []
    for it in rank_list:
        q = quotes.get(it['sc'].lower(), [])
        rows.append({
            '当前排名': it.get('rk'),
            '代码': it['sc'],
            '股票名称': q[1] if len(q) > 1 else None,
            '最新价': _parse_float(q[3]) if len(q) > 3 else None,
            '涨跌额': _parse_float(q[31]) if len(q) > 31 else None,
            '涨跌幅': _parse_float(q[32]) if len(q) > 32 else None,
        })
    return pd.DataFrame(rows)


def get_foreign_commodity(symbol="OIL"):
    """外盘期货实时行情（新浪）
    symbol 可传多个、逗号分隔，取值见 ak.futures_hq_subscribe_exchange_symbol()
    常用：OIL=布伦特原油, GC=COMEX黄金(纽约金), XAU=伦敦金, CL=NYMEX原油, SI=COMEX白银
    返回 名称/最新价/涨跌额/涨跌幅/开盘价/最高价/最低价/昨日结算价/买价/卖价/行情时间/日期"""
    return ak.futures_foreign_commodity_realtime(symbol=symbol)


def get_stock_news(symbol="603777"):
    """个股新闻（东财）symbol 为 6 位股票代码
    返回 关键词/新闻标题/新闻内容/发布时间/文章来源/新闻链接，按发布时间倒序（最新在前）"""
    df = ak.stock_news_em(symbol=symbol)
    # 发布时间为 'YYYY-MM-DD HH:MM:SS' 字符串，可直接按字典序倒序
    return df.sort_values('发布时间', ascending=False) if not df.empty else df


def get_stock_zyjs(symbol="000066"):
    """主营介绍（同花顺）symbol 为 6 位股票代码，返回 股票代码/股票简称/主营业务 等"""
    return ak.stock_zyjs_ths(symbol=symbol)


def get_institution_participation(symbol="600000"):
    """东财千股千评-主力控盘-机构参与度（按交易日）
    symbol 为 6 位股票代码（不带市场前缀），返回 交易日/机构参与度 两列"""
    return ak.stock_comment_detail_zlkp_jgcyd_em(symbol=symbol)


def get_sector_spot(indicator="新浪行业"):
    """新浪行业-板块行情 indicator 可选: {'新浪行业', '启明星行业', '概念', '地域', '行业'}"""
    return ak.stock_sector_spot(indicator=indicator)


def get_sector_detail(sector="hangye_ZL01"):
    """新浪行业-板块成分股详情 sector 取 stock_sector_spot 返回的 label 字段"""
    return ak.stock_sector_detail(sector=sector)


def _to_plain(value):
    """把 DataFrame 单元格的值转换为可 JSON 序列化的普通类型"""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    if isinstance(value, pd.Timestamp):
        return value.strftime('%Y-%m-%d %H:%M:%S')
    if isinstance(value, datetime):
        return value.strftime('%Y-%m-%d')
    if isinstance(value, date):
        return value.strftime('%Y-%m-%d')
    if isinstance(value, time):
        return value.strftime('%H:%M:%S')
    if hasattr(value, 'item'):
        # numpy 标量 → python 原生类型
        return value.item()
    return value


def df_to_records(df):
    """DataFrame → list[dict]，字段名保持 akshare 原样"""
    return [
        {str(k): _to_plain(v) for k, v in row.items()}
        for row in df.to_dict('records')
    ]


FETCHERS = {
    'cls_news': get_cls_news,
    'board_change': get_board_change,
    'stock_changes': get_stock_changes,
    'stock_changes_all': get_stock_changes_all,
    'hot_rank': get_hot_rank,
    'foreign_commodity': get_foreign_commodity,
    'stock_news': get_stock_news,
    'stock_zyjs': get_stock_zyjs,
    'jgcyd': get_institution_participation,
    'sector_spot': get_sector_spot,
    'sector_detail': get_sector_detail,
}

# 各命令第二个命令行参数对应的形参名（未列出的命令忽略第二个参数）
ARG_NAMES = {
    'cls_news': 'symbol',
    'stock_changes': 'symbol',
    'foreign_commodity': 'symbol',
    'stock_news': 'symbol',
    'stock_zyjs': 'symbol',
    'jgcyd': 'symbol',
    'sector_spot': 'indicator',
    'sector_detail': 'sector',
}


def fetch_as_json(cmd, **kwargs):
    """执行指定接口并以 list[dict] 形式返回数据
    eastmoney 对部分网络环境偶发断连：直连失败自动重试，仍失败回退走系统代理交替重试"""
    fetcher = FETCHERS[cmd]
    last_err = None
    use_system_proxy = False
    for attempt in range(4):
        try:
            if use_system_proxy:
                urllib.request.getproxies = _ORIG_GETPROXIES
                _requests_utils.getproxies = _ORIG_GETPROXIES
            else:
                urllib.request.getproxies = lambda: {}
                _requests_utils.getproxies = urllib.request.getproxies
            return df_to_records(fetcher(**kwargs))
        except Exception as e:
            last_err = e
            # 直连、直连、系统代理、系统代理 交替重试
            use_system_proxy = attempt >= 1
            time_mod.sleep(2)
    raise last_err


if __name__ == '__main__':
    if len(sys.argv) < 2 or sys.argv[1] not in FETCHERS:
        print(json.dumps({
            'success': False,
            'message': '用法: python3 api.py <cls_news|board_change|stock_changes|stock_changes_all|hot_rank|foreign_commodity|stock_news|stock_zyjs|jgcyd|sector_spot|sector_detail> [参数]',
        }, ensure_ascii=False))
        sys.exit(1)

    _cmd = sys.argv[1]
    try:
        _kwargs = {}
        # 第二个参数：cls_news/stock_changes 为类型，jgcyd 为股票代码，sector_spot 为板块类型，sector_detail 为板块 label
        if len(sys.argv) > 2 and _cmd in ARG_NAMES:
            _kwargs[ARG_NAMES[_cmd]] = sys.argv[2]
        _data = fetch_as_json(_cmd, **_kwargs)
        print(json.dumps({'success': True, 'data': _data}, ensure_ascii=False))
    except Exception as _e:
        print(json.dumps({'success': False, 'message': str(_e)}, ensure_ascii=False))

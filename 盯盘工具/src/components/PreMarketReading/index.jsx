import React, { useRef, useState } from 'react';
import { Typography, Card, Tag, Space, Divider, Alert, Image, Anchor, Row, Col, Tooltip, Button, message } from 'antd';
import { BookOutlined, InfoCircleOutlined, CheckCircleOutlined, WarningOutlined, BulbOutlined, UnorderedListOutlined, RiseOutlined, AlertOutlined, CopyOutlined } from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../constant';
import { getThemeColor } from '../../utils/theme';
import guzhiqihuojiaoge from '../../assets/guzhiqihuojiaoge.png';
import zhongxinCase from '../../assets/20260529-中芯国际.png';
import zhongxinFenshi from '../../assets/20260529-中芯国际分时.png';
import hanwujiCase from '../../assets/20260529-寒武纪.png';
import hanwujiFenshi from '../../assets/20260529-寒武纪分时.png';
import kejiqingxuzhishu0529 from '../../assets/20260529-科技情绪指数.png';
import chuangyebanzhi20260601 from '../../assets/20260601-创业板指.png';
import lixunjingmi20260601 from '../../assets/20260601-立讯精密.png';
import haohuanengyuan20260601 from '../../assets/20260601-昊华能源.png';
import chuangyebanzhi20260602 from '../../assets/20260602-创业板指.png';
import gongyefulian20260602 from '../../assets/20260602-工业富联.png';
import lixunjingmi20260603 from '../../assets/20260603-立讯精密.png';
import chuangyebanzhi20260603 from '../../assets/20260603-创业板指.png';
import kejiqingxu0603 from '../../assets/20260603-科技情绪指数.png';
import kejiqingxu0605 from '../../assets/20260605-科技情绪指数.png';
import tianfutongxin0605 from '../../assets/20260605-天孚通信.png';
import yuanjiekeji0605 from '../../assets/20260605-源杰科技.png';
import kejiqingxuzhishu0608 from '../../assets/20260608-科技情绪指数.png';
import zhongchuanteqi0609 from '../../assets/20260609-中船特气.png';
import hudiangufen0609 from '../../assets/20260609-沪电股份.png';
import lianxunguangong0609 from '../../assets/20260609-联讯仪器.png';
import hanwuji0610 from '../../assets/20260610-寒武纪.png';
import zhulizijin0610 from '../../assets/20260610-主力资金.png';
import yingweike0610 from '../../assets/20260610-英维克.png';
import yuanjiekeji0610 from '../../assets/20260610-源杰科技.png';
import shengyikeji0610 from '../../assets/20260610-生益科技.png';
import huahong0610 from '../../assets/20260610-华虹.png';
import shangzheng0611 from '../../assets/20260611-上证指数.png';
import zhongjixuchuang0612 from '../../assets/20260612-中际旭创.png';
import xinyisheng0612 from '../../assets/20260612-新易盛.png';
import dapangailan0618 from '../../assets/20260618-大盘概览.png';
import zhaoyichuangxin0623 from '../../assets/20260623-兆易创新.png';
import chuangyebanzhi0623 from '../../assets/20260623-创业板指.png';
import zhaoyichuangxin0708 from '../../assets/20260708-兆易创新.png';
import zhulizijin0713 from '../../assets/20260713-主力资金.png';
import zhishuhezhaoyichuangxin0713 from '../../assets/20260713-指数&兆易创新.png';
import zhulizijin20260819 from '../../assets/主力资金净流入-20260819.png'; 
import guojifucai20260819 from '../../assets/国际复材分时-20260819.png'; 
import chuangyebanzhi20260819 from '../../assets/创业板指-20260819.png'; 
import guojifucai20260820 from '../../assets/20260820-国际复材.png'; 
import dingtaigaoke20260820 from '../../assets/20260820-鼎泰高科.png';
import './index.scss';

const { Title, Paragraph, Text } = Typography;

const PreMarketReading = () => {
  const scrollContainerRef = useRef(null);
  const contentRef = useRef(null);
  const [copyLoading, setCopyLoading] = useState(false);

  const handleCopyData = async () => {
    setCopyLoading(true);
    try {
      const [chuangyebanRes, kechuangbanRes, emotionRes, amountRes] = await Promise.all([
        axios.get(`http://${local_ip}:3000/stock_data?code=sz399006&limit=100`),
        axios.get(`http://${local_ip}:3000/stock_data?code=sh000688&limit=100`),
        axios.get(`http://${local_ip}:3000/emotion_data`),
        axios.get(`http://${local_ip}:3000/amount_history`),
      ]);

      const historicalExperience = contentRef.current ? contentRef.current.innerText : '';

      const result = {
        '创业板 k 线数据': chuangyebanRes.data,
        '科创板 k 线数据': kechuangbanRes.data,
        '科技情绪指数数据': emotionRes.data.techIndexData || [],
        '主力资金流入流出分时数据': amountRes.data || {},
        '历史经验总结教训事项': historicalExperience,
      };

      const jsonStr = JSON.stringify(result, null, 2);
      await navigator.clipboard.writeText(jsonStr);
      message.success('数据已复制到粘贴板');
    } catch (error) {
      console.error('复制数据失败:', error);
      message.error('复制数据失败，请重试');
    } finally {
      setCopyLoading(false);
    }
  };

  const menuItems = [
    { key: 'weak-shock', href: '#weak-shock', title: '指数猛跌之后必然要筑底 1-2 周，不要着急猛冲', strong: true },
    { key: 'high-volume-yin', href: '#high-volume-yin', title: '高位放量大阴线信号', strong: true },
    { key: 'outflow-rebound-0610', href: '#outflow-rebound-0610', title: '大盘资金净流出，个股容易冲高回落', strong: true },
    { key: 'case-zhongxin', href: '#case-zhongxin', title: '高位票竞价和开盘不及预期直接卖', strong: true },
    { key: 'case-hanwuji', href: '#case-hanwuji', title: '清仓之后不操作' },
    { key: 'case-inducement', href: '#case-inducement', title: '未到情绪冰点不出手', strong: true },
    { key: 'rebound-strategy', href: '#rebound-strategy', title: '指数过于高开必低走-祖训', strong: true },
    { key: 'outflow-warning', href: '#outflow-warning', title: '资金净流出加速风险', strong: true },
    { key: 'case-0605', href: '#case-0605', title: '一周期一次出手纪律' },
    { key: 'timing-selection', href: '#timing-selection', title: '择时大于选股' },
    { key: 'rebound-dip', href: '#rebound-dip', title: '大家都跌你不跌，那你就会补跌', strong: true},
    { key: 'capital-flow-index', href: '#capital-flow-index', title: '大盘资金净流出而指数红盘的原因' },
    { key: 'handle-pullback', href: '#handle-pullback', title: '指数大涨后的深度回调处理', strong: true },
    { key: 'subjective-objective', href: '#subjective-objective', title: '主观逻辑->情绪周期->主力资金流入流出', strong: true },
    { key: 'outflow-deception-0713', href: '#outflow-deception-0713', title: '主力资金持续流出的诱多陷阱', strong: true },
    { key: 'overnight-crisis-rebound', href: '#overnight-crisis-rebound', title: '隔夜利空开盘大跌等 10 点拉升再走', strong: true },
    { key: 'no-financial-report', href: '#no-financial-report', title: '刚发完财报的股票不能买', strong: true },
  ].map(item => ({
    ...item,
    title: (
      <Tooltip title={item.title} placement="top">
        <span className={item.strong ? 'anchor-item-strong' : ''}>
          {item.title}
        </span>
      </Tooltip>
    )
  }));

  return (
    <div className="pre-market-reading-wrapper" ref={scrollContainerRef}>
      <Row gutter={24} style={{ margin: 0 }}>
        <Col span={6} className="sidebar-col">
          <Card className="anchor-card" variant="borderless">
            <div className="anchor-header">
              <UnorderedListOutlined /> <Text strong>文章目录</Text>
            </div>
            <Anchor
              offsetTop={20}
              getContainer={() => scrollContainerRef.current}
              items={menuItems}
              className="custom-anchor"
            />
          </Card>
        </Col>
        <Col span={18} className="content-col">
          <div className="content-wrapper">
            <Button
              className="copy-data-btn"
              type="primary"
              icon={<CopyOutlined />}
              loading={copyLoading}
              onClick={handleCopyData}
            >
              复制盘前阅读数据
            </Button>
          </div>
          <div className="pre-market-reading" ref={contentRef}>
            <Image 
              src={guzhiqihuojiaoge} 
              className="main-image"
              preview={false}
              style={{ width: 500 }}
            /> 

            <Card 
              id="case-zhongxin"
              className="section-card" 
              title={<><BookOutlined style={{ color: '#ff4d4f' }} /> 实战案例复盘: 20260529 中芯国际</>}
              variant="borderless"
            >
              <Paragraph>
                <Text type="secondary">背景回顾：</Text>
                前一交易日上涨 5.12%，次日竞价低开 <Text type="success" strong>-1.81%</Text> 已显颓势。开盘小幅冲高后，9:32 跌至 <Text type="success" strong>-2.28%</Text>。
              </Paragraph>

              <Alert
                className="lesson-alert"
                message="核心教训"
                description={
                  <>
                    <div>竞价不及预期且开盘直线下砸，应果断离场。</div>
                    <Text strong style={{ color: '#cf1322' }}>
                      不赌反转，不取巧招。跌破 -2% 必须走人，只做稳扎稳打的抢筹高开或放量上冲行情。
                    </Text>
                  </>
                }
                type="error"
                showIcon
                icon={<WarningOutlined />}
              />

              <div className="case-image-container">
                <Image 
                  src={zhongxinCase} 
                  className="case-image"
                  placeholder={<div style={{ background: '#f5f5f5', height: 200 }} />}
                />
                <Image 
                  src={zhongxinFenshi} 
                  className="case-image"
                  placeholder={<div style={{ background: '#f5f5f5', height: 200 }} />}
                />
              </div>
            </Card>

            <Card 
              id="case-hanwuji"
              className="section-card" 
              title={<><BookOutlined style={{ color: '#ff4d4f' }} /> 实战案例复盘: 20260529 寒武纪</>}
              variant="borderless"
            >
              <Paragraph>
                <Text type="secondary">背景回顾：</Text>
                寒武纪竞价小幅高开 <Text type="danger" strong>+0.61%</Text>，表现略强于中芯国际。开盘后快速下挫，本人在中芯国际与华虹离场后，反手于 <Text type="success" strong>-2%</Text> 处加仓。然而下午随大盘大幅跳水，最终收跌 <Text type="success" strong>-5.8%</Text>，当日产生二次亏损。<Text type='danger' strong>不要相信个别科技股票的上涨可以带动其他大部分负反馈严重的股票翻红，这个时候的规则是少数服从多数。大多数科技股票如果都表现不好，那个别表现好也不能追！！！</Text>
              </Paragraph>

              <Alert
                className="lesson-alert"
                message="核心教训"
                description={
                  <>
                    <div>当科创指数整体大幅下挫时，指数的“大势”远重于个股的“局部走强”。</div>
                    <Text strong style={{ color: '#cf1322' }}>
                      重形势，重情绪，轻个股。若指数开盘即现猛烈兑现压力，割肉离场后应立即停止操作，坚决空仓，拒绝任何形式的“二次博弈”。
                    </Text>
                  </>
                }
                type="error"
                showIcon
                icon={<WarningOutlined />}
              />


              <div className="case-image-container">
                <Image 
                  src={hanwujiCase} 
                  className="case-image"
                  placeholder={<div style={{ background: '#f5f5f5', height: 200 }} />}
                />
                <Image 
                  src={hanwujiFenshi} 
                  className="case-image"
                  placeholder={<div style={{ background: '#f5f5f5', height: 200 }} />}
                />
              </div>
            </Card>

            <Card 
              id="case-inducement"
              className="section-card" 
              title={<><WarningOutlined style={{ color: '#faad14' }} /> 实战案例复盘: 未到情绪冰点不出手 (20260601)</>}
              variant="borderless"
            >
              <Paragraph>
                <span style={{ color: 'red', fontWeight: 'bold' }}>科技情绪指数前一日 0529 只有 -58，并没有到 -100 以下，说明情绪退潮的不彻底，市场情绪还没有到冰点.</span>这个时候最多只能<span style={{ color: 'red' }}>半仓操作</span>。因为随时有可能会冲高回落。果然 0601 当天上午冲高，但是下午大盘就大幅跳水，上午追高资金悉数被套。
              </Paragraph>

              <Alert
                className="lesson-alert"
                message="博弈逻辑"
                description={
                  <>
                    <div>只能在冰点（情绪指数-30以下）博弈</div>
                    <Text strong style={{ color: '#cf1322' }}>
                      大盘非冰点的时候，最多只能半仓操作，不能全仓，随时会<span style={{color: 'red', fontWeight: 'bold'}}>冲高回落</span>
                    </Text>
                  </>
                }
                type="warning"
                showIcon
                icon={<BulbOutlined />}
              />
              <Divider>当天的科技情绪指数没有到 -100 以下，情绪降温不彻底</Divider>
              <Image src={kejiqingxuzhishu0529}></Image>

              <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>案例 1: 创业板指缩量诱多</Text></Divider>
              <div className="case-image-container single">
                <Image src={chuangyebanzhi20260601} className="case-image" />
              </div>

              <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>案例 2: 立讯精密 (高位科技股受挫)</Text></Divider>
              <Paragraph>
                早上跟随指数大幅冲高，午后随指数回落直接“按在水底”。
              </Paragraph>
              <div className="case-image-container single">
                <Image src={lixunjingmi20260601} className="case-image" />
              </div>

            </Card>

            <Card 
              id="rebound-strategy"
              className="section-card" 
              title={<><BulbOutlined style={{ color: '#52c41a' }} /> 指数过于高开必低走(20260602)</>}
              variant="borderless"
            >
              <Paragraph>
                <Text type="secondary">市场规律：</Text>
                当市场连续下跌后，若市场一致预期反弹，次日往往会出现高开（例如创业板直接高开1%左右）。
                但这类反弹通常不会开盘就持续上攻，反而会先下探挖坑，等待开盘后20-30分钟，大约在
                <Text strong style={{ color: '#cf1322' }}>10:00-10:30</Text> 这个时间窗口，如果此时出现<span style={{ color: '#cf1322' }}>放量上涨</span>，才是确认反弹的信号。
              </Paragraph>
              <Alert
                className="lesson-alert"
                message="操作策略"
                description={
                  <>
                    <div>持仓者：开盘高开时可先减仓或离场，等待下探后放量启动的节点再低吸接回</div>
                    <div>空仓者：不要开盘就追高买入，耐心等待10点前后的放量确认信号，避免接盘诱多高开</div>
                    <Text strong style={{ color: '#137722', marginTop: 8, display: 'block' }}>
                      核心逻辑：反弹的确定性需要量能和时间窗口双重验证，避开早盘的情绪性冲动交易
                    </Text>
                  </>
                }
                type="success"
                showIcon
                icon={<CheckCircleOutlined />}
              />
              <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>指数表现</Text></Divider>
              <div className="case-image-container single">
                <Image src={chuangyebanzhi20260602} className="case-image" />
              </div>
              <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>个股表现</Text></Divider>
              <div className="case-image-container single">
                <Image src={gongyefulian20260602} className="case-image" />
              </div>
            </Card>
            
            <Card 
              id="outflow-warning"
              className="section-card" 
              title={<><WarningOutlined style={{ color: '#faad14' }} /> 实战案例复盘: 资金净流出加速风险 (20260603)</>}
              variant="borderless"
            >
              <Paragraph>
                <Text type="secondary">盘面现象：</Text>
                20260603 上午，创业板一度冲高 <Text strong style={{ color: '#cf1322' }}>4%</Text>，市场情绪高涨。但午后形势突变，国家队大幅减持沪深 300ETF，导致大盘高位跳水。
              </Paragraph>

              <Alert
                className="lesson-alert"
                message="风险信号"
                description={
                  <>
                    <div>关注资金流出速度：上午净流入 +100 亿，下午快速转为流出，最终收盘 <Text strong style={{ color: 'green' }}>-280 亿</Text>。</div>
                    <Text strong style={{ color: '#cf1322', marginTop: 8, display: 'block' }}>
                      核心教训：一旦观察到大盘资金净流出速度显著加快，必须立即减仓，不可对反弹抱有幻想！汪汪队一定开始大幅度减仓，往往都是持续两三天的操作，不可能只有一天！
                    </Text>
                    <Text strong style={{ color: '#cf1322', marginTop: 8, display: 'block' }}>另外科技情绪指数已经连续两天大于 100，其实已经情绪过热了，此时冲高回落其实是大概率的事情，这个时候就不适合出手博弈，最好持股观望，或者是空仓等待下一次冰点的博弈机会！！！</Text>
                  </>
                }
                type="warning"
                showIcon
                icon={<WarningOutlined />}
              />

              <div className="case-image-container">
                <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>科技情绪指数表现</Text></Divider>
              <div className="case-image-container single">
                <Image 
                  src={kejiqingxu0603} 
                  className="case-image"
                  placeholder={<div style={{ background: '#f5f5f5', height: 200 }} />}
                />
              </div>
              <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>指数表现</Text></Divider>
              <div className="case-image-container single">
                <Image 
                  src={chuangyebanzhi20260603} 
                  className="case-image"
                  placeholder={<div style={{ background: '#f5f5f5', height: 200 }} />}
                />
              </div>
              <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>个股表现</Text></Divider>
              <div className="case-image-container single">
                <Image 
                  src={lixunjingmi20260603} 
                  className="case-image"
                  placeholder={<div style={{ background: '#f5f5f5', height: 200 }} />}
                />
              </div>
              </div>
            </Card>

            <Card 
              id="case-0605"
              className="section-card" 
              title={<><CheckCircleOutlined style={{ color: '#eb2f96' }} /> 核心纪律: 一个星期只有一次全仓机会 (2026-06-05)</>}
              variant="borderless"
            >
              <Paragraph>
                <Text type="secondary">背景回顾：</Text>
                2026-06-02 至 06-04，科技情绪指数已连续 <Text strong style={{ color: '#cf1322' }}>三天超过 100</Text>。市场处于明显的情绪过热阶段，风险极大。<span style={{ color: '#cf1322' }}>自己的纪律也是未到情绪冰点不出手</span>
              </Paragraph>

              <Alert
                className="lesson-alert"
                message="操作失误"
                description={
                  <>
                    <div>在情绪高潮期，面对 CPO 光模块开盘冲高，未能克制欲望，实施了 <Text strong style={{ color: '#cf1322' }}>全仓追高</Text> 操作。</div>
                    <div style={{ marginTop: 8 }}>
                      <Space direction="vertical" size={0}>
                        <span>• 源杰科技: <Text strong>3.4%</Text> 买入 → 收盘 <Text strong type="success">-3.87%</Text> (当日回撤 <Text strong type="danger">-7.27%</Text>)</span>
                        <span>• 天孚通信: <Text strong>2.2%</Text> 买入 → 收盘 <Text strong type="success">-4.88%</Text> (当日回撤 <Text strong type="danger">-7.08%</Text>)</span>
                      </Space>
                    </div>
                  </>
                }
                type="error"
                showIcon
                icon={<WarningOutlined />}
              />

              <Alert
                className="lesson-alert"
                message="核心策略 (必须死守)"
                description={
                  <>
                    <div>1. <Text strong>出手时机</Text>：真正适合全仓出手的机会，一个星期通常只有一次。即科技指数情绪 <Text strong style={{ color: '#cf1322' }}>低于 -30</Text> 或 <Text strong style={{ color: '#cf1322' }}>连续多日为负</Text> 后的次日。</div>
                    <div>2. <Text strong>识别诱多</Text>：非冰点后的早盘冲高，大概率是冲高回落套人。</div>
                    <div>3. <Text strong>仓位管理</Text>：冰点次日可全仓+追高；其他时间要么空仓，要么持股，最多 <Text strong>半仓</Text> 博弈。</div>
                    <Text strong style={{ color: '#cf1322', marginTop: 8, display: 'block' }}>
                      宁可踏空，绝不被冲高回落套住！冲高回落是对“早上追高+重仓”模式的最大威胁。
                    </Text>
                  </>
                }
                type="success"
                showIcon
                icon={<BulbOutlined />}
              />

              <div className="case-image-container">
                <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>情绪背景: 连续三天过热</Text></Divider>
                <Image src={kejiqingxu0605} className="case-image" />
                
                <Row gutter={16} style={{ marginTop: 16 }}>
                  <Col span={12}>
                    <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>错误案例: 天孚通信冲高回落</Text></Divider>
                    <Image src={tianfutongxin0605} className="case-image" />
                  </Col>
                  <Col span={12}>
                    <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>错误案例: 源杰科技大幅回撤</Text></Divider>
                    <Image src={yuanjiekeji0605} className="case-image" />
                  </Col>
                </Row>
              </div>
            </Card>
            
            <Card 
              id="timing-selection"
              className="section-card"
              title={'择时大于选股(0608)'}
              style={{ marginTop: 16 }} 
            >
              <Alert
                className="lesson-alert"
                message="核心理念"
                description={
                  <>
                    <Text strong>择时大于选股，过程大于结果。</Text>
                  </>
                }
                type="info"
                showIcon
                icon={<InfoCircleOutlined />}
              />
              <Alert
                className="lesson-alert"
                message="冰点出击策略"
                description={
                  <>
                    <div>当市场处于<Text strong type="danger">连续冰点</Text>时，应积极寻找当天<Text strong type="success">表现强势的个股出手</Text>，而非纠结于单次操作的盈亏。</div>
                  </>
                }
                type="success"
                showIcon
                icon={<CheckCircleOutlined />}
              />
              <div className="principle-content">
                <Text type="secondary">好比打篮球有空位就该投篮，此时不投，更待何时？</Text>
              </div>
              <Alert
                className="lesson-alert"
                message="结果导向不如过程正确"
                description={
                  <>
                    <div>我们应只关注<Text strong>过程是否合理正确</Text>，而非个别交易的短期结果。</div>
                    <Text strong type="success" style={{ display: 'block', marginTop: 8 }}>只要过程正确，重复多次，最终必将盈利。</Text>
                  </>
                }
                type="success"
                showIcon
                icon={<CheckCircleOutlined />}
              />
                <Image src={kejiqingxuzhishu0608} className="principle-image"></Image>
            </Card>

            <Card
              id="rebound-dip"
              className="section-card"
              title={<><InfoCircleOutlined style={{ color: getThemeColor() }} /> 退潮期强势个股，在反弹第一天往往会补跌(0609)</>}
              variant="borderless"
            >
              <Paragraph>
                退潮期强势的个股，往往是板块中逻辑最硬，业绩最优的个股，在退潮期机构为了避险只能抱团这种龙头股。但是一旦市场情绪开始反弹，那么由于这个龙头已经上涨过了，所以资金会先撤出来，然后去低位洼地的同板块的其他个股。因此在反弹的第一天往往会看到退潮期抗跌的龙头，反而表现不如后排的小弟
              </Paragraph>
              <Paragraph>
                <Text type="secondary">案例一：</Text>在退潮期连续两天强势的中船特气，反而在 6.09 市场情绪反弹的第一天，反而还是下跌的
              </Paragraph>
              <Paragraph>
                <Text type="secondary">案例二：</Text>在退潮期连续上涨的联讯仪器，是光模块测试设备的龙头，但是在 6.09 市场情绪反弹的第一天，新易盛上涨了 8 个点，而它只涨了 0.19%
              </Paragraph>
              <Paragraph>
                <Text type="secondary">案例三：</Text>在退潮期率先开始反弹抗跌的沪电股份，但是在 6.09 这一天情绪反弹的第一天，深南和胜宏都是七八个点的涨幅，沪电只有不到 3 个点
              </Paragraph> 
              <Image src={zhongchuanteqi0609}></Image>
              <Image src={lianxunguangong0609}></Image>
              <Image src={hudiangufen0609}></Image>
            </Card>

            <Card id="outflow-rebound-0610" className="section-card" title={<><BookOutlined style={{ color: '#ff4d4f' }} /> 操他妈了个逼！(20260610)</>} variant="borderless">
              <Alert
                className="lesson-alert"
                message={<Text strong style={{ fontSize: '16px' }}>大盘资金净流出，个股大概率冲高回落！</Text>}
                description={
                  <>
                    <Paragraph>
                      当市场主力资金持续净流出时，任何个股的短期冲高都难以维系，最终大概率会被大盘拖累回落。
                      此时应坚决避免<Text strong type="danger">追高</Text>，核心关注<Text strong>资金流向趋势</Text>。
                    </Paragraph>
                    <Paragraph>
                      早盘一旦发现情况不对劲，尤其在大盘主力资金持续流出背景下，应立即<Text strong type="danger">清仓手中持仓</Text>。
                      切勿追逐其他早盘强势股，它们极大概率也会<Text strong type="danger">冲高回落</Text>。
                    </Paragraph>
                  </>
                }
                type="warning"
                showIcon
                icon={<WarningOutlined />}
              />

              <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>大盘主力资金趋势</Text></Divider>
              <Image src={zhulizijin0610} className="case-image" />

              <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>案例分析: 冲高回落个股</Text></Divider>
              <Paragraph>比如寒武纪</Paragraph>
              <Image src={hanwuji0610} className="case-image" />
              <Paragraph>比如英维克</Paragraph>
              <Image src={yingweike0610} className="case-image" />
              <Paragraph>比如华虹股份</Paragraph>
              <Image src={huahong0610} className="case-image" />

              <Alert
                className="lesson-alert"
                message={<Text strong style={{ fontSize: '16px' }}>个人案例反思：顽强个股的抉择</Text>}
                description={
                  <>
                    <Paragraph>
                      自己买的持仓在大盘资金净流出的时候表现还挺顽强，这个时候就<Text strong type="success">不要卖了</Text>，因为搞不好尾盘就给你拉回来了。
                      就比如这一天的持仓是<Text strong>源杰科技</Text>和<Text strong>生益科技</Text>，其实当天这两个也就开盘和中间某个时间段跌的多，尾盘基本上都拉回来了。
                      如果不卖的话，其实当天平均一下，收盘才亏了一个点左右。
                    </Paragraph>
                    <Paragraph>
                      但是就是因为自己早上把这两个全卖了，然后去追高其他的个股，结果导致当天<Text strong type="danger">亏了快 5 个点</Text>。
                      这个错误已经犯了很多次了，后面再犯我就是狗！！！
                    </Paragraph>
                  </>
                }
                type="info"
                showIcon
                icon={<BulbOutlined />}
              />
              <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>案例分析: 顽强个股</Text></Divider>
              <Paragraph>源杰科技</Paragraph>
              <Image src={yuanjiekeji0610} className="case-image" />
              <Paragraph>生益科技</Paragraph>
              <Image src={shengyikeji0610} className="case-image" />

              <Alert
                className="lesson-alert"
                message={<Text strong style={{ fontSize: '16px' }}>操盘三条铁律</Text>}
                description={
                  <Space direction="vertical">
                    <Paragraph>1. <Text strong type="danger">如果当天大盘的资金在持续净流出，并且大部分个股都在下跌，这个时候就赶快卖掉自己手中的持仓！</Text></Paragraph>
                    <Paragraph>2. <Text strong type="success">如果一开盘发现自己的持仓表现的还挺顽强，那开盘没卖，后面就也别再卖了。到尾盘大概率就会被拉起来。</Text></Paragraph>
                    <Paragraph>3. <Text strong type="warning">如果一开始卖掉自己手中的持仓，不能去追其他的早盘强势个股，就算有利好刺激消息也不行，大概率会回落被带下来。</Text></Paragraph>
                    <Paragraph strong style={{ color: 'red', fontStyle: 'italic' }}>总而言之，要么就开盘操作，要是开盘没操作后面就也别再有任何操作了。唯一可以操作的就是等尾盘的时候，看看拿点先手博弈次日的反弹！</Paragraph>
                  </Space>
                }
                type="success"
                showIcon
                icon={<CheckCircleOutlined />}
              />
            </Card>

            <Card
              id="weak-shock"
              className="section-card"
              title={<><WarningOutlined style={{ color: '#faad14' }} /> 指数猛跌之后必然要筑底 1-2 周，不要着急猛冲(20260611)</>}
              variant="borderless"
            >
              <Alert
                className="lesson-alert"
                message="市场阶段特征"
                description="大盘下跌到底部不会立刻反转，而是会弱势震荡一段时间。这个阶段的核心特征是：全天轮动较快，目的是为了护指数。"
                type="info"
                showIcon
                icon={<InfoCircleOutlined />}
              />

              <Paragraph style={{ marginTop: 16 }}>
                例如：当天开盘先拉 <Text strong>CPO</Text>，后来拉 <Text strong>寒武纪</Text>，最后拉 <Text strong>宁德时代</Text>。同时 <Text strong>银行</Text>、<Text strong>证券</Text> 都在上涨，目的就是为了在这个位置护住指数不继续下跌。
              </Paragraph>

              <Alert
                className="lesson-alert"
                message="操作铁律"
                description={
                  <>
                    <Paragraph>
                      <Text strong style={{ color: '#cf1322' }}>绝对不会在这个地方立刻开始主升浪行情，所以一旦涨的多就会被砸下来。</Text>
                    </Paragraph>
                    <Paragraph>
                      这个时候千万不能追高，最重要的就是要在这段时间内<Text strong type="danger">管住手</Text>。
                    </Paragraph>
                    <Paragraph>
                      <Text strong style={{ color: '#cf1322', fontSize: '18px' }}>空仓最重要。只要不放量大阳线就不开仓。</Text>
                    </Paragraph>
                  </>
                }
                type="warning"
                showIcon
                icon={<WarningOutlined />}
              />
              <Image src={shangzheng0611} className="case-image" />
            </Card>

            <Card
              id="high-volume-yin"
              className="section-card"
              title={<><WarningOutlined style={{ color: '#cf1322' }} /> 高位放量大阴线信号(0612)</>}
              variant="borderless"
            >
              <Alert
                className="lesson-alert"
                message="核心信号识别"
                description={
                  <div>
                    <Paragraph style={{ margin: 0 }}>
                      <Text strong style={{ color: '#cf1322' }}>高位放量大阴线</Text>，一般表示中期内行情就结束了。
                    </Paragraph>
                    <Paragraph style={{ margin: 0 }}>
                      <Text strong>判断标准：</Text>一个股票如果中期（两三个月内）上涨了接近一倍，这基本上就已经是在高位了。
                    </Paragraph>
                  </div>
                }
                type="error"
                showIcon
                icon={<WarningOutlined />}
              />

              <Alert
                className="lesson-alert"
                message="案例一：中际旭创 (0605)"
                description={
                  <div>
                    <Paragraph style={{ margin: 0 }}>
                      中际旭创 0605 这一天的放量大阴线，就是预示着 <Text strong>CPO 行情的结束</Text>。
                    </Paragraph>
                    <Paragraph style={{ margin: 0 }}>
                      上一轮市场风格主要是围绕海外算力硬件在炒作，但是龙头这里直接一根放量大阴线，也是表示市场风格已经开始切换了。
                    </Paragraph>
                    <Paragraph style={{ margin: 0 }}>
                      <Text strong style={{ color: '#cf1322' }}>操作建议：中期内至少一个月，这个方向不用再看了。</Text>
                    </Paragraph>
                  </div>
                }
                type="info"
                showIcon
                icon={<InfoCircleOutlined />}
              />

              <div style={{ marginTop: 16, marginBottom: 16 }}>
                <Image src={zhongjixuchuang0612} />
              </div>

              <Alert
                className="lesson-alert"
                message="案例二：新易盛 (0611-0612)"
                description={
                  <div>
                    <Paragraph style={{ margin: 0 }}>
                      新易盛 0611 这一天也是一根放量大阴线，虽然有传什么二季度业绩不及预期这样的小作文导致的。
                    </Paragraph>
                    <Paragraph style={{ margin: 0 }}>
                      但是可以看到 0612 这一天也是大阴线。所以其实只要高位放量大阴线，基本上就是行情结束的标志。
                    </Paragraph>
                  </div>
                }
                type="warning"
                showIcon
                icon={<BulbOutlined />}
              />

              <div style={{ marginTop: 16, marginBottom: 16 }}>
                <Image src={xinyisheng0612} />
              </div>

              <Alert
                className="lesson-alert"
                message="操作铁律"
                description={
                  <div>
                    <Paragraph style={{ margin: 0 }}>
                      <Text strong style={{ color: '#cf1322', fontSize: '16px' }}>不要有幻想了，短期内是不可能再拉起来了。</Text>
                    </Paragraph>
                    <Paragraph style={{ margin: 0 }}>
                      你可以去看看别的方向，去想想当下市场的风格是不是已经开始切换了。
                    </Paragraph>
                  </div>
                }
                type="error"
                showIcon
                icon={<CheckCircleOutlined />}
              />
            </Card>

            <Card
              id="capital-flow-index"
              className="section-card"
              title={<><InfoCircleOutlined style={{ color: getThemeColor() }} /> 大盘资金净流出而指数红盘的原因（20260618）</>}
              variant="borderless"
            >
              <Alert
                className="lesson-alert"
                message="资金统计机制"
                description="软件统计资金净流入和流出：是统计那些主动买入或者是主动卖出的大单。也就是说被动买入或者被动卖出的大单不会被统计到。另外小单也不会被统计到。这其实就给了大资金一些操作的空间。他们可以大单买，小单卖。或者是大单卖，小单买。"
                type="info"
                showIcon
                icon={<InfoCircleOutlined />}
              />

              <Alert
                className="lesson-alert"
                style={{ marginTop: 16 }}
                message="指数红盘的本质"
                description="指数红盘只取决于那些有指数权重的个股是否上涨。而这些指数权重个股，可能是正在主升的龙头板块。也有可能是低位的板块。"
                type="success"
                showIcon
                icon={<CheckCircleOutlined />}
              />

              <Alert
                className="lesson-alert"
                style={{ marginTop: 16 }}
                message="核心原因：市场风格切换或高低切"
                description={
                  <>
                    <div>大盘资金净流出，而指数红盘。更有可能是市场风格的切换 or 资金在题材内部做高低切。</div>
                    <div style={{ marginTop: 8 }}>
                      <Text strong>机制：</Text>资金正在从一些高位的股票中流出（大盘资金净流出的原因），然后流入了一些低位的股票（有指数权重）。这样就形成了一种大盘资金在加速净流出，而指数却依然保持红盘的原因。
                    </div>
                  </>
                }
                type="warning"
                showIcon
                icon={<BulbOutlined />}
              />

              <Alert
                className="lesson-alert"
                style={{ marginTop: 16 }}
                message="当下市场分析"
                description="对当下的市场而言，更有可能是因为资金从白酒，银行，消费等价值权重股流出，然后去了创业板或者是科创板带有指数权重的股票，所以造成了这种现象，这是市场风格的切换。"
                type="info"
                showIcon
                icon={<InfoCircleOutlined />}
              />

              <Alert
                className="lesson-alert"
                style={{ marginTop: 16 }}
                message={<Text strong style={{ fontSize: '16px' }}>核心判断（必须牢记）</Text>}
                description={
                  <>
                    <div>总而言之，当大盘资金净流出加速的时候，肯定是有一些板块在大量失血。</div>
                    <div style={{ marginTop: 8 }}>
                      <Text strong type="danger">如果是当下热门的板块在大幅下跌，那说明是市场在退潮。</Text>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <Text strong type="success">如果不是热门的板块在下跌，那一般是从其他的板块抽血，是市场资金极致抱团的一种体现。</Text>
                    </div>
                  </>
                }
                type="error"
                showIcon
                icon={<WarningOutlined />}
              />

              <div style={{ marginTop: 16 }}>
                <Image src={dapangailan0618} className="case-image" />
              </div>
            </Card>

            <Card
              id="handle-pullback"
              className="section-card"
              title={<><BulbOutlined style={{ color: '#faad14' }} /> 指数大涨后，如何成功处理深度回调 (20260623)</>}
              variant="borderless"
            >
              <Alert
                className="lesson-alert"
                message="市场规律"
                description="指数上涨较多的情况下，肯定要深度回调个一两天，大概回调幅度至少 3 个点起步。"
                type="info"
                showIcon
                icon={<InfoCircleOutlined />}
              />
              <div style={{ marginTop: 16, marginBottom: 16 }}>
                <Image src={chuangyebanzhi0623} className="case-image" />
              </div>

              <Alert
                className="lesson-alert"
                message={<Text strong style={{ fontSize: '16px' }}>回调应对策略与操作纪律</Text>}
                description={
                  <Space direction="vertical" size="small">
                    <Paragraph style={{ margin: 0 }}>
                      <Text strong type="danger">1. 果断止盈：</Text>
                      当指数上涨较多时，如果高位股票开盘就剧烈兑现，<Text strong>这个时候不要死拿，立刻卖出</Text>。
                    </Paragraph>
                    <Paragraph style={{ margin: 0 }}>
                      <Text strong type="warning">2. 警惕强势诱多：</Text>
                      这个时候很容易有一个迷惑的地方：一些前期强势的股票，上午会延续之前的强势动能继续上涨，或者是下跌之后迅速拉起来，给你一种很强的感觉。但是<Text strong type="danger">这种感觉是错误的！</Text>如果大盘后面持续下跌两三个点，再强的个股也会被带下来。
                    </Paragraph>
                    <Paragraph style={{ margin: 0 }}>
                      <Text strong type="success">3. 抄底时机：</Text>
                      如果想要抄底，<Text strong type="danger">绝对不能在上午抄底</Text>，必须要等到下午或者是快收盘的时候才能抄底。一般大盘如果当日深度回调两三个点乃至四五个点，那么就存在尾盘翘尾的需求，这个时候才是可以去抄底的良机。
                    </Paragraph>
                  </Space>
                }
                type="warning"
                showIcon
                icon={<WarningOutlined />}
              />
              
              <div style={{ marginTop: 16 }}>
                <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>案例分析：兆易创新</Text></Divider>
                <Image src={zhaoyichuangxin0623} className="case-image" />
              </div>
              <Alert
                className="lesson-alert"
                style={{ marginTop: 16 }}
                message={<Text strong style={{ fontSize: '16px' }}>巨大亏损是怎么造成的？（绝对红线）</Text>}
                description={
                  <Space direction="vertical" size="small">
                    <Paragraph style={{ margin: 0 }}>
                      事实上，如果上午跑的及时，最多也就亏损 3-4 个点。下午如果能成功抄底，尾盘反弹还能翘尾 1-2 个点甚至更多，当天就能做到<Text strong type="success">几乎不亏损</Text>。
                    </Paragraph>
                    <Paragraph style={{ margin: 0, padding: '8px 12px', background: '#fff1f0', borderLeft: '4px solid #ff4d4f' }}>
                      <Text strong type="danger">唯一会出现单日 10% 以上巨大回撤的致命操作路径：</Text>
                      <br/>
                      上午在股票 A 上割肉亏损 3-4% <br/>
                      <Text strong>→</Text> <Text underline>随后立刻买入</Text>另外一个上午看起来强势的股票 B <br/>
                      <Text strong>→</Text> 结果股票 B 冲高回落，下午被大盘拖累大跌 7-8% <br/>
                      <Text strong>→</Text> <Text strong type="danger">直接单日回撤 10%+，心态彻底崩盘！</Text>
                    </Paragraph>
                    <Paragraph style={{ margin: 0 }}>
                      <Text strong style={{ color: '#cf1322' }}>规避方法极其简单：管住手，抄底动作必须、只能放在下午和尾盘！</Text>
                    </Paragraph>
                  </Space>
                }
                type="error"
                showIcon
                icon={<WarningOutlined />}
              />
              
            </Card>

            <Card
              id="subjective-objective"
              className="section-card"
              title={<><BulbOutlined style={{ color: getThemeColor() }} /> 主观逻辑-情绪周期-主力资金流入流出（20260702）</>}
              variant="borderless"
            >
              <Paragraph>
                有时候自己埋伏一个有主观逻辑的股票，比如 <Text strong type="danger">兆易创新</Text> 未来的长鑫 IPO 上市预期，这个本来是很稳的。但是如果中间受到一些客观因素的影响，比如大盘指数持续下跌，或者是监管问询等因素。然后股价 <Text strong type="success">低开 + 开盘下挫</Text><Text type='warning'>（如果低开，但是开盘持续上拉这个还可以再观察看看）</Text>，那么这个时候就是客观 K 线已经走坏了，这个时候就不要犟了，你得先出来。
              </Paragraph>

              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ 
                  padding: '12px 16px', 
                  background: '#e6f7ff', 
                  borderRadius: 8,
                  borderLeft: `4px solid ${getThemeColor()}`
                }}>
                  <span style={{ fontWeight: 600, color: '#0050b3', marginRight: 8 }}>🎯 主观逻辑：</span>
                  <span style={{ color: '#333' }}>决定了自己对中长期主线的判断，自己可以反复在这个股票上做操作，锚定主线不放松这个是对的</span>
                </div>
                
                <div style={{ 
                  padding: '12px 16px', 
                  background: '#fffbe6', 
                  borderRadius: 8,
                  borderLeft: '4px solid #faad14'
                }}>
                  <span style={{ fontWeight: 600, color: '#d46b08', marginRight: 8 }}>📊 情绪周期：</span>
                  <span style={{ color: '#333' }}>根据情绪周期来决定三五天内的短线操作，高抛低吸</span>
                </div>
                
                <div style={{ 
                  padding: '12px 16px', 
                  background: '#fff1f0', 
                  borderRadius: 8,
                  borderLeft: '4px solid #ff4d4f'
                }}>
                  <span style={{ fontWeight: 600, color: '#cf1322', marginRight: 8 }}>💰 主力资金流入流出：</span>
                  <span style={{ color: '#333' }}>根据当日的主力资金净流入流出的情况来做分时的操作。</span>
                  <span style={{ color: '#cf1322', fontWeight: 600 }}>切记：当主力资金开始突然大幅流出的时候，短期趋势不可逆转，大概率延续到收盘，很难 V 形反转，这个时候一定要卖，想要买回来只能在尾盘</span>
                </div>
              </div>

              <Paragraph>
                <Alert
                  className="lesson-alert"
                  message={<Text strong style={{ fontSize: '16px' }}>客观走势走坏，必须果断离场</Text>}
                  description={
                    <Space direction="vertical" size="small">
                      <Paragraph style={{ margin: 0 }}>
                        不管资金是出于什么原因在卖，总而言之一旦客观走势出现了这种<Text strong type="danger">兑现猛烈</Text>的情况，那调整就<Text strong type="warning">不是一两天能结束</Text>的事情。
                      </Paragraph>
                      <Paragraph style={{ margin: 0, padding: '8px 12px', background: '#fff1f0', borderLeft: '4px solid #ff4d4f' }}>
                        <Text strong type="danger">核心逻辑：</Text>
                        <br/>
                        你虽然可能现在出来会亏钱，<Text strong>但是如果你现在不出来，你未来会亏更多的钱！</Text>
                      </Paragraph>
                    </Space>
                  }
                  type="error"
                  showIcon
                  icon={<WarningOutlined />}
                />
              </Paragraph>

              <Alert
                className="lesson-alert"
                message="核心教训"
                description={
                  <>
                    <div>客观走势一旦走坏，就一定要先出来，不要死扛。</div>
                    <Text strong style={{ color: '#cf1322' }}>
                      主观逻辑没坏可能确实是没坏，但是这是一个中长期的事情，不是现在短期的事情。你现在短期明明能通过技术分析和经验判断避开未来一二十个点的调整，那为什么不这么做呢？
                    </Text>
                  </>
                }
                type="warning"
                showIcon
                icon={<WarningOutlined />}
              />

              <div className="case-image-container single">
                <Image 
                  src={zhaoyichuangxin0708} 
                  className="case-image"
                  placeholder={<div style={{ background: '#f5f5f5', height: 200 }} />}
                />
              </div>
            </Card>

            <Card
              id="outflow-deception-0713"
              className="section-card"
              title={<><AlertOutlined style={{ color: '#f5222d' }} /> 主力资金持续流出的诱多陷阱 (20260713)</>}
              variant="borderless"
            >
              <Alert
                className="lesson-alert"
                message="核心观点"
                description="主力资金持续流出，只有卖点没有买点，不要被分时图上涨迷惑"
                type="error"
                showIcon
                icon={<AlertOutlined />}
              />

              <Paragraph style={{ marginTop: 16 }}>
                当主力资金在持续流出的情况下，这个时候指数分时图或许会有上涨的情况发生，个股也会跟着指数一起上涨，但是这些都是诱多，当主力资金持续流出的情况下，分时的个别上涨后面都会被带下去的。
              </Paragraph>

              <Alert
                className="lesson-alert"
                style={{ marginTop: 16 }}
                message="正确做法"
                description="当看见主力资金持续流出的时候，逮着某一次分时图的上涨然后赶快兑现卖出，这个时候千万不能在盘中的某次分时追高冲进去。而是应该等到尾盘的时候再说"
                type="warning"
                showIcon
                icon={<BulbOutlined />}
              />

              <Alert
                className="lesson-alert"
                style={{ marginTop: 16 }}
                message="V形反转确认条件"
                description="当然有几个别的情况下，确实是盘中主力资金会突然开始大幅度流入，指数出现 V 形反转，但是这个一定要至少确认 <Text strong>15分钟</Text>，千万不能冲动！"
                type="success"
                showIcon
                icon={<CheckCircleOutlined />}
              />

              <Alert
                className="lesson-alert"
                style={{ marginTop: 16 }}
                message="心理障碍突破"
                description={
                  <>
                    <div>这个时候最大的心理障碍就是<Text strong type="danger">害怕踏空</Text>！</div>
                    <div style={{ marginTop: 8 }}>分时图一开始上涨，然后自己就以为大盘要 V 形反转了。个股要开始修复了。自己再不买进去就踏空了。</div>
                    <div style={{ marginTop: 8 }}>
                      <Text strong style={{ color: '#cf1322' }}>每当自己有这种冲动的时候就应该看看主力资金的流出情况，只要主力资金的实时流入流出分时图没有出现明确的 V 形反转，那指数和个股分时的 V 形反转全都是诱多。</Text>
                    </div>
                  </>
                }
                type="info"
                showIcon
                icon={<InfoCircleOutlined />}
              />

              <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>主力资金持续流出</Text></Divider>
              <div className="case-image-container single">
                <Image src={zhulizijin0713} className="case-image" />
              </div>

              <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>指数与个股分时图对比</Text></Divider>
              <div className="case-image-container single">
                <Image src={zhishuhezhaoyichuangxin0713} className="case-image" />
              </div>
            </Card>

            <Card
              id="overnight-crisis-rebound"
              className="section-card"
              title={<><BulbOutlined style={{ color: '#faad14' }} /> 隔夜利空竞价开盘大跌不用担心，等 10 点拉升之后再走不迟（20260819）</>}
              variant="borderless"
            >
              <Alert
                className="lesson-alert"
                message="核心逻辑：主力被迫逆势拉升"
                description={
                  <>
                    <div>
                      当大部分的个股都以接近跌停价格开盘的时候，那么主力开盘就只能<Text strong type="danger">向上拉升</Text>，不然散户跑的比自己快，自己就出不来了。
                    </div>
                    <div style={{ marginTop: 8 }}>
                      因此开盘主力必须逆势拉升，当逆势拉升到一定程度之后，此时内部还没有卖的散户就会开始犹豫，甚至有一些场外的散户还会抱着抄底的思维进来抬轿子。而这个时候主力再顺势<Text strong type="warning">横盘震荡出货</Text>。
                    </div>
                  </>
                }
                type="info"
                showIcon
                icon={<InfoCircleOutlined />}
              />

              <Alert
                className="lesson-alert"
                style={{ marginTop: 16 }}
                message="操作策略：等到 10 点附近再卖"
                description={
                  <>
                    <div>
                      所以当遇到隔夜大利空的时候，不要慌，竞价开盘就算价格再低也不用担心，开盘往往会向上拉升，等到了 <Text strong style={{ color: '#cf1322' }}>10 点左右附近</Text> 的时候再卖也不迟。
                    </div>
                    <Text strong style={{ color: '#137722', marginTop: 8, display: 'block' }}>
                      核心要点：开盘不要恐慌抛售，等待主力逆势拉升后再兑现。
                    </Text>
                  </>
                }
                type="success"
                showIcon
                icon={<CheckCircleOutlined />}
              />

              <Alert
                className="lesson-alert"
                style={{ marginTop: 16 }}
                message="风险信号：资金持续净流出时必须离场"
                description={
                  <>
                    <div>
                      但是这个时候如果看到资金在<Text strong type="danger">持续净流出</Text>，那么等到 10 点之后一定要走了，不要抱有侥幸心理今天会低开高走。这是不切实际的。
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <Text strong style={{ color: '#cf1322' }}>除非能看到资金在持续净流入，否则 10 点之后必须果断清仓避险。</Text>
                    </div>
                  </>
                }
                type="warning"
                showIcon
                icon={<WarningOutlined />}
              />

              <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>大盘主力资金分时</Text></Divider>
              <div className="case-image-container single">
                <Image src={zhulizijin20260819} className="case-image" />
              </div>

              <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>国际复材分时</Text></Divider>
              <div className="case-image-container single">
                <Image src={guojifucai20260819} className="case-image" />
              </div>

              <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>创业板指分时</Text></Divider>
              <div className="case-image-container single">
                <Image src={chuangyebanzhi20260819} className="case-image" />
              </div>
            </Card>

            <Card
              id="no-financial-report"
              className="section-card"
              title={<><BookOutlined style={{ color: '#ff4d4f' }} /> 刚发完财报的股票不能买</>}
              variant="borderless"
            >
              <Alert
                className="lesson-alert"
                message="核心教训"
                description={
                  <>
                    <div>刚发完财报的股票不能买，哪怕净利润显示增长了百分之几百，看起来很好也不能买。因为你不知道机构的目标心理预期是多少。甚至第二天冲高你也不能买。</div>
                    <Text strong style={{ color: '#cf1322' }}>
                      刚刚发完财报，哪怕财报再好，第二天不管怎么样，都不能买！！！只能买那些已经发完财报很久的股票。
                    </Text>
                  </>
                }
                type="error"
                showIcon
                icon={<WarningOutlined />}
              />

              <Paragraph>
                <Text type="secondary">实战案例：</Text>
                例如 <Text strong>20260819</Text> 这一天收盘之后，国际复材和鼎泰高科两个都发了半年报，净利润分别都增长了百分之两三百，但是第二天其他很多股票都在上涨，这两个早上竞价高开，冲高回落，自己这一天就中招了！早上国际复材冲高 <Text type="success" strong>3%</Text> 的时候以为没事儿，然后买进去，结果尾盘回落到了 <Text type="danger" strong>-3.8%</Text>。
              </Paragraph>

              <div className="case-image-container">
                <Image
                  src={guojifucai20260820}
                  className="case-image"
                  placeholder={<div style={{ background: '#f5f5f5', height: 200 }} />}
                />
                <Image
                  src={dingtaigaoke20260820}
                  className="case-image"
                  placeholder={<div style={{ background: '#f5f5f5', height: 200 }} />}
                />
              </div>
            </Card>

            <Divider>
              <Text type="secondary" style={{ fontSize: '12px' }}>
                <InfoCircleOutlined /> 交易纪律是盈利的基石
              </Text>
            </Divider>
          </div>
        </Col>
      </Row>
    </div>
  );
};

export default PreMarketReading;


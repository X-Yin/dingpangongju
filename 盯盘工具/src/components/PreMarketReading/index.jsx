import React, { useRef } from 'react';
import { Typography, Card, Tag, Space, Divider, Alert, Image, Anchor, Row, Col, Tooltip } from 'antd';
import { BookOutlined, InfoCircleOutlined, CheckCircleOutlined, WarningOutlined, BulbOutlined, UnorderedListOutlined } from '@ant-design/icons';
import guzhiqihuojiaoge from '../../assets/guzhiqihuojiaoge.png';
import zhongxinCase from '../../assets/20260529-中芯国际.png';
import zhongxinFenshi from '../../assets/20260529-中芯国际分时.png';
import hanwujiCase from '../../assets/20260529-寒武纪.png';
import hanwujiFenshi from '../../assets/20260529-寒武纪分时.png';
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
import './index.scss';

const { Title, Paragraph, Text } = Typography;

const PreMarketReading = () => {
  const scrollContainerRef = useRef(null);
  const steps = [
    {
      title: '竞价看龙头表现',
      content: '重点观察中际旭创、新易盛、寒武纪、中芯国际等标的的竞价强弱，判断核心资金意图。'
    },
    {
      title: '开盘看量能与指数',
      content: '观察大盘是缩量还是放量，上证、创业、科创指数的涨跌趋势是否同步。'
    },
    {
      title: '筛选科技大票情绪',
      content: '在科技核心票中筛选跌幅居前者，判断当天市场整体情绪压力位。'
    },
    {
      title: '延迟操作与风控执行',
      content: '开盘不急于操作，观察至 9:31 后决策。持仓下跌超 -2% 立即止损，不赌反转，只做主升惯性。'
    },
    {
      title: '机会判断与影子战法',
      content: '确认大盘情绪无虞后，结合机构消息差或当前主线龙头，寻找确定性买点。'
    }
  ];

  const menuItems = [
    { key: 'steps', href: '#steps', title: '看盘核心步骤' },
    { key: 'case-zhongxin', href: '#case-zhongxin', title: '高位票竞价和开盘不及预期直接卖' },
    { key: 'case-hanwuji', href: '#case-hanwuji', title: '清仓之后不操作' },
    { key: 'case-inducement', href: '#case-inducement', title: '退潮期的冲高诱多' },
    { key: 'rebound-strategy', href: '#rebound-strategy', title: '退潮期超跌反弹博弈' },
    { key: 'outflow-warning', href: '#outflow-warning', title: '资金净流出加速风险' },
    { key: 'case-0605', href: '#case-0605', title: '一周期一次出手纪律' },
  ].map(item => ({
    ...item,
    title: <Tooltip title={item.title} placement="top"><span>{item.title}</span></Tooltip>
  }));

  return (
    <div className="pre-market-reading-wrapper" ref={scrollContainerRef}>
      <Row gutter={24} style={{ margin: 0 }}>
        <Col span={4} className="sidebar-col">
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
        <Col span={20} className="content-col">
          <div className="pre-market-reading">
            <Image 
              src={guzhiqihuojiaoge} 
              className="main-image"
              preview={false}
              style={{ width: 500 }}
            /> 

            <Card 
              id="steps"
              className="section-card" 
              title={<><BulbOutlined style={{ color: '#1890ff' }} /> 看盘核心步骤</>}
              variant="borderless"
            >
              <div className="principle-box">
                <span className="principle-label">核心原则:</span>
                <span className="principle-text">从宏观到微观，从龙头到细分，从下跌到上涨</span>
              </div>

              {steps.map((step, index) => (
                <div key={index} className="step-item">
                  <div className="step-number">{index + 1}</div>
                  <span className="step-title">{step.title}</span>
                  <div className="step-content">{step.content}</div>
                </div>
              ))}

              <Alert
                className="lesson-alert"
                message="避险逻辑"
                description="前四步的核心目的都是为了判断当天情绪，确保大盘不会跳水，从而成功避开大阴线。"
                type="info"
                showIcon
                icon={<CheckCircleOutlined />}
              />
            </Card>

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
              title={<><WarningOutlined style={{ color: '#faad14' }} /> 实战案例复盘: 退潮期的冲高诱多 (20260601)</>}
              variant="borderless"
            >
              <Paragraph>
                <Text type="secondary">盘面现象：</Text>
                上午指数冲高，但成交量显著缩减（缩量上涨）。这在退潮期是典型的<Text strong color="#cf1322">诱多信号</Text>。下午大盘大幅跳水，上午追高资金悉数被套。
              </Paragraph>

              <Alert
                className="lesson-alert"
                message="博弈逻辑"
                description={
                  <>
                    <div>退潮期严禁追高，任何盘中拉升都是主力兑现的机会。</div>
                    <Text strong style={{ color: '#cf1322' }}>
                      寻找低位、低估值的防御性板块（如煤炭、电力）进行低吸，往往能在大盘跳水时获得超额收益。
                    </Text>
                  </>
                }
                type="warning"
                showIcon
                icon={<BulbOutlined />}
              />

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

              <Divider orientation="left" plain><Text type="secondary" style={{ fontSize: '12px' }}>案例 3: 昊华能源 (低位防御板块走强)</Text></Divider>
              <Paragraph>
                防御板块煤炭不受指数跳水影响，全天高举高打，走出独立行情。
              </Paragraph>
              <div className="case-image-container single">
                <Image src={haohuanengyuan20260601} className="case-image" />
              </div>
            </Card>

            <Card 
              id="rebound-strategy"
              className="section-card" 
              title={<><BulbOutlined style={{ color: '#52c41a' }} /> 超跌反弹的博弈方法(20260602)</>}
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
                2026-06-02 至 06-04，科技情绪指数已连续 <Text strong style={{ color: '#cf1322' }}>三天超过 100</Text>。市场处于明显的情绪过热阶段，风险极大。
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
                    <div>1. <Text strong>出手时机</Text>：真正适合全仓出手的机会，一个星期通常只有一次。即科技指数情绪 <Text strong style={{ color: '#cf1322' }}>低于 -100</Text> 或 <Text strong style={{ color: '#cf1322' }}>连续多日为负</Text> 后的次日。</div>
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


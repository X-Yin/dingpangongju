import React, { useRef } from 'react';
import { Typography, Card, Tag, Space, Divider, Alert, Image, Anchor, Row, Col, Tooltip } from 'antd';
import { BookOutlined, InfoCircleOutlined, CheckCircleOutlined, WarningOutlined, BulbOutlined, UnorderedListOutlined, RiseOutlined } from '@ant-design/icons';
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
import './index.scss';

const { Title, Paragraph, Text } = Typography;

const PreMarketReading = () => {
  const scrollContainerRef = useRef(null);

  const menuItems = [
    { key: 'trend-following', href: '#trend-following', title: '跟随趋势，拥抱确定性' },
    { key: 'weak-shock', href: '#weak-shock', title: '弱势震荡期的操作策略' },
    { key: 'high-volume-yin', href: '#high-volume-yin', title: '高位放量大阴线信号' },
    { key: 'outflow-rebound-0610', href: '#outflow-rebound-0610', title: '操他妈了个逼！' },
    { key: 'case-zhongxin', href: '#case-zhongxin', title: '高位票竞价和开盘不及预期直接卖' },
    { key: 'case-hanwuji', href: '#case-hanwuji', title: '清仓之后不操作' },
    { key: 'case-inducement', href: '#case-inducement', title: '退潮期的冲高诱多' },
    { key: 'rebound-strategy', href: '#rebound-strategy', title: '退潮期超跌反弹博弈' },
    { key: 'outflow-warning', href: '#outflow-warning', title: '资金净流出加速风险' },
    { key: 'case-0605', href: '#case-0605', title: '一周期一次出手纪律' },    { key: 'timing-selection', href: '#timing-selection', title: '择时大于选股' },
    { key: 'rebound-dip', href: '#rebound-dip', title: '情绪反弹龙头表现不如小弟' },
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
              id="trend-following"
              className="section-card"
              title={<><RiseOutlined style={{ color: '#52c41a' }} /> 跟随趋势，拥抱确定性</>}
              variant="borderless"
            >
              <Alert
                className="lesson-alert"
                message="核心理念：趋势大于波动"
                description="做短线不是简单的今天买明天卖。追逐热点若无大盘情绪配合，极易遭遇冲高回落。最重要的并非日内波动，而是趋势的跟随。"
                type="success"
                showIcon
                icon={<CheckCircleOutlined />}
              />

              <div className="principle-content" style={{ marginTop: 16 }}>
                <Paragraph>
                  <Text strong>1. 仓位配比策略：</Text>
                  找好主线与支线。一般采用 <Text type="danger">主线:支线 = 7:3</Text>，或 <Text type="danger">主线:支线1:支线2 = 6:2:2</Text>。
                </Paragraph>

                <Paragraph>
                  <Text strong>2. 止损与跟随准则：</Text>
                  只要没有 <Text type="success" strong>开盘砸破 -4%</Text> 或 <Text type="success" strong>跌破 10 日线</Text>，就坚持跟随趋势高抛低吸。
                  涨了适度止盈，回调企稳反弹时顺势加仓，<Text underline>严禁提前盲目抄底</Text>。
                </Paragraph>

                <Paragraph>
                  <Text strong>3. 减少无谓调仓：</Text>
                  趋势未坏，不要随便换股。忽略日内震荡，只要未达止损位，保持定力。回调是暂时的，趋势会修复价格。
                </Paragraph>

                <Paragraph>
                  <Text strong>4. 确定性是盈利之本：</Text>
                  跟随趋势最大的好处是<Text strong>确定性</Text>。强势股在回调时抗跌，上涨时领涨，因为资金主动性强，趋势力量大。
                </Paragraph>
              </div>
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
                <span style={{ color: 'red', fontWeight: 'bold' }}>科技情绪指数前一日 0529 只有 -58，并没有到 -100 以下，说明情绪退潮的不彻底，市场情绪还没有到冰点.</span>这个时候最多只能<span style={{ color: 'red' }}>半仓操作</span>。因为随时有可能会冲高回落。果然 0601 当天上午冲高，但是下午大盘就大幅跳水，上午追高资金悉数被套。
              </Paragraph>

              <Alert
                className="lesson-alert"
                message="博弈逻辑"
                description={
                  <>
                    <div>只能在冰点（情绪指数-100以下）博弈</div>
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
              title={<><InfoCircleOutlined style={{ color: '#1890ff' }} /> 退潮期强势个股，在反弹第一天往往会补跌(0609)</>}
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
              title={<><WarningOutlined style={{ color: '#faad14' }} /> 弱势震荡期的操作策略(20260611)</>}
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


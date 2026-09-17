import { Modal, Tabs, Empty, Spin, Tag, Typography } from 'antd';
import { FileSearchOutlined, BookOutlined, StarFilled, PushpinOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { getThemeColor } from '../../../../utils/theme';
import './index.scss';

const { Text } = Typography;
const { TabPane } = Tabs;

const LogicExploreModal = ({ open, onCancel, logicExploreStock, logicExploreLoading, jigouMatchedReports, researchMatchedReports, highlightStockName, themeColor }) => (
    <Modal
        title={<span><FileSearchOutlined style={{ marginRight: 8 }} />{logicExploreStock?.stockName || ''} 逻辑探查</span>}
        open={open}
        onCancel={onCancel}
        footer={null}
        width={900}
        className="logic-explore-modal"
    >
        <Spin spinning={logicExploreLoading}>
            <Tabs defaultActiveKey="jigou" style={{ marginTop: -16 }}>
                <TabPane tab={<span><span>📰</span> 机构研报 ({jigouMatchedReports.length})</span>} key="jigou">
                    {jigouMatchedReports.length > 0 ? (
                        <div className="logic-explore-list">
                            {jigouMatchedReports.map((report, index) => (
                                <div key={index} className="logic-explore-item">
                                    <div
                                        className="logic-explore-title"
                                        dangerouslySetInnerHTML={{ __html: highlightStockName(report.title, logicExploreStock?.stockName) }}
                                    />
                                    <div className="logic-explore-time">
                                        {report.createTime ? dayjs(report.createTime).format('YYYY-MM-DD HH:mm:ss') : ''}
                                    </div>
                                    <div
                                        className="logic-explore-content"
                                        dangerouslySetInnerHTML={{ __html: highlightStockName(report.text, logicExploreStock?.stockName) }}
                                    />
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="logic-explore-empty">
                            <Empty
                                image={Empty.PRESENTED_IMAGE_SIMPLE}
                                description={
                                    <div>
                                        <div style={{ marginBottom: 8 }}>暂无匹配的机构研报</div>
                                        <div style={{ fontSize: 12 }}>可在「机构研报」页面查看最新研报</div>
                                    </div>
                                }
                            />
                        </div>
                    )}
                </TabPane>
                <TabPane tab={<span><BookOutlined /> 近期研报 ({researchMatchedReports.length})</span>} key="research">
                    {researchMatchedReports.length > 0 ? (
                        <div className="logic-explore-list">
                            {researchMatchedReports.map((report, index) => (
                                <div key={report.id || index} className="logic-explore-item">
                                    <div className="logic-explore-title-row">
                                        <span
                                            className="logic-explore-title"
                                            dangerouslySetInnerHTML={{ __html: highlightStockName(report.name, logicExploreStock?.stockName) }}
                                        />
                                        {report.folderPath && (
                                            <Tag size="small" color="blue" className="logic-explore-folder-tag">
                                                {report.folderPath}
                                            </Tag>
                                        )}
                                        {report.isImportant && <StarFilled style={{ fontSize: 12 }} />}
                                        {report.isPinned && <PushpinOutlined style={{ color: getThemeColor(), fontSize: 12 }} />}
                                    </div>
                                    {report.content ? (
                                        <div
                                            className="logic-explore-content markdown-content"
                                            dangerouslySetInnerHTML={{
                                                __html: highlightStockName(
                                                    report.content.replace(/\n/g, '<br/>'),
                                                    logicExploreStock?.stockName
                                                )
                                            }}
                                        />
                                    ) : (
                                        <div className="logic-explore-content" style={{ fontStyle: 'italic' }}>
                                            暂无内容
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="logic-explore-empty">
                            <Empty
                                image={Empty.PRESENTED_IMAGE_SIMPLE}
                                description={
                                    <div>
                                        <div style={{ marginBottom: 8 }}>暂无匹配的近期研报</div>
                                        <div style={{ fontSize: 12 }}>可在「市场调研 → 近期研报」页面添加相关研报</div>
                                    </div>
                                }
                            />
                        </div>
                    )}
                </TabPane>
            </Tabs>
        </Spin>
    </Modal>
);

export default LogicExploreModal;

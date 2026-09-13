import { Modal, Spin, Empty, Button } from 'antd';
import { RadarChartOutlined, ReloadOutlined, CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import { getThemeColor } from '../../../../utils/theme';
import './index.scss';

const BuyPointDiagnosisModal = ({ open, onCancel, buyPointDiagnosisStock, buyPointDiagnosisData, buyPointDiagnosisLoading, onRefresh, themeColor }) => (
    <Modal
        title={
            <span>
                <RadarChartOutlined style={{ marginRight: 8, color: getThemeColor() }} />
                {buyPointDiagnosisStock?.stockName || ''} 买点诊断
                {buyPointDiagnosisData?.data && (
                    <span className="bp-diag-header-badge">
                        {buyPointDiagnosisData.data.passedCount}/{buyPointDiagnosisData.data.totalCheckCount}
                    </span>
                )}
            </span>
        }
        open={open}
        onCancel={onCancel}
        footer={null}
        width={680}
        className="bp-diagnosis-modal"
        destroyOnClose
    >
        <Spin spinning={buyPointDiagnosisLoading} tip="正在诊断...">
            <div className="bp-diag-toolbar">
                <span className="bp-diag-stock-info">
                    {buyPointDiagnosisStock?.stockName}
                    <span className="bp-diag-stock-code">{buyPointDiagnosisStock?.code}</span>
                </span>
                <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    onClick={onRefresh}
                    loading={buyPointDiagnosisLoading}
                >
                    刷新
                </Button>
            </div>

            {buyPointDiagnosisData?.data ? (
                <>
                    <div className="bp-diag-checks-list">
                        {buyPointDiagnosisData.data.checks?.map((check, idx) => (
                            <div
                                key={check.id || idx}
                                className={`bp-diag-check-item ${check.passed ? 'passed' : 'failed'}`}
                            >
                                <div className="bp-diag-check-main">
                                    <div className="bp-diag-check-left">
                                        <span className={`bp-diag-num ${check.passed ? 'num-pass' : 'num-fail'}`}>
                                            {idx + 1}
                                        </span>
                                        <span className="bp-diag-title">{check.title}</span>
                                    </div>
                                    <div className="bp-diag-check-right">
                                        <span className={`bp-diag-value ${check.passed ? 'value-pass' : 'value-fail'}`}>
                                            {check.value}
                                        </span>
                                        {check.passed ? (
                                            <CheckCircleFilled className="bp-diag-status pass-icon" />
                                        ) : (
                                            <CloseCircleFilled className="bp-diag-status fail-icon" />
                                        )}
                                    </div>
                                </div>
                                <div className="bp-diag-reason">{check.reason}</div>
                            </div>
                        ))}
                    </div>

                    <div className={`bp-diag-conclusion ${buyPointDiagnosisData.data.allPassed ? 'conclusion-pass' : 'conclusion-fail'}`}>
                        <div className={`bp-diag-conclusion-title ${buyPointDiagnosisData.data.allPassed ? 'title-pass' : 'title-fail'}`}>
                            {buyPointDiagnosisData.data.allPassed ? '🚀 诊断结果：可以出手' : '⚠️ 诊断结果：暂不可出手'}
                        </div>
                        <div className="bp-diag-conclusion-text">{buyPointDiagnosisData.data.conclusion}</div>
                        {buyPointDiagnosisData.data.timestamp && (
                            <div className="bp-diag-conclusion-time">诊断时间：{buyPointDiagnosisData.data.timestamp}</div>
                        )}
                    </div>
                </>
            ) : (
                !buyPointDiagnosisLoading && (
                    <div style={{ padding: '40px 0' }}>
                        <Empty description="暂无诊断数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                    </div>
                )
            )}
        </Spin>
    </Modal>
);

export default BuyPointDiagnosisModal;

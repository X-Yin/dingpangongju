import { Modal, Empty } from 'antd';
import dayjs from 'dayjs';
import './index.scss';

const GoodNewsModal = ({ open, onCancel, currentGoodNewsStock, matchedReports, highlightStockName, themeColor }) => (
    <Modal
        title={<span><span>📰</span> {currentGoodNewsStock} 利好消息</span>}
        open={open}
        onCancel={onCancel}
        footer={null}
        width={800}
        className="good-news-modal"
    >
        {matchedReports.length > 0 ? (
            <div className="good-news-list">
                {matchedReports.map((report, index) => (
                    <div key={index} className="good-news-item">
                        <div
                            className="good-news-title"
                            dangerouslySetInnerHTML={{ __html: highlightStockName(report.title, currentGoodNewsStock) }}
                        />
                        <div className="good-news-time">{report.createTime ? dayjs(report.createTime).format('YYYY-MM-DD HH:mm:ss') : ''}</div>
                        <div
                            className="good-news-content"
                            dangerouslySetInnerHTML={{ __html: highlightStockName(report.text, currentGoodNewsStock) }}
                        />
                    </div>
                ))}
            </div>
        ) : (
            <Empty description="暂无匹配的利好消息" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
    </Modal>
);

export default GoodNewsModal;

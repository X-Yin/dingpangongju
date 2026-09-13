import MultiStockTimeLineModal from '../../../../components/MultiStockTimeLineModal';
import './index.scss';

const OverlayTimelineSection = ({ overlayInlineAddStock, onStockClick, sectionRef, themeColor }) => (
    <div style={{ marginTop: 16 }} ref={sectionRef}>
        <MultiStockTimeLineModal
            embedded
            title="叠加分时观察"
            storageKey="dingpan_multi_stock_timeline"
            externalAddStock={overlayInlineAddStock}
            onStockClick={onStockClick}
            hideIndexTags
            includeDefaultIndex={false}
            compactHeader
        />
    </div>
);

export default OverlayTimelineSection;

import { useState, useEffect, useMemo } from 'react';
import { Spin, Empty, Tag } from 'antd';
import { ClockCircleOutlined, FieldTimeOutlined, CalendarOutlined } from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import './index.scss';

const IMPACT_LEVELS = {
  positive: { label: '利好', color: '#ff4d4f', bgColor: 'rgba(255, 77, 79, 0.06)' },
  negative: { label: '利空', color: '#52c41a', bgColor: 'rgba(82, 196, 26, 0.06)' },
  neutral: { label: '中性', color: '#8c8c8c', bgColor: 'rgba(140, 140, 140, 0.06)' },
};

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const MajorEventReminder = () => {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const [marketRes, recentOpRes] = await Promise.all([
          axios.get(`http://${local_ip}:3000/get_market_rhythm_gantt`),
          axios.get(`http://${local_ip}:3000/get_recent_operation_gantt`),
        ]);
        const marketEvents = Array.isArray(marketRes.data) ? marketRes.data : [];
        const recentOpEvents = Array.isArray(recentOpRes.data) ? recentOpRes.data : [];
        // 合并两个数据源，按 title 去重（优先保留 recentOperationGantt 中的数据，因为这是用户在盯盘页面操作的）
        const titleSet = new Set();
        const merged = [];
        [...recentOpEvents, ...marketEvents].forEach(e => {
          if (e && e.title && !titleSet.has(e.title)) {
            titleSet.add(e.title);
            merged.push(e);
          }
        });
        setEvents(merged);
      } catch (error) {
        console.error('获取大事提醒数据失败:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const { ongoingEvents, upcomingWeekEvents, farFutureEvents } = useMemo(() => {
    const today = dayjs().startOf('day');
    const oneWeekLater = today.add(7, 'day');

    const notified = events.filter(e => e.notify === true);

    const ongoing = notified.filter(e => {
      const start = dayjs(e.startDate).startOf('day');
      const end = dayjs(e.endDate).startOf('day');
      return (today.isAfter(start) || today.isSame(start))
          && (today.isBefore(end) || today.isSame(end));
    }).sort((a, b) => dayjs(a.endDate).diff(dayjs(b.endDate)));

    const upcoming = notified.filter(e => {
      const start = dayjs(e.startDate).startOf('day');
      return start.isAfter(today)
          && (start.isBefore(oneWeekLater) || start.isSame(oneWeekLater));
    }).sort((a, b) => dayjs(a.startDate).diff(dayjs(b.startDate)));

    const farFuture = notified.filter(e => {
      const start = dayjs(e.startDate).startOf('day');
      return start.isAfter(oneWeekLater);
    }).sort((a, b) => dayjs(a.startDate).diff(dayjs(b.startDate)));

    return { ongoingEvents: ongoing, upcomingWeekEvents: upcoming, farFutureEvents: farFuture };
  }, [events]);

  const renderEventCard = (event, type) => {
    const levelInfo = IMPACT_LEVELS[event.level] || IMPACT_LEVELS.neutral;
    const today = dayjs().startOf('day');
    const startDate = dayjs(event.startDate).startOf('day');
    const endDate = dayjs(event.endDate).startOf('day');
    const isSingleDay = event.startDate === event.endDate;

    let extraInfo = null;
    if (type === 'ongoing') {
      const daysRemaining = endDate.diff(today, 'day');
      const endWeekday = WEEKDAYS[dayjs(event.endDate).day()];
      extraInfo = (
        <div className="reminder-extra">
          {daysRemaining === 0
            ? <span className="urgent">今天结束！</span>
            : <span className="countdown">还有 <strong>{daysRemaining}</strong> 天结束</span>
          }
          <span className="end-date">结束日期：{event.endDate}（{endWeekday}）</span>
        </div>
      );
    } else if (type === 'upcoming') {
      const daysUntilStart = startDate.diff(today, 'day');
      const startWeekday = WEEKDAYS[dayjs(event.startDate).day()];
      extraInfo = (
        <div className="reminder-extra">
          <span className="countdown">还有 <strong>{daysUntilStart}</strong> 天开始</span>
          <span className="start-date">开始日期：{event.startDate}（{startWeekday}）</span>
        </div>
      );
    }

    return (
      <div
        key={event.id}
        className="event-card"
        style={{ borderLeftColor: levelInfo.color, backgroundColor: levelInfo.bgColor }}
      >
        <div className="event-card-header">
          <span className="event-title">{event.title}</span>
          <Tag style={{ color: '#fff', border: 'none', backgroundColor: levelInfo.color }}>
            {levelInfo.label}
          </Tag>
        </div>
        <div className="event-dates">
          <span>{event.startDate}</span>
          {!isSingleDay && <span> ~ {event.endDate}</span>}
        </div>
        {event.description && (
          <div className="event-description">{event.description}</div>
        )}
        {extraInfo}
      </div>
    );
  };

  const total = ongoingEvents.length + upcomingWeekEvents.length + farFutureEvents.length;

  return (
    <Spin spinning={loading}>
      {total === 0 && !loading ? (
        <Empty description="暂无大事提醒事件" style={{ margin: '60px 0' }} />
      ) : (
        <div className="major-event-reminder">
          {ongoingEvents.length > 0 && (
            <section className="event-section ongoing">
              <div className="section-title">
                <ClockCircleOutlined />
                <span>正在进行</span>
                <span className="section-count">{ongoingEvents.length}</span>
              </div>
              <div className="event-list">
                {ongoingEvents.map(e => renderEventCard(e, 'ongoing'))}
              </div>
            </section>
          )}

          {upcomingWeekEvents.length > 0 && (
            <section className="event-section upcoming">
              <div className="section-title">
                <FieldTimeOutlined />
                <span>未来一周内</span>
                <span className="section-count">{upcomingWeekEvents.length}</span>
              </div>
              <div className="event-list">
                {upcomingWeekEvents.map(e => renderEventCard(e, 'upcoming'))}
              </div>
            </section>
          )}

          {farFutureEvents.length > 0 && (
            <section className="event-section far-future">
              <div className="section-title">
                <CalendarOutlined />
                <span>更远未来</span>
                <span className="section-count">{farFutureEvents.length}</span>
              </div>
              <div className="event-list">
                {farFutureEvents.map(e => renderEventCard(e, 'farFuture'))}
              </div>
            </section>
          )}
        </div>
      )}
    </Spin>
  );
};

export default MajorEventReminder;

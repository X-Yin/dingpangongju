import { useEffect, useState } from 'react';
import { message } from 'antd';
import axios from 'axios';
import { local_ip } from '../../constant';
import BacktestDrawer from '../trainingCamp/components/BacktestDrawer';

// 买卖点回测独立页面：与训练营解耦，直接内嵌 BacktestDrawer（embedded 模式，不套 Drawer 外壳）
const Backtest = () => {
  const [dates, setDates] = useState([]);

  useEffect(() => {
    axios.get(`http://${local_ip}:3000/training_camp/dates`)
      .then(r => setDates(Array.isArray(r.data) ? r.data : []))
      .catch(() => message.error('获取可回放日期失败'));
  }, []);

  return <BacktestDrawer embedded dates={dates} />;
};

export default Backtest;

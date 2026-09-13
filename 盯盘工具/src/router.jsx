import { createBrowserRouter, Navigate } from 'react-router-dom';
import App from './App.jsx';
import DingPan from './pages/dingpan/index.jsx';
import KeyBlocks from './pages/key_blocks/index.jsx';
import Sentiment from './pages/sentiment/index.jsx';
import VolumeStatistics from './pages/volume/index.jsx';
import ShiChangDiaoYan from './pages/shichangdiaoyan/index.jsx';
import JigouReports from './pages/JigouReports/index.jsx';
import StockDiagnosis from './pages/stock_diagnosis/index.jsx';
import MainFund from './pages/MainFund/index.jsx';
import FuPan from './pages/fupan/index.jsx';
import StrategyCenter from './pages/strategy_center/index.jsx';
import AiPrediction from './pages/ai_prediction/index.jsx';
import OpeningBattle from './pages/OpeningBattle/index.jsx';
import TrainingCamp from './pages/trainingCamp/index.jsx';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      {
        path: '',
        element: <Navigate to="/dingpan" replace />,
      },
      {
        path: 'dingpan',
        element: <DingPan />,
      },
      {
        path: 'block',
        element: <KeyBlocks />,
      },
      {
        path: 'block_money_change',
        element: <KeyBlocks />,
      },
      {
        path: 'sentiment',
        element: <Sentiment />,
      },
      {
        path: 'volume',
        element: <VolumeStatistics />,
      },
      {
        path: 'shichangdiaoyan',
        element: <ShiChangDiaoYan />,
      },
      {
        path: 'jigou_reports',
        element: <JigouReports />,
      },
      {
        path: 'stock_diagnosis',
        element: <StockDiagnosis />,
      },
      {
        path: 'fupan',
        element: <FuPan />,
      },
      {
        path: 'strategy_center',
        element: <StrategyCenter />,
      },
      {
        path: 'ai_prediction',
        element: <AiPrediction />,
      },
      {
        path: 'opening_battle',
        element: <OpeningBattle />,
      },
      {
        path: 'training_camp',
        element: <TrainingCamp />,
      }
    ]
  },
  {
    path: 'main_fund',
    element: <MainFund />,
  }
]);
export default router;
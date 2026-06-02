// 设置 react-router 路由配置和组件，要求 / 路径渲染 App 组件
import { createBrowserRouter, Navigate } from 'react-router-dom';
import App from './App.jsx';
import DingPan from './pages/dingpan/index.jsx';
import Block from './pages/block/index.jsx';
import Sentiment from './pages/sentiment/index.jsx';

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
        element: <Block />,
      },
      {
        path: 'sentiment',
        element: <Sentiment />,
      }
    ]
  }
]);
export default router;
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import ThemeProvider from './components/ThemeProvider'
import router from './router.jsx'
import './index.scss'

createRoot(document.getElementById('root')).render(
  <ThemeProvider>
    <RouterProvider router={router} />
  </ThemeProvider>,
)

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  // 入口 HTML 缺少 #root 属于部署错误，直接抛出让控制台可见，不静默白屏。
  throw new Error('index.html 缺少 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

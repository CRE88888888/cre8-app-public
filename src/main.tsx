// ⚠ 必須是第一個 import：它要在任何 store 模組求值之前塞好 sessionStorage（見 dev-session.ts）。
import './dev-session';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { queryClient } from './lib/query';
// 載入順序是刻意的：先設計稿的系統（tokens + 全域 reset + 既有元件規則），
// 再我自己的三支去覆蓋。反過來的話，他們的 `button { background:none }` 之類會蓋掉我的元件。
import './styles/vendor/fonts.css';
import './styles/vendor/design.css';
import './styles/vendor/fund-explore.css';
import './styles/tokens.css';
import './styles/toast.css';
import './styles/base.css';
import './styles/components.css';
import './styles/phase-banner.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing: index.html was modified');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

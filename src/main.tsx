// ⚠ 必須是第一個 import：它要在任何 store 模組求值之前塞好 sessionStorage（見 dev-session.ts）。
import './dev-session';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { queryClient } from './lib/query';
import { dropDeadOAuthCallback } from './lib/privy-oauth-callback';
// 載入順序是刻意的：先設計稿的系統（tokens + 全域 reset + 既有元件規則），
// 再我自己的三支去覆蓋。反過來的話，他們的 `button { background:none }` 之類會蓋掉我的元件。
import './styles/vendor/fonts.css';
import './styles/vendor/design.css';
import './styles/vendor/fund-explore.css';
import './styles/tokens.css';
import './styles/shadcn.css';
import './styles/base.css';
import './styles/components.css';
// 公開市集的新版版面獨立疊加；vendor 設計稿與 sx- 工具頁 token 保持原樣。
import './styles/formal-ui.css';

// X／Google 登入用過的 code 還留在網址上時先拿掉，Privy 才不會再兌換一次、跳出「Authentication failed」（cre8-app#107）。
// 必須在 React Router 與 Privy 讀網址之前。
dropDeadOAuthCallback();

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

import './styles/public-fund-explore.css';
import './styles/public-detail-source.css';
import './styles/complete-ui.css';

import "./styles/design-controls.css";

import './styles/mobile-app.css';

// 設計系統 v2：色票、共用控制項、圓角。之後才是各頁自己的版面。
import './styles/system.css';
import './styles/market.css';
import './styles/fund-page.css';
import './styles/pages.css';
import './styles/covers.css';
// 深色主題（深林綠＋暖金，2026-11-17）：只換色，一定最後載入。
import './styles/theme-dark.css';

import { Component } from 'react';
import type { ReactNode } from 'react';
import { usePrivyAuth } from '../../store/privy';

/**
 * 包住動態載入的 `PrivyRoot`（cre8-app#57）。
 *
 * Privy SDK 那一包下載失敗（斷線、被擋）或初始化時丟錯（App ID 不對）都會在 render 時丟出來；
 * 沒有邊界的話 React 會把**整個 app** 卸掉。登入壞了不該讓人連基金都看不到：
 * 這裡接住、把狀態標成 `unavailable`，登入按鈕會說明原因，其餘頁面照常。
 */
export class PrivyBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    usePrivyAuth.setState({ phase: 'unavailable', error, actions: null });
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

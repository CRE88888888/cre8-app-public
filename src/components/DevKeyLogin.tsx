import { useState } from 'react';
import type { ReactNode } from 'react';
import { createDevSigner, isLikelyPrivateKey } from '../lib/wallet';
import { useWallet } from '../store/wallet';

/**
 * 用一把私鑰直接當錢包（**只在 dev build**，cre8-app#19）。
 *
 * 給誰用：沒有錢包擴充功能的瀏覽器（Claude Desktop 內建瀏覽器、CI 的 headless 瀏覽器）要在
 * 本機 fork 上登入時。沒有這個入口就只能在頁面注入假的 EIP-6963 錢包。
 *
 * 三條不能破的規則：
 * 1. **正式 build 不能帶出去。** 這個檔案只被 `WalletMenu` 在 `import.meta.env.DEV` 為真時
 *    動態 import；正式 build 那個條件是常數 false，整個檔案（含下面的 anvil 測試金鑰）不會進產物。
 *    樣式也因此全部寫在行內，不放進全站 CSS。
 * 2. **私鑰不進任何儲存。** 只活在這個元件的 state 與 wallet store 的記憶體裡；
 *    重新整理就沒了，要再連一次（`use-auto-connect` 也只記 injected 錢包）。
 * 3. **不要貼真的私鑰。** dev 模式的交易走 `VITE_RPC_URL`（預設 vite 的 `/rpc` → 本機 anvil）。
 */

/** anvil 內建測試帳戶 #3 的私鑰：公開的測試金鑰，只在本機鏈上有用。 */
const ANVIL_3 = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';

const inputStyle = {
  width: '100%',
  height: 40,
  padding: '0 12px',
  border: '1px solid var(--hair, #d9dee3)',
  borderRadius: 10,
  background: 'var(--white, #fff)',
  font: '400 13px/1 var(--mono, monospace)',
  color: 'inherit',
} as const;

export default function DevKeyLogin({ disabled = false }: { disabled?: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  function connect(): void {
    setError(null);
    if (!isLikelyPrivateKey(key)) {
      setError('Expected 0x followed by 64 hex characters.');
      return;
    }
    useWallet.getState().connectDev(createDevSigner(key.trim() as `0x${string}`));
  }

  return (
    <>
      <button type="button" className="wallet-menu__item" role="menuitem" aria-expanded={open} onClick={() => setOpen(!open)}>
        Dev private key
      </button>
      {open && (
        <div style={{ display: 'grid', gap: 8, padding: '4px 0 8px' }}>
          <p className="wallet-menu__hint" style={{ margin: 0 }}>
            Dev build only. For a local fork — never paste a real key. The key is kept in memory and is gone after a reload.
          </p>
          <input
            type="password"
            aria-label="Private key"
            autoComplete="off"
            spellCheck={false}
            placeholder="0x…"
            value={key}
            style={inputStyle}
            onChange={(event) => setKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') connect();
            }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn sm" disabled={disabled || key === ''} onClick={connect}>
              Connect with key
            </button>
            <button type="button" className="btn ghost sm" onClick={() => { setKey(ANVIL_3); setError(null); }}>
              Fill anvil #3
            </button>
          </div>
          {error !== null && <p className="wallet-menu__hint neg" role="alert" style={{ margin: 0 }}>{error}</p>}
        </div>
      )}
    </>
  );
}

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { tidyAmountInput } from '../src/lib/amount-input';

describe('tidyAmountInput', () => {
  test('一般輸入原樣保留', () => {
    for (const value of ['', '0', '100', '12.5', '.5', '100.']) expect(tidyAmountInput(value)).toBe(value);
  });

  test('千分位、空白、貨幣符號、單位拿掉', () => {
    expect(tidyAmountInput('1,000')).toBe('1000');
    expect(tidyAmountInput('12,345.67')).toBe('12345.67');
    expect(tidyAmountInput(' 100 ')).toBe('100');
    expect(tidyAmountInput('$100')).toBe('100');
    expect(tidyAmountInput('100 USDT')).toBe('100');
    expect(tidyAmountInput('50usd')).toBe('50');
    // 一個字一個字打：每一步都經過 onChange
    let typed = '';
    for (const char of '75 USDT') typed = tidyAmountInput(typed + char);
    expect(typed).toBe('75');
  });

  test('全形數字與句點轉半形', () => {
    expect(tidyAmountInput('１００')).toBe('100');
    expect(tidyAmountInput('１．５')).toBe('1.5');
  });

  test('不像千分位的逗號不動，避免 1,5 變成 15', () => {
    expect(tidyAmountInput('1,5')).toBe('1,5');
    expect(tidyAmountInput('10,00')).toBe('10,00');
    expect(tidyAmountInput('1,0000')).toBe('1,0000');
  });
});

test('買、賣兩個金額欄位都經過 tidyAmountInput', () => {
  const source = readFileSync(new URL('../src/features/fund/FundPage.tsx', import.meta.url), 'utf8');
  expect(source).toContain('setAmount(tidyAmountInput(event.target.value))');
  expect(source).toContain('setWithdrawAmount(tidyAmountInput(event.target.value))');
});

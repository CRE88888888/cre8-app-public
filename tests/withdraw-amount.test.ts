import { expect, test } from "bun:test";
import { decimalToWeiFloor, withdrawAmountWei } from "../src/lib/format";

// cre8-app#18：實測帳戶 USDT = 49.763435678184792072（18 位小數），
// 舊寫法 toFixed(6) 進位成 49.763436 → 轉帳金額超過餘額而 revert。
const BALANCE = 49_763435678184792072n;
const D = 18;

test("requested more than the balance sends exactly the balance", () => {
  expect(withdrawAmountWei("50", BALANCE, D)).toBe(BALANCE);
  // 舊 bug 的金額：只多 0.000000321…，一樣要被夾回餘額。
  expect(withdrawAmountWei("49.763436", BALANCE, D)).toBe(BALANCE);
  expect(withdrawAmountWei("49.763435678184792073", BALANCE, D)).toBe(BALANCE);
});

test("requested equal to the balance sends the balance", () => {
  expect(withdrawAmountWei("49.763435678184792072", BALANCE, D)).toBe(BALANCE);
});

test("requested less than the balance sends what was asked, never rounded up", () => {
  expect(withdrawAmountWei("20", BALANCE, D)).toBe(20n * 10n ** 18n);
  expect(withdrawAmountWei("49.76", BALANCE, D)).toBe(49_760000000000000000n);
  expect(withdrawAmountWei("0.000001", BALANCE, D)).toBe(10n ** 12n);
});

test("the result never exceeds the balance", () => {
  for (const asked of ["0", "0.01", "49.7634356", "49.76343568", "49.8", "1000000", "49.763435678184792072999"]) {
    expect(withdrawAmountWei(asked, BALANCE, D) <= BALANCE).toBe(true);
  }
});

test("extra decimals are cut, not rounded", () => {
  // 6 位小數的代幣：第 7 位之後直接丟掉。
  expect(decimalToWeiFloor("1.9999999", 6)).toBe(1_999999n);
  expect(decimalToWeiFloor("996.0999", 2)).toBe(99609n);
  expect(decimalToWeiFloor("12", 0)).toBe(12n);
  expect(decimalToWeiFloor(".5", 6)).toBe(500000n);
  expect(decimalToWeiFloor("7.", 6)).toBe(7_000000n);
});

test("anything that is not a plain positive decimal is zero", () => {
  for (const bad of ["", " ", "-1", "1e3", "abc", "1,000", "1.2.3"]) {
    expect(decimalToWeiFloor(bad, 18)).toBe(0n);
  }
  expect(withdrawAmountWei("", BALANCE, D)).toBe(0n);
});

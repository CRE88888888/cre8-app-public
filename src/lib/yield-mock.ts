/**
 * 生息的 mock 資料（APP-3）：`VITE_YIELD_MOCK=1`、或後端沒回生息資料時，畫面用這裡的資料。
 *
 * **市場清單是產生的，不要手改。** 來源與 `testnet-97.ts` 同一份 manifest（cre8-contracts main 795ad25，
 * `deployments/testnet-97.json` 的 `yieldMarkets[]`，30 個，全部是模擬市場）；資產地址直接用 manifest 的，
 * 與地址簿一致。平台市場 id 照後端 `yield-domain.ts`：`${protocol}_${symbol 小寫}`（例如 `aave_v3_usdt`）。
 * 正式資料一律從後端市場清單 API 來。
 */
import { TESTNET_97 } from './testnet-97';
import type { PortfolioYield, YieldMarket, YieldMarketList } from './yield';

export const YIELD_MOCK = import.meta.env.VITE_YIELD_MOCK === '1';

const MANIFEST_97: Omit<YieldMarket, 'dataAt'>[] = [
  { id: 'venus_usdt', marketId: '0x4fbf813d1a8016e09de9898087e51c37410abe16e07297332468ecfdbb795a1c' as `0x${string}`, protocol: 'venus', asset: '0x7ad6e310b0f6744b66d97cb7cb525bd974501cb5', symbol: 'USDT', receipt: '0xb0941bbaca5c192058b8b7a18fe06bfe1670411d', aprBps: 500, simulated: true, supplyOpen: true },
  { id: 'lista_usdt', marketId: '0x22be6327eec096857c8abcd447d7884724f1ed9ad2a7e0b5e5e183b56d8d0e6d' as `0x${string}`, protocol: 'lista', asset: '0x7ad6e310b0f6744b66d97cb7cb525bd974501cb5', symbol: 'USDT', receipt: '0x4e1fb4a2f848cf27d9dd21bd03a8605f79cf9571', aprBps: 300, simulated: true, supplyOpen: true },
  { id: 'aave_v3_usdt', marketId: '0xd8d1aa9bf198bd630398717140b9cca53021e94f87201dd267d0b0b7af408656' as `0x${string}`, protocol: 'aave_v3', asset: '0x7ad6e310b0f6744b66d97cb7cb525bd974501cb5', symbol: 'USDT', receipt: '0xd73186d21bce5a520b52478bfb8d9013c9c1622f', aprBps: 300, simulated: true, supplyOpen: true },
  { id: 'venus_wbnb', marketId: '0x86028bb42e3fedebf63e04f4e98b7ee98fc922409988fdd2d35a109b298fcdf1' as `0x${string}`, protocol: 'venus', asset: '0xbe3f4c2e58e74fbce8e1c5e9360d7abe85aec0f7', symbol: 'WBNB', receipt: '0x2245b8361746e4fc234726c3f1fc77d564a7f941', aprBps: 2, simulated: true, supplyOpen: true },
  { id: 'lista_wbnb', marketId: '0xf3a8ab0377c834f4024db51e944aaa9f6f7f642856fe995587ffe11c42c806bc' as `0x${string}`, protocol: 'lista', asset: '0xbe3f4c2e58e74fbce8e1c5e9360d7abe85aec0f7', symbol: 'WBNB', receipt: '0xbb4934bedfa171cb8543880c87679ed17f4695b2', aprBps: 21, simulated: true, supplyOpen: true },
  { id: 'aave_v3_wbnb', marketId: '0x6aa3e5dbc81480accf0a338a24367a2e6b3d0d9874fc3b9bde4b918c43f7a47b' as `0x${string}`, protocol: 'aave_v3', asset: '0xbe3f4c2e58e74fbce8e1c5e9360d7abe85aec0f7', symbol: 'WBNB', receipt: '0x3d21e7f91bb0af8e1dbfc9d10cbe3e7f3a9f629d', aprBps: 1, simulated: true, supplyOpen: true },
  { id: 'venus_btcb', marketId: '0x1366522ac71738f2e373778c53558fc58f1d7768d4fda08693779622862b77c8' as `0x${string}`, protocol: 'venus', asset: '0x2bacaad9ebc8a2827689f7abbffcbfcbe63c70c1', symbol: 'BTCB', receipt: '0x19be53353f2ca877fc27851f10ca1f86eb581b75', aprBps: 12, simulated: true, supplyOpen: true },
  { id: 'lista_btcb', marketId: '0xe8ed3e5fb1e683eaf595cbf0e373a03782747f9e5d4590d27fca5858f789873e' as `0x${string}`, protocol: 'lista', asset: '0x2bacaad9ebc8a2827689f7abbffcbfcbe63c70c1', symbol: 'BTCB', receipt: '0x08efa9ae96aa1aa50a834e0e5f9819c096ba8c79', aprBps: 1, simulated: true, supplyOpen: true },
  { id: 'aave_v3_btcb', marketId: '0x852104ab4ac3d397cee636b2ed0eb82808d0e41882e595622627414848b87af3' as `0x${string}`, protocol: 'aave_v3', asset: '0x2bacaad9ebc8a2827689f7abbffcbfcbe63c70c1', symbol: 'BTCB', receipt: '0x705a437ef9898be322ef2e713490c9211cb188d0', aprBps: 1, simulated: true, supplyOpen: true },
  { id: 'venus_eth', marketId: '0xdb9ad324e7c1f7da2fad2ecbb44d44e2a56f99e90b9704de7a5273b8c925e89b' as `0x${string}`, protocol: 'venus', asset: '0x6a42bf6ad662aa00de6d00a3da448f4b20b95f3b', symbol: 'ETH', receipt: '0x5dad691860ba337469b6a12e5605fe076e905b0a', aprBps: 34, simulated: true, supplyOpen: true },
  { id: 'aave_v3_eth', marketId: '0xdb77bf0d637dbb6f3170165b0fb394bac85687dfffec22a6c72cab8388d1d8d1' as `0x${string}`, protocol: 'aave_v3', asset: '0x6a42bf6ad662aa00de6d00a3da448f4b20b95f3b', symbol: 'ETH', receipt: '0x9f7964da6b814e96c7c0d51bf8900d7d5c4bda34', aprBps: 57, simulated: true, supplyOpen: true },
  { id: 'venus_usdc', marketId: '0xc5fd35a0f849969ddc877677630f2077d3c25b9e43843eb4a1fd6b90b46d5e82' as `0x${string}`, protocol: 'venus', asset: '0x9cf576befe4ea79b92b60c564fbc71c886bfe194', symbol: 'USDC', receipt: '0x572c120860e621ab84962498c16a186ee6aba188', aprBps: 460, simulated: true, supplyOpen: true },
  { id: 'lista_usdc', marketId: '0x1084fe3d3a43315e2fabc46d1d13da74440070053c60cf5d2134c2f05c379f17' as `0x${string}`, protocol: 'lista', asset: '0x9cf576befe4ea79b92b60c564fbc71c886bfe194', symbol: 'USDC', receipt: '0xf80584ddc017a765cef7bbc95aedd2f318e943ed', aprBps: 230, simulated: true, supplyOpen: true },
  { id: 'aave_v3_usdc', marketId: '0x003dcc7dad5533b9a9caa130b2abc9745f896dfa3a0ea8360b6adf2d856107dc' as `0x${string}`, protocol: 'aave_v3', asset: '0x9cf576befe4ea79b92b60c564fbc71c886bfe194', symbol: 'USDC', receipt: '0x622c7754e34679cb9cdc591565bdbd3436520e2a', aprBps: 344, simulated: true, supplyOpen: true },
  { id: 'venus_xrp', marketId: '0x7266d8868c4e456b9978098450abb8272442fba960f5423485592bb1be6d66e4' as `0x${string}`, protocol: 'venus', asset: '0x37aca01e7cae39a0acaf2d240d5466eaed1d7901', symbol: 'XRP', receipt: '0x0f76e222b49d92fbb9cfae0114ce77150e4bb019', aprBps: 5, simulated: true, supplyOpen: true },
  { id: 'venus_doge', marketId: '0x9754a319c3714c6cc4a263ae8db98fd78a070de4d84b943b1a0418f4a8575cf1' as `0x${string}`, protocol: 'venus', asset: '0xccf96d9561e93af8a1c24d9b23c4091f2299dfa5', symbol: 'DOGE', receipt: '0x9026e8da989c124b08c5bd6b0802e3c0d0eeaa7b', aprBps: 1, simulated: true, supplyOpen: true },
  { id: 'venus_ltc', marketId: '0x970245132a016c2e4453eb3ba515acd7036133f449ca88c46065183b00164687' as `0x${string}`, protocol: 'venus', asset: '0xe2bd04b678f547ff82cf630ad502ab46720a6e6d', symbol: 'LTC', receipt: '0x8cf79b49a990196dc9a877dab40211689748689b', aprBps: 4, simulated: true, supplyOpen: true },
  { id: 'venus_sol', marketId: '0x19f1b78c50f14f3d4bf711a60983ac5f759d8087b5a226737cb6958b6e7c63e3' as `0x${string}`, protocol: 'venus', asset: '0x16d201d507dfd0f459662bb2c3d061784c2264ed', symbol: 'SOL', receipt: '0x6e0745d0d1641800915c7c7bab2889a8b4cd34a9', aprBps: 35, simulated: true, supplyOpen: true },
  { id: 'venus_link', marketId: '0x0835df8e4c7a84ec41a6c1130fd14abe4ac651d8f425dd699cfbc015a247d468' as `0x${string}`, protocol: 'venus', asset: '0x723e405f4e2437e250355541fefc24bf4ce44740', symbol: 'LINK', receipt: '0xa409e7176a5aa3b8766eae44ef93e12fb3eecd5c', aprBps: 5, simulated: true, supplyOpen: true },
  { id: 'venus_ada', marketId: '0x6dc34bc9bda2c529d5d9450cf1971f15449a2d41def340fa26e84d16ed54c7b2' as `0x${string}`, protocol: 'venus', asset: '0x867cd6bb9e2627a03814e202b11759fdf955d172', symbol: 'ADA', receipt: '0x73360c1f8f62f202a414926d7d517d8dc9d99fc6', aprBps: 4, simulated: true, supplyOpen: true },
  { id: 'venus_trx', marketId: '0xaf444c0d70d4fcc72aa1022c97af8cc23ac168db3508141029bb969f26a8b594' as `0x${string}`, protocol: 'venus', asset: '0xe3148b7ab627c5ea9e1d3e3808d888ac44b643d4', symbol: 'TRX', receipt: '0xb5fa880f8807cebceda47113f333502ba856aea9', aprBps: 1, simulated: true, supplyOpen: true },
  { id: 'venus_dai', marketId: '0x4b7f99e568779ac9a111fb9b97a3abfc8ea93f1cdc29d812ac0597d4d69ff66e' as `0x${string}`, protocol: 'venus', asset: '0xed2e4c1a957662c4c95a6f8cb02df9c3f119b08c', symbol: 'DAI', receipt: '0x6c782136ccbcb935931a2777d370c07a8e699689', aprBps: 253, simulated: true, supplyOpen: true },
  { id: 'venus_uni', marketId: '0xb94138f0886e7ecccc93fffb91186a07fa6c0fbb262d17ff51abfb706ac96265' as `0x${string}`, protocol: 'venus', asset: '0x38d82ca0b87815a1740b200771df30ed3b10d9b8', symbol: 'UNI', receipt: '0x797096542bae79b8e9eed2dbd6b0b825be3c6c26', aprBps: 5, simulated: true, supplyOpen: true },
  { id: 'venus_bch', marketId: '0x72cb94c7499cc00fb48146b62ff08a2cbb4d0a43236aceb0484663898a38f87d' as `0x${string}`, protocol: 'venus', asset: '0x3f2905ce60d4f01e62d7feefa4aff977bc377c90', symbol: 'BCH', receipt: '0x1aac02943d573be9322e792e20e292421c86ffcc', aprBps: 15, simulated: true, supplyOpen: true },
  { id: 'venus_aave', marketId: '0x8facc7eb856a69497e2adfb88eb8a0900bef58f666a39fde5aa58089de2bfbac' as `0x${string}`, protocol: 'venus', asset: '0xe1058ec3999a770e3ffae507e154761753e63dbe', symbol: 'AAVE', receipt: '0x4f968af4dbb791bd47af5516f4088b41bf2152ff', aprBps: 1, simulated: true, supplyOpen: true },
  { id: 'venus_dot', marketId: '0xf514defa424d6706374b14a65363e97a7c75d8ad10baf82f70da1c08d47d5d1e' as `0x${string}`, protocol: 'venus', asset: '0xb68d847d182e4568ff4620ff3023ecd8c9b99506', symbol: 'DOT', receipt: '0x4c2ab82e72753d624540274a09cc668a1d502632', aprBps: 1, simulated: true, supplyOpen: true },
  { id: 'venus_fil', marketId: '0x536e9e7a5d340d0126f443a84300541ba58c9fa052ef6bfe88e8c97a35f2387c' as `0x${string}`, protocol: 'venus', asset: '0xcba5d83434b978b860dd7e0f1e16eefd16840c2e', symbol: 'FIL', receipt: '0xc48177374c71d047ed0c2f3501cce84fd7775e88', aprBps: 1, simulated: true, supplyOpen: true },
  { id: 'venus_nvdab', marketId: '0xb1e8cae1c2221a858555caa6f14df11ec869190327eb027e6eb322fa6f769b06' as `0x${string}`, protocol: 'venus', asset: '0x5d63b93e50ef9f8851e1de71d8255c2f0beab397', symbol: 'NVDAB', receipt: '0xa2a6cf661913c901688918f0ebb0947e0df22227', aprBps: 1, simulated: true, supplyOpen: true },
  { id: 'venus_tslab', marketId: '0x2c08255c983c5e2ca01797250e763fdee7617c0999bc82d8b3e5e6cbd1afd138' as `0x${string}`, protocol: 'venus', asset: '0x587cb8fe057344490a28390c7986e1beff5ad36e', symbol: 'TSLAB', receipt: '0x0bcc51d353283cd6b8928b8bd615775cd8228ccb', aprBps: 1, simulated: true, supplyOpen: true },
  { id: 'venus_spcxb', marketId: '0x513ae7eb922dfe932167bd6ea8a72235c516425acf8b129bfc50d3fc700a0870' as `0x${string}`, protocol: 'venus', asset: '0xe7020b7e3adadd3e701a704817b52917c0cc6ce2', symbol: 'SPCXB', receipt: '0x1c13c50c6b61162b97f629d26ef0fe82715f99dd', aprBps: 1, simulated: true, supplyOpen: true },
];

const MARKETS_97: YieldMarket[] = MANIFEST_97.map((market) => ({ ...market, dataAt: null }));

export const MOCK_MARKETS_97: YieldMarketList = {
  chainId: 97,
  registry: TESTNET_97.contracts.yieldRegistry.toLowerCase(),
  markets: MARKETS_97,
};

/**
 * 一個持有人的生息狀態樣本：USDT 已存、BTCB 還沒同意、ETH 部分待領回（使用率高）。
 * 地址取帳戶真的持有的資產：mock 只把 `assets` 換成這檔基金有選市場的那幾個。
 */
export function mockPortfolioYield(fund: readonly { asset: string; symbol: string }[]): PortfolioYield {
  const states = ['supplied', 'not_consented', 'exiting'] as const;
  const rows = fund
    .map((item) => ({ item, market: MARKETS_97.find((market) => market.asset === item.asset.toLowerCase()) }))
    .filter((row): row is { item: { asset: string; symbol: string }; market: YieldMarket } => row.market !== undefined)
    .slice(0, 3);
  const now = new Date().toISOString();
  return {
    permission: 'needs_update',
    accountValue: null,
    assets: rows.map(({ item, market }, index) => {
      const state = states[index] ?? 'not_consented';
      return {
        asset: market.asset,
        symbol: item.symbol,
        market: market.id,
        state,
        receiptValue: state === 'not_consented' ? '0' : '125400000000000000000',
        pending: state === 'exiting' ? { value: '40000000000000000000', reason: 'high_utilization' } : null,
        dataAt: now,
        claimAssets: null,
        maxWithdraw: null,
        valuationState: 'known',
        consented: state !== 'not_consented',
      };
    }),
  };
}

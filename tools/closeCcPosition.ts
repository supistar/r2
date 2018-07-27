// Ad-hoc script to close all leverage positions in Coincheck.

import CoincheckApi from '../src/Coincheck/BrokerApi';
import { options } from '@bitr/logger';
import { getConfigRoot, findBrokerConfig } from '../src/configUtil';
import { CashMarginType } from '../src/types';

options.enabled = false;

async function main() {
  const config = getConfigRoot();
  const ccConfig = findBrokerConfig(config, 'Coincheck');
  const ccApi = new CoincheckApi(ccConfig.key, ccConfig.secret);
  const tradeType = ccConfig.cashMarginType;

  console.log(`Close order was sent.`);
  if (tradeType == CashMarginType.Cash) {
    const ccBalance = await ccApi.getAccountsBalance();
    const ccBtc = ccBalance.btc;

    const request = {
      pair: 'btc_jpy',
      order_type: 'market_sell',
      amount: ccBtc
    };
    console.log(`Selling ${ccBtc}...`);
    const reply = await ccApi.newOrder(request as any);
    if (!reply.success) {
      console.log(reply);
    } else {
      console.log(`Close order was sent.`);
    }
    return;
  }

  const leveragePositions = await ccApi.getAllOpenLeveragePositions();
  for (const position of leveragePositions) {
    const request = {
      pair: 'btc_jpy',
      order_type: position.side === 'buy' ? 'close_long' : 'close_short',
      amount: position.amount,
      position_id: position.id
    };
    console.log(`Closing position id ${position.id}...`);
    const reply = await ccApi.newOrder(request as any);
    if (!reply.success) {
      console.log(reply);
    } else {
      console.log(`Close order was sent.`);
    }
  }
}

main();

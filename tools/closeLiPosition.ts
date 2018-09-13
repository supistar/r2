// Ad-hoc script to close all trades in Liquid.
import LiquidApi from '../src/Liquid/BrokerApi';
import { options } from '@bitr/logger';
import { findBrokerConfig, getConfigRoot } from '../src/configUtil';

options.enabled = false;

async function main() {
  const config = getConfigRoot();
  const quConfig = findBrokerConfig(config, 'Liquid');
  const quApi = new LiquidApi(quConfig.key, quConfig.secret);

  // Liquid margin balance
  try {
    console.log('Closing all in Liquid...');
    await quApi.closeAll();
    console.log('Done.');
  } catch (ex) {
    console.log(ex);
  }
}

main();

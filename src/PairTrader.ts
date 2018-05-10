import { getLogger } from '@bitr/logger';
import { injectable, inject } from 'inversify';
import * as _ from 'lodash';
import OrderImpl from './OrderImpl';
import {
  ConfigStore,
  SpreadAnalysisResult,
  OrderType,
  QuoteSide,
  OrderSide,
  ActivePairStore,
  Quote,
  OrderPair
} from './types';
import t from './intl';
import { delay, formatQuote } from './util';
import symbols from './symbols';
import SingleLegHandler from './SingleLegHandler';
import { findBrokerConfig } from './configUtil';
import BrokerAdapterRouter from './BrokerAdapterRouter';
import { EventEmitter } from 'events';
import { calcProfit } from './pnl';
import * as OrderUtil from './OrderUtil';

@injectable()
export default class PairTrader extends EventEmitter {
  private readonly log = getLogger(this.constructor.name);

  constructor(
    @inject(symbols.ConfigStore) private readonly configStore: ConfigStore,
    private readonly brokerAdapterRouter: BrokerAdapterRouter,
    @inject(symbols.ActivePairStore) private readonly activePairStore: ActivePairStore,
    private readonly singleLegHandler: SingleLegHandler
  ) {
    super();
  }

  set status(value: string) {
    this.emit('status', value);
  }

  async trade(spreadAnalysisResult: SpreadAnalysisResult, closable: boolean): Promise<void> {
    const { bid, ask, targetVolume } = spreadAnalysisResult;
    const sendTasks = [ask, bid].map(q => this.sendOrder(q, targetVolume, OrderType.Limit));
    const orders = await Promise.all(sendTasks);
    this.status = 'Sent';
    await this.checkOrderState(orders, closable);
  }

  private async checkOrderState(orders: OrderImpl[], closable: boolean): Promise<void> {
    const { config } = this.configStore;
    for (const i of _.range(1, config.maxRetryCount + 1)) {
      await delay(config.orderStatusCheckInterval);
      this.log.info(t`OrderCheckAttempt`, i);
      this.log.info(t`CheckingIfBothLegsAreDoneOrNot`);
      try {
        const refreshTasks = orders.map(o => this.brokerAdapterRouter.refresh(o));
        await Promise.all(refreshTasks);
      } catch (ex) {
        this.log.warn(ex.message);
        this.log.debug(ex.stack);
      }

      this.printOrderSummary(orders);

      if (orders.every(o => o.filled)) {
        this.log.info(t`BothLegsAreSuccessfullyFilled`);
        if (closable) {
          this.status = 'Closed';
        } else {
          this.status = 'Filled';
          if (orders[0].size === orders[1].size) {
            this.log.debug(`Putting pair ${JSON.stringify(orders)}.`);
            await this.activePairStore.put(orders as OrderPair);
          }
        }
        this.printProfit(orders, closable);
        break;
      }

      if (i === config.maxRetryCount) {
        this.status = 'MaxRetryCount breached';
        this.log.warn(t`MaxRetryCountReachedCancellingThePendingOrders`);
        const cancelTasks = orders.filter(o => !o.filled).map(o => this.brokerAdapterRouter.cancel(o));
        await Promise.all(cancelTasks);
        if (
          orders.some(o => !o.filled) &&
          this.sumFilledNotionalSize(orders) !== 0
        ) {
          const subOrders = await this.singleLegHandler.handle(orders as OrderPair, closable);
          if (subOrders.length !== 0 && subOrders.every(o => o.filled)) {
            const allOrders = _.concat(orders, subOrders);
            this.printProfit(allOrders, closable);
            const totalSize =  this.sumFilledNotionalSize(allOrders);
            const broker0OrderSize = this.sumFilledNotionalSize(_(allOrders).filter(x => x.broker === orders[0].broker).value());
            const broker1OrderSize = this.sumFilledNotionalSize(_(allOrders).filter(x => x.broker === orders[1].broker).value());
            this.log.debug(`Single leg amount : ${totalSize}/${broker0OrderSize}/${broker1OrderSize}`);
            if (!closable && totalSize === 0 && broker0OrderSize !== 0 && broker1OrderSize !== 0) {
              this.log.debug(`Putting pair for single leg ${JSON.stringify(allOrders)}.`);
              await this.activePairStore.put(allOrders as OrderPair);
            }
          }
        }
        break;
      }
    }
  }

  private sumFilledNotionalSize(orders: OrderImpl[]): number {
    return _.floor(_(orders).sumBy(o => {
      if (o.commissionPaidByQuoted) {
        return o.filledSize * (o.side === OrderSide.Buy 
          ? -1 * (1 - o.commissionPercent / 100) / (1 + o.commissionPercent / 100) 
          : 1);
      } else {
        return o.filledSize * (o.side === OrderSide.Buy 
          ? -1 
          : 1);
      }
    }), 6);
  }

  private async sendOrder(quote: Quote, targetVolume: number, orderType: OrderType): Promise<OrderImpl> {
    this.log.info(t`SendingOrderTargettingQuote`, formatQuote(quote));
    const brokerConfig = findBrokerConfig(this.configStore.config, quote.broker);
    const { config } = this.configStore;
    const { cashMarginType, leverageLevel, commissionPercent, commissionPaidByQuoted } = brokerConfig;
    const orderSide = quote.side === QuoteSide.Ask ? OrderSide.Buy : OrderSide.Sell;
    const orderPrice = 
     (quote.side === QuoteSide.Ask && config.acceptablePriceRange !== undefined)
     ? _.round(quote.price * (1 + config.acceptablePriceRange/100)) as number
     : (quote.side === QuoteSide.Bid && config.acceptablePriceRange !== undefined)
     ? _.round(quote.price * (1 - config.acceptablePriceRange/100)) as number
     : quote.price;
    const order = new OrderImpl({
      symbol: this.configStore.config.symbol,
      broker: quote.broker,
      side: orderSide,
      size: targetVolume,
      price: orderPrice,
      cashMarginType,
      type: orderType,
      leverageLevel,
      commissionPercent,
      commissionPaidByQuoted
    });
    await this.brokerAdapterRouter.send(order);
    return order;
  }

  private printOrderSummary(orders: OrderImpl[]) {
    orders.forEach(o => {
      if (o.filled) {
        this.log.info(OrderUtil.toExecSummary(o));
      } else {
        this.log.warn(OrderUtil.toExecSummary(o));
      }
    });
  }

  private printProfit(orders: OrderImpl[], closable: boolean): void {
    const { profit, commission } = calcProfit(orders, this.configStore.config);
    let side = closable ? 'Close' : 'Open';
    let longBroker = orders[0].side === OrderSide.Buy ? orders[0].broker : orders[1].broker;
    let shortBroker = orders[0].side === OrderSide.Sell ? orders[0].broker : orders[1].broker;
    this.log.info(t`ProfitIs`, _.round(profit), longBroker, shortBroker, side);
    if (commission !== 0) {
      this.log.info(t`CommissionIs`, _.round(commission));
    }
  }
} /* istanbul ignore next */

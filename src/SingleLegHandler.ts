import { OnSingleLegConfig, ReverseOption, ProceedOption, OrderSide, OrderPair, ConfigStore } from './types';
import OrderImpl from './OrderImpl';
import * as _ from 'lodash';
import { getLogger } from '@bitr/logger';
import t from './intl';
import { delay, splitSymbol } from './util';
import BrokerAdapterRouter from './BrokerAdapterRouter';
import { injectable, inject } from 'inversify';
import symbols from './symbols';
import * as OrderUtil from './OrderUtil';

@injectable()
export default class SingleLegHandler {
  private readonly log = getLogger(this.constructor.name);
  private readonly onSingleLegConfig: OnSingleLegConfig;
  private symbol: string;

  constructor(
    private readonly brokerAdapterRouter: BrokerAdapterRouter,
    @inject(symbols.ConfigStore) configStore: ConfigStore
  ) {
    this.onSingleLegConfig = configStore.config.onSingleLeg;
    this.symbol = configStore.config.symbol;
  }

  async handle(orders: OrderPair, closable: boolean): Promise<OrderImpl[]> {
    if (this.onSingleLegConfig === undefined) {
      return [];
    }
    const action = closable ? this.onSingleLegConfig.actionOnExit : this.onSingleLegConfig.action;
    if (action === undefined || action === 'Cancel') {
      return [];
    }
    const { options } = this.onSingleLegConfig;
    switch (action) {
      case 'Reverse':
        return await this.reverseLeg(orders, options as ReverseOption);
      case 'Proceed':
        return await this.proceedLeg(orders, options as ProceedOption);
      default:
        throw new Error('Invalid action.');
    }
  }

  private async reverseLeg(orders: OrderPair, options: ReverseOption): Promise<OrderImpl[]> {
    const smallLeg = orders[0].filledSize <= orders[1].filledSize ? orders[0] : orders[1];
    const largeLeg = orders[0].filledSize <= orders[1].filledSize ? orders[1] : orders[0];
    const sign = largeLeg.side === OrderSide.Buy ? -1 : 1;
    const price = _.round(largeLeg.price * (1 + sign * options.limitMovePercent / 100));
    const size = this.calculateReverseTargetSize(largeLeg, smallLeg);
    const { baseCcy } = splitSymbol(this.symbol);
    this.log.info(t`ReverseFilledLeg`, OrderUtil.toShortString(largeLeg), price.toLocaleString(), size, baseCcy);
    const reversalOrder = new OrderImpl({
      symbol: this.symbol,
      broker: largeLeg.broker,
      side: largeLeg.side === OrderSide.Buy ? OrderSide.Sell : OrderSide.Buy,
      size,
      price,
      cashMarginType: largeLeg.cashMarginType,
      type: options.orderType,
      leverageLevel: largeLeg.leverageLevel,
      commissionPercent: largeLeg.commissionPercent,
      commissionPaidByQuoted: largeLeg.commissionPaidByQuoted
    });
    await this.sendOrderWithTtl(reversalOrder, options.ttl);
    return [reversalOrder];
  }

  private async proceedLeg(orders: OrderPair, options: ProceedOption): Promise<OrderImpl[]> {
    const smallLeg = orders[0].filledSize <= orders[1].filledSize ? orders[0] : orders[1];
    const largeLeg = orders[0].filledSize <= orders[1].filledSize ? orders[1] : orders[0];
    const sign = smallLeg.side === OrderSide.Buy ? 1 : -1;
    const price = _.round(smallLeg.price * (1 + sign * options.limitMovePercent / 100));
    const size = this.calculateProceedTargetSize(smallLeg, largeLeg);
    const { baseCcy } = splitSymbol(this.symbol);
    this.log.info(t`ExecuteUnfilledLeg`, OrderUtil.toShortString(smallLeg), price.toLocaleString(), size, baseCcy);
    const proceedOrder = new OrderImpl({
      symbol: this.symbol,
      broker: smallLeg.broker,
      side: smallLeg.side,
      size,
      price,
      cashMarginType: smallLeg.cashMarginType,
      type: options.orderType,
      leverageLevel: smallLeg.leverageLevel,
      commissionPercent: smallLeg.commissionPercent,
      commissionPaidByQuoted: smallLeg.commissionPaidByQuoted
    });
    await this.sendOrderWithTtl(proceedOrder, options.ttl);
    return [proceedOrder];
  }

  private calculateReverseTargetSize(leftLeg: OrderImpl, rightLeg: OrderImpl): number {
    let leftSize = leftLeg.filledSize;
    let rightSize = rightLeg.filledSize;
    if (leftLeg.commissionPaidByQuoted && leftLeg.side === OrderSide.Buy) {
      leftSize = leftSize * (1 - leftLeg.commissionPercent / 100) / (1 + leftLeg.commissionPercent / 100);
    }
    if (rightLeg.commissionPaidByQuoted && rightLeg.side === OrderSide.Buy) {
      rightSize = rightSize * (1 - rightLeg.commissionPercent / 100) / (1 + rightLeg.commissionPercent / 100);
    }
    return _.floor(leftSize - rightSize, 8);
  }

  private calculateProceedTargetSize(leftLeg: OrderImpl, rightLeg: OrderImpl): number {
    let leftSize = leftLeg.pendingSize;
    let rightSize = rightLeg.pendingSize;
    if (leftLeg.commissionPaidByQuoted && leftLeg.side === OrderSide.Buy) {
      leftSize = leftSize * (1 - leftLeg.commissionPercent / 100) / (1 + leftLeg.commissionPercent / 100);
    }
    if (rightLeg.commissionPaidByQuoted && rightLeg.side === OrderSide.Buy) {
      rightSize = rightSize * (1 - rightLeg.commissionPercent / 100) / (1 + rightLeg.commissionPercent / 100);
    }
    return _.floor(leftSize - rightSize, 8);
  }

  private async sendOrderWithTtl(order: OrderImpl, ttl: number) {
    try {
      this.log.info(t`SendingOrderTtl`, ttl);
      await this.brokerAdapterRouter.send(order);
      const retryCount = 5;
      for (const i of _.range(1, retryCount + 1)) {
        await delay(ttl);
        this.log.info(t`OrderCheckAttempt`, i);
        await this.brokerAdapterRouter.refresh(order);
        if (order.filled) {
          this.log.info(`${OrderUtil.toExecSummary(order)}`);
          return;
        }
        if (i === retryCount) {
          this.log.info(t`NotFilledTtl`, ttl);
          await this.brokerAdapterRouter.cancel(order);
          return;
        }
      }
    } catch (ex) {
      this.log.warn(ex.message);
    }
  }
} /* istanbul ignore next */

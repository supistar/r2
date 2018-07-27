import { CashMarginTypeStrategy } from './types';
import BrokerApi from './BrokerApi';
import { CashMarginType, Order, OrderSide, OrderStatus } from '../types';
import { calculateCoincheckOrderPrice } from './util';

export default class CashStrategy implements CashMarginTypeStrategy {
  constructor(private readonly brokerApi: BrokerApi, private readonly brokerOrderApi: BrokerApi) {}

  async send(order: Order): Promise<void> {
    if (order.cashMarginType !== CashMarginType.Cash) {
      throw new Error();
    }
    const request = {
      pair: 'btc_jpy',
      order_type: this.getBrokerOrderType(order),
      amount: order.size,
      rate: calculateCoincheckOrderPrice(order)
    };
    const reply = await this.brokerOrderApi.newOrder(request);
    if (!reply.success) {
      throw new Error('Send failed.');
    }
    order.sentTime = reply.created_at;
    order.status = OrderStatus.New;
    order.brokerOrderId = reply.id;
    order.lastUpdated = new Date();
  }

  async getBtcPosition(): Promise<number> {
    return (await this.brokerApi.getAccountsBalance()).btc;
  }

  private getBrokerOrderType(order: Order): string {
    switch (order.side) {
      case OrderSide.Buy:
        return 'buy';
      case OrderSide.Sell:
        return 'sell';
      default:
        throw new Error();
    }
  }
}

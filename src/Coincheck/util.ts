import { Order, OrderSide, OrderType } from '../types';
import * as _ from 'lodash';

export function calculateCoincheckOrderPrice(order: Order): number {
  switch (order.side) {
    case OrderSide.Buy:
      switch (order.type) {
        case OrderType.Market:
          return _.floor(order.price * 1.05);
        case OrderType.Limit:
          return order.price;
        default:
          throw new Error();
      }
    case OrderSide.Sell:
      switch (order.type) {
        case OrderType.Market:
          return _.floor(order.price * 0.95);
        case OrderType.Limit:
          return order.price;
        default:
          throw new Error();
      }
    default:
      throw new Error();
  }
}

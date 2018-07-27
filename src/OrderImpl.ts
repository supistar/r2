import * as _ from 'lodash';
import { v4 as uuid } from 'uuid';
import { OrderSide, CashMarginType, OrderType, TimeInForce, OrderStatus, Broker, Order, Execution } from './types';
import { eRound, revive } from './util';

export interface OrderInit {
  symbol: string;
  broker: Broker;
  side: OrderSide;
  size: number;
  price: number;
  cashMarginType: CashMarginType;
  type: OrderType;
  leverageLevel: number;
  commissionPercent: number;
  commissionPaidByQuoted: boolean;
}

export default class OrderImpl implements Order {
  constructor(init: OrderInit) {
    Object.assign(this, init);
  }

  broker: Broker;
  side: OrderSide;
  size: number;
  price: number;
  cashMarginType: CashMarginType;
  type: OrderType;
  leverageLevel: number;
  commissionPercent: number;
  commissionPaidByQuoted: boolean;
  id: string = uuid();
  symbol: string;
  timeInForce: TimeInForce = TimeInForce.None;
  brokerOrderId: string;
  status: OrderStatus = OrderStatus.PendingNew;
  filledSize = 0;
  creationTime: Date = new Date();
  sentTime: Date;
  lastUpdated: Date;
  executions: Execution[] = [];

  get pendingSize(): number {
    return eRound(this.size - this.filledSize);
  }

  get averageFilledPrice(): number {
    // If executions is empty, returns 0.
    const executedSumSize = _.sumBy(this.executions, x => x.size);
    return executedSumSize === 0
      ? 0
      : eRound(_.sumBy(this.executions, x => x.size * x.price) / executedSumSize);
  }

  get filled(): boolean {
    return this.status === OrderStatus.Filled;
  }

  get filledNotionalSize(): number {
    return (this.commissionPaidByQuoted && this.side === OrderSide.Buy)
      ? eRound(this.filledSize * (1 - this.commissionPercent / 100) / (1 + this.commissionPercent / 100))
      : this.filledSize;
  }

  get filledNotional(): number {
    return this.averageFilledPrice * this.filledNotionalSize;
  }
}

export function reviveOrder(o: Order): OrderImpl {
  const r = revive<OrderImpl, Order>(OrderImpl, o);
  r.creationTime = new Date(r.creationTime);
  r.sentTime = new Date(r.sentTime);
  return r;
}

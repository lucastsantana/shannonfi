import { CoinbaseEndpoints } from '../coinbase/endpoints';
import { Portfolio } from '../coinbase/types';
import { computeSolRatioBps, computeDeviationBps } from '../math';
import { logger } from '../tracker/logger';

export class PortfolioService {
  constructor(private endpoints: CoinbaseEndpoints) {}

  /**
   * Fetches current SOL and USD balances plus mid-market price, returns a Portfolio snapshot.
   * listAccounts() and getBestBidAsk() are fetched in parallel — both are reads.
   */
  async getPortfolio(): Promise<Portfolio> {
    const [accountsResp, bbAskResp] = await Promise.all([
      this.endpoints.listAccounts(),
      this.endpoints.getBestBidAsk(),
    ]);

    const solAccount = accountsResp.accounts.find(
      (a) => a.currency === 'SOL' && a.active,
    );
    const usdAccount = accountsResp.accounts.find(
      (a) => a.currency === 'USD' && a.active,
    );

    if (!solAccount) throw new Error('SOL account not found or inactive');
    if (!usdAccount) throw new Error('USD account not found or inactive');

    const solBalance = parseFloat(solAccount.available_balance.value);
    const usdBalance = parseFloat(usdAccount.available_balance.value);

    const pricebook = bbAskResp.pricebooks.find((p) => p.product_id === 'SOL-USD');
    if (!pricebook || pricebook.bids.length === 0 || pricebook.asks.length === 0) {
      throw new Error('SOL-USD pricebook unavailable or empty');
    }

    const bestBid = parseFloat(pricebook.bids[0]!.price);
    const bestAsk = parseFloat(pricebook.asks[0]!.price);
    if (bestBid <= 0 || bestAsk <= 0) {
      throw new Error('Invalid SOL-USD price: bid or ask is zero');
    }
    const solPrice = (bestBid + bestAsk) / 2;

    const solValueUsd = solBalance * solPrice;
    const totalValueUsd = solValueUsd + usdBalance;
    const solRatioBps = computeSolRatioBps(solValueUsd, totalValueUsd);
    const deviationBps = computeDeviationBps(solRatioBps);

    const portfolio: Portfolio = {
      solBalance,
      usdBalance,
      solPrice,
      solValueUsd,
      totalValueUsd,
      solRatioBps,
      deviationBps,
      timestamp: new Date().toISOString(),
    };

    logger.debug('Portfolio snapshot', portfolio);
    return portfolio;
  }
}

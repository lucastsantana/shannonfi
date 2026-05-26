import { MbEndpoints } from '../mb/endpoints';
import { Portfolio } from '../mb/types';
import { computeSolRatioBps, computeDeviationBps } from '../math';
import { logger } from '../tracker/logger';

export class PortfolioService {
  private accountId: string | null = null;

  constructor(private endpoints: MbEndpoints) {}

  private async getAccountId(): Promise<string> {
    if (!this.accountId) {
      this.accountId = await this.endpoints.getAccountId();
    }
    return this.accountId;
  }

  async getPortfolio(): Promise<Portfolio> {
    const accountId = await this.getAccountId();
    const balances = await this.endpoints.getBalances(accountId);

    const solBal = balances.find((b) => b.symbol === 'SOL');
    const brlBal = balances.find((b) => b.symbol === 'BRL');

    const solBalance = solBal ? parseFloat(solBal.available) : 0;
    const brlBalance = brlBal ? parseFloat(brlBal.available) : 0;

    // Get current SOL/BRL price from the order book candles (use last close)
    const candles = await this.endpoints.getCandles(2, '1d');
    if (candles.c.length === 0) {
      throw new Error('Could not fetch SOL-BRL price from candles');
    }
    const solPrice = parseFloat(candles.c[candles.c.length - 1]!);

    const solValueBrl = solBalance * solPrice;
    const totalValueBrl = solValueBrl + brlBalance;
    const solRatioBps = computeSolRatioBps(solValueBrl, totalValueBrl);
    const deviationBps = computeDeviationBps(solRatioBps);

    logger.debug('Portfolio fetched (MB)', {
      solBalance: solBalance.toFixed(6),
      brlBalance: brlBalance.toFixed(2),
      solPriceBrl: solPrice.toFixed(2),
      totalValueBrl: totalValueBrl.toFixed(2),
      solRatioPct: (solRatioBps / 100).toFixed(2) + '%',
    });

    return {
      solBalance,
      brlBalance,
      solPrice,
      solValueBrl,
      totalValueBrl,
      solRatioBps,
      deviationBps,
      timestamp: new Date().toISOString(),
    };
  }
}

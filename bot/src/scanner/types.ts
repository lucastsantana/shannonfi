export interface AssetCandidate {
  symbol: string;           // e.g. "BTC-BRL"
  baseAsset: string;        // e.g. "BTC"
  mad: number;              // mean absolute daily return (fraction, e.g. 0.021 = 2.1%)
  rollingReturn: number;    // total return over window (fraction, e.g. 0.153 = 15.3%)
  avgDailyVolumeBrl: number;// average daily BRL volume
  score: number;            // mad × (1 + rollingReturn)
  rank: number;             // 1 = best score
  dataPoints: number;       // number of daily candles used in calculation
}

export interface ScanResult {
  id?: number;              // DB row ID after insert
  timestamp: string;        // ISO 8601 timestamp when scan completed
  windowDays: number;       // rolling window size in days
  totalScanned: number;     // total number of symbols checked
  candidates: AssetCandidate[];
  status: 'COMPLETED' | 'PENDING_APPROVAL' | 'APPROVED' | 'EXECUTED';
  currentSymbol: string;    // what symbol was active at scan time
  executedAt?: string;      // ISO 8601 timestamp if rotation executed
}

export interface ScanOptions {
  windowDays: number;       // rolling window size, default 30
  minVolumeBrl: number;     // filter assets with avg daily volume < this, default 5_000
  minDataPoints: number;    // skip assets with fewer candles than this, default 10
  returnFloor: number;      // hard filter: skip assets with return < this, default -0.20
  topN: number;             // display top N candidates, default 15
  quoteCurrency: string;    // 'BRL' for Mercado Bitcoin/Binance, 'USD' for Coinbase
}

export interface CallbackQuery {
  id: string;
  chatId: string;
  messageId: number;
  data: string;             // callback button data, e.g. 'select:5:BTC-BRL'
}

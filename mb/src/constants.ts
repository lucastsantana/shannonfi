export const SYMBOL = 'SOL-BRL';

export const DEFAULT_REBALANCE_THRESHOLD_BPS = 100;  // 1%
export const DEFAULT_VOLATILITY_MULTIPLIER = 1.5;
export const DEFAULT_VOLATILITY_WINDOW_DAYS = 30;
export const MIN_ADAPTIVE_THRESHOLD_BPS = 50;
export const MAX_ADAPTIVE_THRESHOLD_BPS = 500;

export const FILL_POLL_INTERVAL_MS = 2_000;
export const FILL_POLL_MAX_ATTEMPTS = 15;

// Brazilian tax constants
export const BR_MONTHLY_EXEMPTION_LIMIT_BRL = 35_000;
export const BR_EXEMPTION_SAFE_BUFFER_BRL = 350;
export const BR_EFFECTIVE_LIMIT_BRL = BR_MONTHLY_EXEMPTION_LIMIT_BRL - BR_EXEMPTION_SAFE_BUFFER_BRL; // 34,650

// National holidays where payment deadlines must skip.
// Source: Lei 9.093/1995 national holidays for 2026-2027.
export const BR_HOLIDAYS = new Set<string>([
  // 2026
  '2026-01-01', // Confraternização Universal
  '2026-02-16', // Carnaval (Monday)
  '2026-02-17', // Carnaval (Tuesday)
  '2026-04-03', // Sexta-Feira Santa (Good Friday)
  '2026-04-21', // Tiradentes
  '2026-05-01', // Dia do Trabalho
  '2026-06-04', // Corpus Christi
  '2026-09-07', // Independência do Brasil
  '2026-10-12', // Nossa Senhora Aparecida
  '2026-11-02', // Finados
  '2026-11-15', // Proclamação da República
  '2026-11-20', // Consciência Negra
  '2026-12-25', // Natal
  // 2027
  '2027-01-01', // Confraternização Universal
  '2027-03-01', // Carnaval (Monday)
  '2027-03-02', // Carnaval (Tuesday)
  '2027-03-26', // Sexta-Feira Santa
  '2027-04-21', // Tiradentes
  '2027-05-01', // Dia do Trabalho
  '2027-05-27', // Corpus Christi
  '2027-09-07', // Independência do Brasil
  '2027-10-12', // Nossa Senhora Aparecida
  '2027-11-02', // Finados
  '2027-11-15', // Proclamação da República
  '2027-11-20', // Consciência Negra
  '2027-12-25', // Natal
]);

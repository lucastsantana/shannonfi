/**
 * GNOME Keyring credential loader.
 * Loads exchange API credentials directly from secure keyring.
 * Never writes secrets to disk or passes them through config files.
 */

import { execSync } from 'child_process';
import { logger } from './tracker/logger';

export interface KeyringCredentials {
  mercadobitcoin?: {
    clientId: string;
    clientSecret: string;
  };
  binance?: {
    apiKey: string;
    apiSecret: string;
  };
  telegram?: {
    botToken: string;
  };
}

/**
 * Load Mercado Bitcoin credentials from GNOME Keyring.
 * Credentials must be stored with:
 *   secret-tool store --label="..." service mercadobitcoin key clientId
 *   secret-tool store --label="..." service mercadobitcoin key clientSecret
 */
export function getMercadoBitcoinCredentials(): { clientId: string; clientSecret: string } {
  try {
    const clientId = execSync('secret-tool lookup service mercadobitcoin key clientId 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    const clientSecret = execSync('secret-tool lookup service mercadobitcoin key clientSecret 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    if (!clientId || !clientSecret) {
      throw new Error('Credentials not found in keyring');
    }

    logger.debug('Loaded Mercado Bitcoin credentials from keyring');
    return { clientId, clientSecret };
  } catch (err) {
    throw new Error(
      'Mercado Bitcoin credentials not found in GNOME Keyring.\n' +
      'Store them with:\n' +
      '  secret-tool store --label="Mercado Bitcoin Client ID" service mercadobitcoin key clientId\n' +
      '  secret-tool store --label="Mercado Bitcoin Client Secret" service mercadobitcoin key clientSecret'
    );
  }
}

/**
 * Load Binance credentials from GNOME Keyring.
 * Credentials must be stored with:
 *   secret-tool store --label="..." service binance key apiKey
 *   secret-tool store --label="..." service binance key apiSecret
 */
export function getBinanceCredentials(): { apiKey: string; apiSecret: string } {
  try {
    const apiKey = execSync('secret-tool lookup service binance key apiKey 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    const apiSecret = execSync('secret-tool lookup service binance key apiSecret 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    if (!apiKey || !apiSecret) {
      throw new Error('Credentials not found in keyring');
    }

    logger.debug('Loaded Binance credentials from keyring');
    return { apiKey, apiSecret };
  } catch (err) {
    throw new Error(
      'Binance credentials not found in GNOME Keyring.\n' +
      'Store them with:\n' +
      '  secret-tool store --label="Binance API Key" service binance key apiKey\n' +
      '  secret-tool store --label="Binance API Secret" service binance key apiSecret'
    );
  }
}

/**
 * Load Telegram bot token from GNOME Keyring (optional).
 * Credentials must be stored with:
 *   secret-tool store --label="..." service telegram key botToken
 * Returns null if not configured.
 */
export function getTelegramCredentials(): { botToken: string } | null {
  try {
    const botToken = execSync('secret-tool lookup service telegram key botToken 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    if (!botToken) {
      return null;
    }

    logger.debug('Loaded Telegram bot token from keyring');
    return { botToken };
  } catch (err) {
    // Telegram not configured, which is optional
    return null;
  }
}

/**
 * Load all available credentials from keyring.
 * Returns only what's available; missing credentials are returned as undefined.
 */
export function getAvailableCredentials(): KeyringCredentials {
  const credentials: KeyringCredentials = {};

  try {
    credentials.mercadobitcoin = getMercadoBitcoinCredentials();
  } catch (err) {
    // MB credentials not available, skip
  }

  try {
    credentials.binance = getBinanceCredentials();
  } catch (err) {
    // Binance credentials not available, skip
  }

  const telegramCreds = getTelegramCredentials();
  if (telegramCreds) {
    credentials.telegram = telegramCreds;
  }

  return credentials;
}

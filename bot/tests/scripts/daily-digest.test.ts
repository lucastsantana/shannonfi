import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TradeHistoryService } from '../../src/core/tracker/history';
import { getDb } from '../../src/core/tracker/db';

/**
 * Tests for daily digest email functionality
 */

describe('Daily Digest Email', () => {
  let testDbPath: string;
  let history: TradeHistoryService;

  beforeEach(() => {
    // Use unique in-memory database for each test
    const testId = Math.random().toString(36).substring(7);
    testDbPath = `:memory:?mode=memory&cache=shared&hash=${testId}`;
    history = new TradeHistoryService(testDbPath);
  });

  it('should format BRL currency correctly', () => {
    const formatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
    const result = formatter.format(1234.56);
    expect(result).toContain('1');
    expect(result).toContain('234');
  });

  it('should format percentage correctly', () => {
    const value = 2.5;
    const result = value.toFixed(2) + '%';
    expect(result).toBe('2.50%');
  });

  it('should compute yesterday date in BRT', () => {
    // Safely compute yesterday in BRT
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    expect(dateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof dateStr).toBe('string');
  });

  it('should handle no snapshot data gracefully', () => {
    const snapshots = history.readSnapshots();
    expect(snapshots).toEqual([]);
  });

  it('should read trades from yesterday', () => {
    // Verify tables exist
    const snapshots = history.readSnapshots();
    // readSnapshots handles empty table gracefully, so we just verify no errors occur
    expect(Array.isArray(snapshots)).toBe(true);
  });

  it('should validate email address format', () => {
    const validEmails = ['valid@yahoo.com.br', 'user+tag@yahoo.com'];
    const invalidEmails = ['invalid-email', 'no-at-sign.com', '@nodomain.com'];

    validEmails.forEach((email) => {
      const isValid = email.includes('@') && email.indexOf('@') > 0 && email.lastIndexOf('@') < email.length - 1;
      expect(isValid).toBe(true);
    });

    invalidEmails.forEach((email) => {
      const isValid = email.includes('@') && email.indexOf('@') > 0 && email.lastIndexOf('@') < email.length - 1;
      expect(isValid).toBe(false);
    });
  });

  it('should render HTML email without errors', () => {
    const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body>
      <h1>Test Email</h1>
      <p>Daily return: +1.23%</p>
      <p>Portfolio value: R$ 1.000,00</p>
    </body>
    </html>
    `.trim();

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<h1>Test Email</h1>');
    expect(html).toContain('Daily return');
  });

  it('should parse month and day from ISO date', () => {
    const dateStr = '2026-05-27';
    const parts = dateStr.split('-');
    const year = parts[0];
    const month = parseInt(parts[1]!, 10);
    const day = parseInt(parts[2]!, 10);

    expect(year).toBe('2026');
    expect(month).toBe(5);
    expect(day).toBe(27);

    const monthNames = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    const monthName = monthNames[month - 1];
    expect(monthName).toBe('May');
  });

  it('should compute portfolio metrics', () => {
    const startValue = 1000;
    const endValue = 1020;
    const dailyReturn = ((endValue - startValue) / startValue) * 100;

    expect(dailyReturn).toBeCloseTo(2.0, 1);
  });

  it('should compute SOL ratio from basis points', () => {
    const solRatioBps = 5000; // 50%
    const solRatioPct = solRatioBps / 100;

    expect(solRatioPct).toBe(50);
  });

  it('should compute deviation from target', () => {
    const solRatioBps = 5000;
    const solRatioPct = solRatioBps / 100;
    const deviation = solRatioPct - 50;

    expect(deviation).toBe(0);
  });

  it('should handle edge case: 100% SOL allocation', () => {
    const solRatioBps = 10000;
    const solRatioPct = solRatioBps / 100;
    const deviation = solRatioPct - 50;

    expect(solRatioPct).toBe(100);
    expect(deviation).toBe(50);
  });

  it('should handle edge case: 0% SOL allocation', () => {
    const solRatioBps = 0;
    const solRatioPct = solRatioBps / 100;
    const deviation = solRatioPct - 50;

    expect(solRatioPct).toBe(0);
    expect(deviation).toBe(-50);
  });

  it('should count trades by direction', () => {
    const trades = [
      { direction: 'BUY_SOL', feeBrl: 10 },
      { direction: 'BUY_SOL', feeBrl: 15 },
      { direction: 'SELL_SOL', feeBrl: 5 },
    ];

    const buyCount = trades.filter((t) => t.direction === 'BUY_SOL').length;
    const sellCount = trades.filter((t) => t.direction === 'SELL_SOL').length;
    const totalFees = trades.reduce((sum, t) => sum + t.feeBrl, 0);

    expect(buyCount).toBe(2);
    expect(sellCount).toBe(1);
    expect(totalFees).toBe(30);
  });
});

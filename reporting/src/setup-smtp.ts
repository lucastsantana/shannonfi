#!/usr/bin/env node
/**
 * Setup SMTP credentials in GNOME Keyring.
 * Securely stores Yahoo app password and tests the connection.
 *
 * Usage:
 *   npm run setup-smtp
 *   ts-node src/scripts/setup-smtp.ts
 */

import { execSync } from 'child_process';
import { logger } from '../../bot/src/core/tracker/logger';

/**
 * Store a secret in GNOME Keyring using secret-tool
 */
function storeSecret(service: string, key: string, label: string, value: string): void {
  try {
    const cmd = `secret-tool store --label="${label}" service ${service} key ${key}`;
    execSync(cmd, {
      input: value,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    logger.info(`Stored ${label} in keyring`, { service, key });
  } catch (err) {
    logger.error(`Failed to store secret in keyring`, {
      service,
      key,
      error: (err as Error).message,
    });
    throw err;
  }
}

/**
 * Retrieve a secret from GNOME Keyring
 */
function retrieveSecret(service: string, key: string): string | null {
  try {
    const value = execSync(`secret-tool lookup service ${service} key ${key}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return value || null;
  } catch (err) {
    return null;
  }
}

/**
 * Test SMTP connection
 */
async function testSmtpConnection(host: string, port: number, secure: boolean, username: string, password: string): Promise<void> {
  try {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.default.createTransport({
      host,
      port,
      secure,
      auth: {
        user: username,
        pass: password,
      },
    });

    logger.info('Testing SMTP connection...', { host, port, secure, username });
    const result = await transporter.verify();

    if (result) {
      logger.info('✓ SMTP connection successful', { host, port, username });
    } else {
      logger.error('✗ SMTP connection failed: verification returned false', { host, port, username });
      process.exit(1);
    }
  } catch (err) {
    logger.error('✗ SMTP connection failed', {
      host,
      port,
      username,
      error: (err as Error).message,
    });
    process.exit(1);
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  logger.info('Shannon\'s Demon SMTP Setup');
  logger.info('This script securely stores your Yahoo app password in GNOME Keyring');

  // Check if keyring is available
  try {
    execSync('which secret-tool', { stdio: 'pipe' });
  } catch (err) {
    logger.error('secret-tool not found. Please install gnome-keyring first:');
    logger.error('  sudo apt install gnome-keyring  # Debian/Ubuntu');
    logger.error('  brew install gnome-keyring      # macOS');
    process.exit(1);
  }

  // Yahoo SMTP credentials
  const smtpHost = 'smtp.mail.yahoo.com';
  const smtpPort = 587;
  const smtpSecure = false;

  logger.info('Setting up SMTP credentials for Yahoo Mail...');

  // Check if password is already stored
  const existingPassword = retrieveSecret('shannon-demon', 'smtp-password');
  if (existingPassword) {
    logger.warn('SMTP password already stored in keyring');
    logger.info('To update it, run: secret-tool clear service shannon-demon key smtp-password');
  }

  // Prompt user for input
  logger.info('');
  logger.info('Please provide your information:');
  logger.info('');

  // Use readline to get user input
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, (answer) => {
        resolve(answer);
      });
    });
  };

  try {
    const username = await question('Yahoo email address (e.g., user@yahoo.com.br): ');
    if (!username || !username.includes('@')) {
      logger.error('Invalid email address');
      process.exit(1);
    }

    const password = await question('App password (16 chars, from Yahoo Account Security): ');
    if (!password || password.length < 10) {
      logger.error('Invalid app password');
      process.exit(1);
    }

    const recipientEmail = await question('Recipient email for digest (can be same as above): ');
    if (!recipientEmail || !recipientEmail.includes('@')) {
      logger.error('Invalid recipient email');
      process.exit(1);
    }

    rl.close();

    // Store credentials in keyring
    logger.info('');
    logger.info('Storing credentials in GNOME Keyring...');
    storeSecret('shannon-demon', 'smtp-username', 'Shannon Demon SMTP Username', username);
    storeSecret('shannon-demon', 'smtp-password', 'Shannon Demon SMTP Password', password);
    storeSecret('shannon-demon', 'smtp-recipient', 'Shannon Demon SMTP Recipient Email', recipientEmail);

    logger.info('✓ Credentials stored successfully');
    logger.info('');

    // Test connection
    logger.info('Testing SMTP connection...');
    logger.info('');
    await testSmtpConnection(smtpHost, smtpPort, smtpSecure, username, password);

    logger.info('');
    logger.info('Setup complete! Your SMTP credentials are now stored in GNOME Keyring.');
    logger.info('The daily digest will read them from the keyring at runtime.');
  } catch (err) {
    logger.error('Setup failed', { error: (err as Error).message });
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error('Fatal error', { error: (err as Error).message });
  process.exit(1);
});

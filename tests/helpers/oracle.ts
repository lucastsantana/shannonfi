import { PublicKey, Keypair, Connection, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

// Helper to create a mock Pyth price feed account
// This is a simplified version for testing; real Pyth feeds are created via Pyth's API
export function createMockPythPriceFeed(
  price: number,
  expo: number,
  publishTime: number,
  programId: PublicKey
) {
  const feed = Keypair.generate();

  // Pyth PriceUpdateV2 structure (simplified)
  // In practice, you'd construct this with proper encoding
  return {
    publicKey: feed.publicKey,
    keypair: feed,
    priceData: {
      price,
      expo,
      publish_time: publishTime,
    },
  };
}

// Helper to get the SOL/USD feed address for testing
export function getSolUsdFeedAddress(network: "mainnet" | "devnet" | "localnet"): PublicKey {
  // Mainnet Pyth SOL/USD feed
  if (network === "mainnet") {
    return new PublicKey("7UVimffxpLc1XBJuFgkPLd7XynbRhB5zs7g5V7cqXpa");
  }

  // For devnet and localnet, use a mock address
  return new PublicKey("7UVimffxpLc1XBJuFgkPLd7XynbRhB5zs7g5V7cqXpa");
}

import { PublicKey, Keypair } from "@solana/web3.js";

// Helper to fetch Jupiter quote for a swap
export async function getJupiterQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: number;
  slippageBps?: number;
}) {
  const {
    inputMint,
    outputMint,
    amount,
    slippageBps = 50,
  } = params;

  const quoteUrl = new URL("https://api.jup.ag/swap/v1/quote");
  quoteUrl.searchParams.append("inputMint", inputMint);
  quoteUrl.searchParams.append("outputMint", outputMint);
  quoteUrl.searchParams.append("amount", amount.toString());
  quoteUrl.searchParams.append("slippageBps", slippageBps.toString());

  const response = await fetch(quoteUrl.toString());
  return response.json();
}

// Helper to get swap instructions from Jupiter
export async function getJupiterSwapInstructions(params: {
  quoteResponse: any;
  userPublicKey: string;
  wrapUnwrapSOL?: boolean;
}) {
  const {
    quoteResponse,
    userPublicKey,
    wrapUnwrapSOL = true,
  } = params;

  const swapUrl = new URL("https://api.jup.ag/swap/v1/swap-instructions");

  const response = await fetch(swapUrl.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapUnwrapSOL,
    }),
  });

  return response.json();
}

// Mock function for testing without real Jupiter API calls
export function mockJupiterSwapAccounts(direction: "SOL_TO_USDC" | "USDC_TO_SOL") {
  const accounts: PublicKey[] = [];

  // In practice, these would be the actual swap pool and token accounts
  // For testing, we use placeholder addresses
  for (let i = 0; i < 10; i++) {
    accounts.push(Keypair.generate().publicKey);
  }

  return accounts;
}

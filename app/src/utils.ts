import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";

// Fetch Jupiter quote for a swap
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

  const url = new URL("https://api.jup.ag/swap/v1/quote");
  url.searchParams.append("inputMint", inputMint);
  url.searchParams.append("outputMint", outputMint);
  url.searchParams.append("amount", amount.toString());
  url.searchParams.append("slippageBps", slippageBps.toString());

  const response = await fetch(url.toString());
  const data = await response.json();

  return data;
}

// Get swap instructions from Jupiter
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

  const url = new URL("https://api.jup.ag/swap/v1/swap-instructions");

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapUnwrapSOL,
    }),
  });

  const data = await response.json();
  return data;
}

// Helper to estimate gas/priority fees for a transaction
export async function estimatePriorityFee(connection: Connection): Promise<number> {
  try {
    const recentPriorityFees = await connection.getRecentPrioritizationFees();
    if (recentPriorityFees.length === 0) return 100; // Default: 100 lamports

    // Use median fee
    const fees = recentPriorityFees.map(f => f.prioritizationFee);
    fees.sort((a, b) => a - b);
    return fees[Math.floor(fees.length / 2)];
  } catch {
    return 100;
  }
}

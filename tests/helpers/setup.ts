import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, LAMPORTS_PER_SOL, Keypair } from "@solana/web3.js";
import { Shannonfi } from "../../target/types/shannonfi";

export async function setupLocalnet() {
  const provider = AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Shannonfi as Program<Shannonfi>;

  return { provider, program };
}

export async function airdropSOL(
  connection: anchor.web3.Connection,
  wallet: PublicKey,
  lamports: number
) {
  const signature = await connection.requestAirdrop(wallet, lamports);
  await connection.confirmTransaction(signature);
}

export function deriveVaultPDA(authority: PublicKey, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), authority.toBuffer()],
    programId
  );
}

export function deriveShareMintPDA(vault: PublicKey, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("share_mint"), vault.toBuffer()],
    programId
  );
}

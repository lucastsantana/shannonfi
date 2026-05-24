import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, LAMPORTS_PER_SOL, Keypair, SystemProgram } from "@solana/web3.js";
import { Shannonfi } from "../../target/types/shannonfi";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/utils/token";

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

export async function createMintAndATA(
  provider: AnchorProvider,
  authority: PublicKey,
  decimals: number = 6
) {
  // Create mint
  const mint = Keypair.generate();
  const tx = new anchor.web3.Transaction();

  tx.add(
    SystemProgram.createAccount({
      fromPubkey: provider.wallet.publicKey,
      newAccountPubkey: mint.publicKey,
      space: 82,
      lamports: await provider.connection.getMinimumBalanceForRentExemption(82),
      programId: TOKEN_PROGRAM_ID,
    })
  );

  await provider.sendAndConfirm(tx, [mint]);

  // Create ATA
  const ata = anchor.utils.token.associatedAddress({
    mint: mint.publicKey,
    owner: authority,
  });

  const createAtaTx = new anchor.web3.Transaction();
  createAtaTx.add(
    anchor.utils.token.createAssociatedTokenAccountInstruction(
      provider.wallet.publicKey,
      ata,
      authority,
      mint.publicKey
    )
  );

  await provider.sendAndConfirm(createAtaTx);

  return { mint: mint.publicKey, ata };
}

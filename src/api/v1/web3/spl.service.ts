import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../../../config/config.service';
import { Wallet } from '@coral-xyz/anchor';
import * as bs58 from 'bs58';
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  VersionedTransaction,
  TransactionMessage,
  SendOptions,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { TokenListProvider, TokenInfo, ENV } from '@solana/spl-token-registry';
import {
  AuthorityType,
  createAccount,
  createMint,
  freezeAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  setAuthority,
  thawAccount,
} from '@solana/spl-token';
import { getExplorerLink } from '@solana-developers/helpers';
import * as fs from 'fs';
import { createCreateMetadataAccountV3Instruction } from '@metaplex-foundation/mpl-token-metadata';
const pinataSDK = require('@pinata/sdk');
import { BN } from 'bn.js';
import {
  DEVNET_PROGRAM_ID,
  InnerSimpleV0Transaction,
  LOOKUP_TABLE_CACHE,
  Liquidity,
  MAINNET_PROGRAM_ID,
  MarketV2,
  SPL_ACCOUNT_LAYOUT,
  TOKEN_PROGRAM_ID,
  Token,
  TokenAccount,
  TxVersion,
  buildSimpleTransaction,
} from '@raydium-io/raydium-sdk';
import Decimal from 'decimal.js';
import { any } from 'joi';
import { RadiumService } from './radium.service';

const ZERO = new BN(0);
type BN = typeof ZERO;
type CalcStartPrice = {
  addBaseAmount: BN;
  addQuoteAmount: BN;
};

type LiquidityPairTargetInfo = {
  baseToken: Token;
  quoteToken: Token;
  targetMarketId: PublicKey;
};

type WalletTokenAccounts = Awaited<ReturnType<typeof any>>;
type TestTxInputInfo = LiquidityPairTargetInfo &
  CalcStartPrice & {
    startTime: number; // seconds
    walletTokenAccounts: WalletTokenAccounts;
    wallet: Keypair;
  };

@Injectable()
export class SPLService {
  private readonly makeTxVersion = TxVersion.V0; // LEGACY
  private readonly addLookupTableInfo = LOOKUP_TABLE_CACHE; // only mainnet. other = undefined
  private readonly OPENBOOK_PROGRAM_ID = new PublicKey(
    'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',
  );
  private readonly PROGRAMIDS = DEVNET_PROGRAM_ID;
  private readonly logger = new Logger(SPLService.name);
  private readonly connection: Connection;
  private readonly wallet: Wallet;
  private readonly payer = this.loadKeyPair(
    'paMYeTmBG5wjWsxwFbTdXpRTWtyQP499FCZhNY11zUm.json',
  );
  private readonly mint = this.loadKeyPair(
    'mingB6iZ8XZSwyJgHMa4t3uk2CJHQiDTRLnDbbd7Hcq.json',
  );
  private readonly freeze = this.loadKeyPair(
    'frn9pRbCSS6UtjDLxsVFHbAfBppeXBUeqBihWvGy7N7.json',
  );
  private readonly pinata: any;
  private DEVNET_HELIUM_RPC =
    'https://devnet.helius-rpc.com/?api-key=7c621932-aeba-4702-b813-6920db6dad72';

  constructor(
    private readonly config: ConfigService,
    private readonly radiumService: RadiumService,
  ) {
    this.pinata = new pinataSDK(
      this.config.PINATA_API_KEY,
      this.config.PINATA_SECRET_KEY,
    );
    this.connection = new Connection(this.DEVNET_HELIUM_RPC, {
      commitment: 'confirmed',
    });
    this.wallet = new Wallet(
      Keypair.fromSecretKey(
        Uint8Array.from(bs58.decode(this.config.WALLET_PRIVATE_KEY)),
      ),
    );
  }

  async mintToken() {
    try {
      console.log(process.cwd());

      const tokenKeypair = Keypair.generate();

      console.log('Token Address :', tokenKeypair.publicKey.toString());

      const tokenMint = await createMint(
        this.connection,
        this.payer,
        this.payer.publicKey,
        this.freeze.publicKey,
        9,
        tokenKeypair,
      );

      const link = getExplorerLink('address', tokenMint.toString(), 'devnet');

      console.log(`✅ Finished! Created token mint: ${link}`);
      return { link, tokenKeypair };
    } catch (error) {
      throw new Error(error.message);
    }
  }

  loadKeyPair(path: string) {
    const pairSecret = JSON.parse(fs.readFileSync(`./pair/${path}`, 'utf-8'));
    const pairSecretKey = Uint8Array.from(pairSecret);
    const pair = Keypair.fromSecretKey(pairSecretKey);
    return pair;
  }

  async createTokenMetaData(tokenAddress: string, metadataUrl: string) {
    try {
      const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
        'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
      );

      const tokenMintAccount = new PublicKey(tokenAddress);

      const metadataData = {
        name: 'The Big Boys',
        symbol: 'Queen',
        // Arweave / IPFS / Pinata etc link using metaplex standard for off-chain data
        uri: metadataUrl,
        sellerFeeBasisPoints: 0,
        creators: null,
        collection: null,
        uses: null,
      };

      const metadataPDAAndBump = PublicKey.findProgramAddressSync(
        [
          Buffer.from('metadata'),
          TOKEN_METADATA_PROGRAM_ID.toBuffer(),
          tokenMintAccount.toBuffer(),
        ],
        TOKEN_METADATA_PROGRAM_ID,
      );

      const metadataPDA = metadataPDAAndBump[0];

      const transaction = new Transaction();

      const createMetadataAccountInstruction =
        createCreateMetadataAccountV3Instruction(
          {
            metadata: metadataPDA,
            mint: tokenMintAccount,
            mintAuthority: this.payer.publicKey,
            payer: this.payer.publicKey,
            updateAuthority: this.payer.publicKey,
          },
          {
            createMetadataAccountArgsV3: {
              collectionDetails: null,
              data: metadataData,
              isMutable: true,
            },
          },
        );

      transaction.add(createMetadataAccountInstruction);
      const signers = [this.payer];
      const transactionSignature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        signers,
      );

      const transactionLink = getExplorerLink(
        'transaction',
        transactionSignature,
        'devnet',
      );

      // console.log(
      //   `✅ Transaction confirmed, explorer link is: ${transactionLink}!`,
      // );

      const tokenMintLink = getExplorerLink(
        'address',
        tokenMintAccount.toString(),
        'devnet',
      );

      console.log(`✅ Look at the token mint again: ${tokenMintLink}!`);
      return { link: tokenMintLink };
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async createOrGetAssociatedTokenAccount(tokenAddress: string) {
    const tokenMintAccount = new PublicKey(tokenAddress);

    // Here we are making an associated token account for our own address, but we can
    // make an ATA on any other wallet in devnet!
    // const recipient = new PublicKey("SOMEONE_ELSES_DEVNET_ADDRESS");
    const recipient = this.payer.publicKey;

    const tokenAccount = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.payer,
      tokenMintAccount,
      recipient,
    );

    console.log(`Token Account: ${tokenAccount.address.toBase58()}`);

    const link = getExplorerLink(
      'address',
      tokenAccount.address.toBase58(),
      'devnet',
    );

    console.log(`✅ Created token Account: ${link}`);
    return { link: link };
  }

  async mintTokens(tokenAddress: string) {
    try {
      // Our token has nine decimal places
      const MINOR_UNITS_PER_MAJOR_UNITS = Math.pow(10, 9);

      // Substitute in your token mint account from create-token-mint.ts
      const tokenMintAccount = new PublicKey(tokenAddress);

      // Create or get the associated token account for the recipient
      const recipientAssociatedTokenAccount =
        await getOrCreateAssociatedTokenAccount(
          this.connection,
          this.payer,
          tokenMintAccount,
          this.payer.publicKey,
        );

      const transactionSignature = await mintTo(
        this.connection,
        this.payer,
        tokenMintAccount,
        recipientAssociatedTokenAccount.address, // Use the address of the associated token account
        this.payer,
        10000000 * MINOR_UNITS_PER_MAJOR_UNITS,
      );

      const link = getExplorerLink(
        'transaction',
        transactionSignature,
        'devnet',
      );

      console.log(`✅ Success! Mint Token Transaction: ${link}`);
      return { link };
    } catch (error) {
      console.log(error);
      throw new Error(error.message);
    }
  }

  async stopMinting(tokenAddress: string) {
    try {
      const tokenMintAccount = new PublicKey(tokenAddress);
      const signers = [this.payer, this.mint];
      const transactionSignature = await setAuthority(
        this.connection,
        this.payer,
        tokenMintAccount,
        this.mint.publicKey,
        AuthorityType.MintTokens,
        null,
        signers,
      );

      const link = getExplorerLink(
        'transaction',
        transactionSignature,
        'devnet',
      );

      console.log(`✅ Stopped minting: ${link}`);
      return { link };
    } catch (error) {
      console.log(error);
      throw new Error(error.message);
    }
  }

  async freezeTokenAccount(tokenAddress: string, accountToFreeze: string) {
    try {
      const tokenMintAccount = new PublicKey(tokenAddress);
      const accountToFreezePublicKey = new PublicKey(accountToFreeze);
      const signers = [this.payer, this.mint];
      const transactionSignature = await freezeAccount(
        this.connection,
        this.payer,
        accountToFreezePublicKey,
        tokenMintAccount,
        this.freeze,
        signers,
      );

      const link = getExplorerLink(
        'transaction',
        transactionSignature,
        'devnet',
      );

      console.log(`✅ Token account frozen: ${link}`);
      return { link };
    } catch (error) {
      console.log(error);
      throw new Error(error.message);
    }
  }

  async thawTokenAccount(tokenAddress: string, accountToThaw: string) {
    try {
      const tokenMintAccount = new PublicKey(tokenAddress);
      const accountToThawPublicKey = new PublicKey(accountToThaw);
      const signers = [this.payer, this.mint];

      const transactionSignature = await thawAccount(
        this.connection,
        this.payer,
        accountToThawPublicKey,
        tokenMintAccount,
        this.freeze,
        signers,
      );

      const link = getExplorerLink(
        'transaction',
        transactionSignature,
        'devnet',
      );

      console.log(`✅ Token account thawed: ${link}`);
      return { link };
    } catch (error) {
      console.log(error);
      throw new Error(error.message);
    }
  }

  async uploadToPinata(filePath: string = 'images/about-service-img.png') {
    try {
      // Step 1: Upload image to Pinata
      const readableStreamForFile = fs.createReadStream(filePath);
      const imageUploadOptions = {
        pinataMetadata: {
          name: 'helloworld',
        },
      };

      const imageResult = await this.pinata.pinFileToIPFS(
        readableStreamForFile,
        imageUploadOptions,
      );
      const imageUrl = `https://gateway.pinata.cloud/ipfs/${imageResult.IpfsHash}`;
      console.log(`Image uploaded to IPFS: ${imageUrl}`);

      // Step 2: Create metadata JSON
      const metadata = {
        name: 'The Big Boys',
        symbol: 'Queen',
        description: 'Description of the token.',
        seller_fee_basis_points: 500,
        image: imageUrl,
        attributes: [
          {
            trait_type: 'Background',
            value: 'Blue',
          },
          {
            trait_type: 'Rarity',
            value: 'Rare',
          },
        ],
        properties: {
          creators: [
            {
              address: this.payer.publicKey.toString(),
              share: 10,
            },
          ],
          files: [
            {
              uri: imageUrl,
              type: 'image/png',
            },
          ],
        },
        links: {
          website: 'https://example.com',
          twitter: 'https://twitter.com/example',
          discord: 'https://discord.gg/example',
        },
      };

      const metadataFilePath = 'images/metadata.json';
      fs.writeFileSync(metadataFilePath, JSON.stringify(metadata));
      console.log(`Metadata JSON created at: ${metadataFilePath}`);

      // Step 3: Upload metadata JSON to Pinata
      const metadataStream = fs.createReadStream(metadataFilePath);
      const metadataUploadOptions = {
        pinataMetadata: {
          name: 'metadata',
        },
      };

      const metadataResult = await this.pinata.pinFileToIPFS(
        metadataStream,
        metadataUploadOptions,
      );
      const metadataUrl = `https://gateway.pinata.cloud/ipfs/${metadataResult.IpfsHash}`;
      console.log(`Metadata uploaded to IPFS: ${metadataUrl}`);

      return metadataUrl;
    } catch (error) {
      console.log(error);
      throw new Error(`Error uploading file to Pinata: ${error.message}`);
    }
  }

  async createToken() {
    try {
      // Now i am going to create a token
      const mintedToken = await this.mintToken();
      const metadataUrl = await this.uploadToPinata();
      const metaData = await this.createTokenMetaData(
        mintedToken.tokenKeypair.publicKey.toString(),
        metadataUrl,
      );
      const associatedTokenAccount =
        await this.createOrGetAssociatedTokenAccount(
          mintedToken.tokenKeypair.publicKey.toString(),
        );
      const mintTokens = await this.mintTokens(
        mintedToken.tokenKeypair.publicKey.toString(),
      );
      // const stopMinting = await this.stopMinting(
      //   mintedToken.tokenKeypair.publicKey.toString(),
      // );

      return {
        mintedLink: mintedToken.link,
        metaDataLink: metaData.link,
        associatedLink: associatedTokenAccount.link,
        mintTokensLink: mintTokens.link,
      };
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async ammCreatePool(input: any): Promise<{ txids: string[] }> {
    // -------- step 1: make instructions --------
    const initPoolInstructionResponse =
      await Liquidity.makeCreatePoolV4InstructionV2Simple({
        connection: this.connection,
        programId: this.PROGRAMIDS.AmmV4,
        marketInfo: {
          marketId: input.targetMarketId,
          programId: this.PROGRAMIDS.OPENBOOK_MARKET,
        },
        baseMintInfo: input.baseToken,
        quoteMintInfo: input.quoteToken,
        baseAmount: input.addBaseAmount,
        quoteAmount: input.addQuoteAmount,
        startTime: new BN(Math.floor(input.startTime)),
        ownerInfo: {
          feePayer: input.wallet.publicKey,
          wallet: input.wallet.publicKey,
          tokenAccounts: input.walletTokenAccounts,
          useSOLBalance: true,
        },
        associatedOnly: false,
        checkCreateATAOwner: true,
        makeTxVersion: TxVersion.V0,
        feeDestinationId: new PublicKey(
          '7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5',
        ), // only mainnet use this
      });
    const signers = [this.payer, this.mint];
    const transaction = new Transaction().add(
      ...initPoolInstructionResponse.innerTransactions.map((ix: any) =>
        Transaction.from(ix),
      ),
    );
    const txid = await sendAndConfirmTransaction(
      this.connection,
      transaction,
      signers,
      {
        skipPreflight: false,
        preflightCommitment: 'singleGossip',
      },
    );
    return { txids: [txid] };
  }

  async getWalletTokenAccount(
    connection: Connection,
    wallet: PublicKey,
  ): Promise<TokenAccount[]> {
    const walletTokenAccount = await connection.getTokenAccountsByOwner(
      wallet,
      {
        programId: TOKEN_PROGRAM_ID,
      },
    );
    return walletTokenAccount.value.map((i) => ({
      pubkey: i.pubkey,
      programId: i.account.owner,
      accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
    }));
  }

  getToken(
    address: string,
    decimal: number,
    symbol: string,
    tokenName: string,
  ) {
    return new Token(
      TOKEN_PROGRAM_ID,
      new PublicKey(address),
      decimal,
      symbol,
      tokenName,
    );
  }

  async howToUse() {
    try {
      const baseToken = this.getToken(
        'So11111111111111111111111111111111111111112',
        9,
        'WSOL',
        'WSOL',
      ); // USDC
      const quoteToken = this.getToken(
        '5D4k9XaSn6BeL1mR6TkafMXXZSmFow4YvyCV2zidifQa',
        9,
        'Queen',
        'The Big Boys',
      ); // RAY
      const targetMarketId = Keypair.generate().publicKey;
      const addBaseAmount = new BN(10000);
      const addQuoteAmount = new BN(10000);
      const startTime = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7; // start from 7 days later
      const walletTokenAccounts = await this.getWalletTokenAccount(
        this.connection,
        this.payer.publicKey,
      );

      /* do something with start price if needed */
      console.log(
        'pool price',
        new Decimal(addBaseAmount.toString())
          .div(new Decimal(10 ** baseToken.decimals))
          .div(
            new Decimal(addQuoteAmount.toString()).div(
              new Decimal(10 ** quoteToken.decimals),
            ),
          )
          .toString(),
      );

      const txIds = await this.ammCreatePool({
        startTime,
        addBaseAmount,
        addQuoteAmount,
        baseToken,
        quoteToken,
        targetMarketId,
        wallet: this.payer,
        walletTokenAccounts,
      });

      console.log('txIds ', txIds);
    } catch (error) {
      console.log(error);
      throw new Error(error.message);
    }
  }

  async createMarket() {
    try {
      const baseToken = this.getToken(
        'So11111111111111111111111111111111111111112',
        9,
        'WSOL',
        'WSOL',
      ); // USDC
      const quoteToken = this.getToken(
        '5X4fwpumnkwmxZByqnCQdrfqb5BQ9YBHXAjU7taRXVZ2',
        9,
        'Queen',
        'The Big Boys',
      );

      // -------- step 1: make instructions --------
      const createMarketInstruments =
        await MarketV2.makeCreateMarketInstructionSimple({
          connection: this.connection,
          wallet: this.payer.publicKey,
          baseInfo: baseToken,
          quoteInfo: quoteToken,
          lotSize: 1, // default 1
          tickSize: 0.01, // default 0.01
          dexProgramId: new PublicKey(
            'EoTcMgcDRTJVZDMZWBoU6rhYHZfkNTVEAfz3uUJRcYGj',
          ),
          makeTxVersion: this.makeTxVersion,
          lookupTableCache: undefined,
        });

      console.log(createMarketInstruments.address.marketId.toString());

      const marketId = createMarketInstruments.address.marketId;

      const txids = await this.radiumService.buildAndSendTx(
        createMarketInstruments.innerTransactions,
        {
          skipPreflight: true,
        },
      );
      console.log('Market Created');
      console.log('Create Market Transactions :', txids);
      console.log('Market Address :', marketId);

      return marketId;
    } catch (error) {
      console.log(error);
      throw new Error(error.message);
    }
  }
}

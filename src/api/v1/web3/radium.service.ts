/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable prefer-const */
import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import Web3 from 'web3';
// import Common from '@ethereumjs/common'; //NEW ADDITION
import { ConfigService } from '../../../config/config.service';
import { TwofaService } from '../2fa/2fa.service';
import Moralis from 'moralis';
import axios from 'axios';
const { SolNetwork } = require('@moralisweb3/common-sol-utils');
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  VersionedTransaction,
  TransactionMessage,
  SendOptions,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  Liquidity,
  LiquidityPoolKeys,
  jsonInfo2PoolKeys,
  LiquidityPoolJsonInfo,
  TokenAccount,
  Token,
  TokenAmount,
  TOKEN_PROGRAM_ID,
  Percent,
  SPL_ACCOUNT_LAYOUT,
  Market,
  LIQUIDITY_STATE_LAYOUT_V4,
  MARKET_STATE_LAYOUT_V3,
  SPL_MINT_LAYOUT,
  ApiPoolInfoV4,
  InnerSimpleV0Transaction,
  LOOKUP_TABLE_CACHE,
  buildSimpleTransaction,
  DEVNET_PROGRAM_ID,
} from '@raydium-io/raydium-sdk';
import { BN, Wallet } from '@coral-xyz/anchor';
import * as bs58 from 'bs58';
import { any, assert } from 'joi';
import { TokenListProvider, TokenInfo, ENV } from '@solana/spl-token-registry';
import { OpenOrders } from '@project-serum/serum';
import { Metaplex, Model } from '@metaplex-foundation/js';
import {
  AMM_STABLE,
  AMM_V4,
  ApiV3PoolInfoStandardItem,
  Raydium,
  fetchMultipleInfo,
  TxVersion,
} from '@raydium-io/raydium-sdk-v2';
import { InjectModel } from '@nestjs/mongoose';
import { TokenEntity, TokenDocument } from './entity/token.entity';
import { Model as MongooseModel } from 'mongoose';
import { Web3Service } from './web3.service';
import { sha256 } from 'js-sha256';

interface MetadataResponse {
  name: string;
  symbol: string;
  uri: string;
}

type WalletTokenAccounts = Awaited<ReturnType<typeof any>>;
type TestTxInputInfo = {
  outputToken: Token;
  targetPool: string;
  inputTokenAmount: TokenAmount;
  slippage: Percent;
  walletTokenAccounts: WalletTokenAccounts;
  wallet: Keypair;
};
@Injectable()
export class RadiumService {
  private readonly logger = new Logger(RadiumService.name);
  LIQUIDITY_POOLS_JSON_URL =
    'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';
  executeSwap = false;
  useVersionedTransaction = true;
  maxLamports = 100000;
  direction = 'in' as 'in' | 'out';
  liquidityFile = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';
  maxRetries = 20;
  allPoolKeysJson: LiquidityPoolJsonInfo[];
  connection: Connection;
  wallet: Wallet;
  makeTxVersion = TxVersion.V0; // LEGACY
  addLookupTableInfo = LOOKUP_TABLE_CACHE; // only mainnet. other = undefined
  OPENBOOK_PROGRAM_ID = new PublicKey(
    'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',
  );
  txVersion = TxVersion.V0;
  raydium: Raydium | undefined;

  constructor(
    @InjectModel(TokenEntity.name)
    private readonly tokenModel: MongooseModel<TokenDocument>,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => Web3Service))
    private readonly web3Service: Web3Service,
  ) {
    this.connection = new Connection(this.config.RPC_URL, {
      commitment: 'confirmed',
    });
    this.wallet = new Wallet(
      Keypair.fromSecretKey(
        Uint8Array.from(bs58.decode(this.config.WALLET_PRIVATE_KEY)),
      ),
    );
  }

  async createToken(
    address: string,
    lp_pair: string,
    name: string,
    symbol: string,
    decimals: number,
  ): Promise<any> {
    const createdAt = new Date().toISOString();
    await this.tokenModel.create({
      token_name: name,
      token_symbol: symbol,
      token_decimal: decimals,
      token_address: address,
      lp_pair: lp_pair,
    });
  }

  async getOwnerTokenAccounts() {
    const walletTokenAccount = await this.connection.getTokenAccountsByOwner(
      this.wallet.publicKey,
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

  async getSwapTransaction(
    toToken: string,
    // fromToken: string,
    amount: number,
    poolKeys: LiquidityPoolKeys,
    maxLamports: number = 100000,
    useVersionedTransaction = true,
    fixedSide: 'in' | 'out',
  ) {
    const directionIn = poolKeys.quoteMint.toString() == toToken;
    const { amountOut, minAmountOut, amountIn } =
      await this.calcAmountOutithRetry(poolKeys, amount, directionIn);
    const userTokenAccounts = await this.getOwnerTokenAccounts();
    const swapTransaction = await Liquidity.makeSwapInstructionSimple({
      connection: this.connection,
      makeTxVersion: useVersionedTransaction ? 0 : 1,
      poolKeys: {
        ...poolKeys,
      },
      userKeys: {
        tokenAccounts: userTokenAccounts,
        owner: this.wallet.publicKey,
      },
      amountIn: amountIn,
      amountOut: minAmountOut,
      fixedSide: fixedSide,
      config: {
        bypassAssociatedCheck: false,
      },
      computeBudgetConfig: {
        microLamports: maxLamports,
      },
    });

    const recentBlockhashForSwap = await this.connection.getLatestBlockhash();
    const instructions =
      swapTransaction.innerTransactions[0].instructions.filter(Boolean);

    if (useVersionedTransaction) {
      const versionedTransaction = new VersionedTransaction(
        new TransactionMessage({
          payerKey: this.wallet.publicKey,
          recentBlockhash: recentBlockhashForSwap.blockhash,
          instructions: instructions,
        }).compileToV0Message(),
      );

      versionedTransaction.sign([this.wallet.payer]);

      return { tx: versionedTransaction, amountOut, minAmountOut };
    }

    const legacyTransaction = new Transaction({
      blockhash: recentBlockhashForSwap.blockhash,
      lastValidBlockHeight: recentBlockhashForSwap.lastValidBlockHeight,
      feePayer: this.wallet.publicKey,
    });

    legacyTransaction.add(...instructions);

    return { tx: legacyTransaction, amountOut, minAmountOut };
  }

  async sendLegacyTransaction(tx: Transaction, maxRetries?: number) {
    const txid = await this.connection.sendTransaction(
      tx,
      [this.wallet.payer],
      {
        skipPreflight: false,
        maxRetries: maxRetries,
      },
    );

    return txid;
  }

  async sendVersionedTransaction(
    tx: VersionedTransaction,
    maxRetries?: number,
  ) {
    const txid = await this.connection.sendTransaction(tx, {
      skipPreflight: true,
      maxRetries: maxRetries,
    });

    return txid;
  }

  async simulateLegacyTransaction(tx: Transaction) {
    const txid = await this.connection.simulateTransaction(tx, [
      this.wallet.payer,
    ]);

    return txid;
  }

  async simulateVersionedTransaction(tx: VersionedTransaction) {
    const txid = await this.connection.simulateTransaction(tx);

    return txid;
  }

  getTokenAccountByOwnerAndMint(mint: PublicKey) {
    return {
      programId: TOKEN_PROGRAM_ID,
      pubkey: PublicKey.default,
      accountInfo: {
        mint: mint,
        amount: 0,
      },
    } as unknown as TokenAccount;
  }

  async calcAmountOut(
    poolKeys: LiquidityPoolKeys,
    rawAmountIn: number,
    swapInDirection: boolean,
  ) {
    try {
      const poolInfo = await Liquidity.fetchInfo({
        connection: this.connection,
        poolKeys,
      });

      let currencyInMint = poolKeys.baseMint;
      let currencyInDecimals = poolInfo.baseDecimals;
      let currencyOutMint = poolKeys.quoteMint;
      let currencyOutDecimals = poolInfo.quoteDecimals;

      if (!swapInDirection) {
        currencyInMint = poolKeys.quoteMint;
        currencyInDecimals = poolInfo.quoteDecimals;
        currencyOutMint = poolKeys.baseMint;
        currencyOutDecimals = poolInfo.baseDecimals;
      }

      const currencyIn = new Token(
        TOKEN_PROGRAM_ID,
        currencyInMint,
        currencyInDecimals,
      );
      const amountIn = new TokenAmount(currencyIn, rawAmountIn, false);
      const currencyOut = new Token(
        TOKEN_PROGRAM_ID,
        currencyOutMint,
        currencyOutDecimals,
      );
      const slippage = new Percent(5, 100); // 5% slippage

      const {
        amountOut,
        minAmountOut,
        currentPrice,
        executionPrice,
        priceImpact,
        fee,
      } = Liquidity.computeAmountOut({
        poolKeys,
        poolInfo,
        amountIn,
        currencyOut,
        slippage,
      });

      return {
        amountIn,
        amountOut,
        minAmountOut,
        currentPrice,
        executionPrice,
        priceImpact,
        fee,
      };
    } catch (error) {
      console.log('Failed to calculate amount out');
      return;
      // throw new Error('Failed to calculate amount out');
    }
  }

  async formatAmmKeysById(id: string): Promise<ApiPoolInfoV4> {
    const account = await this.connection.getAccountInfo(new PublicKey(id));
    if (account === null) throw Error(' get id info error ');
    const info = LIQUIDITY_STATE_LAYOUT_V4.decode(account.data);

    const marketId = info.marketId;
    const marketAccount = await this.connection.getAccountInfo(marketId);
    if (marketAccount === null) throw Error(' get market info error');
    const marketInfo = MARKET_STATE_LAYOUT_V3.decode(marketAccount.data);

    const lpMint = info.lpMint;
    const lpMintAccount = await this.connection.getAccountInfo(lpMint);
    if (lpMintAccount === null) throw Error(' get lp mint info error');
    const lpMintInfo = SPL_MINT_LAYOUT.decode(lpMintAccount.data);

    return {
      id,
      baseMint: info.baseMint.toString(),
      quoteMint: info.quoteMint.toString(),
      lpMint: info.lpMint.toString(),
      baseDecimals: info.baseDecimal.toNumber(),
      quoteDecimals: info.quoteDecimal.toNumber(),
      lpDecimals: lpMintInfo.decimals,
      version: 4,
      programId: account.owner.toString(),
      authority: Liquidity.getAssociatedAuthority({
        programId: account.owner,
      }).publicKey.toString(),
      openOrders: info.openOrders.toString(),
      targetOrders: info.targetOrders.toString(),
      baseVault: info.baseVault.toString(),
      quoteVault: info.quoteVault.toString(),
      withdrawQueue: info.withdrawQueue.toString(),
      lpVault: info.lpVault.toString(),
      marketVersion: 3,
      marketProgramId: info.marketProgramId.toString(),
      marketId: info.marketId.toString(),
      marketAuthority: Market.getAssociatedAuthority({
        programId: info.marketProgramId,
        marketId: info.marketId,
      }).publicKey.toString(),
      marketBaseVault: marketInfo.baseVault.toString(),
      marketQuoteVault: marketInfo.quoteVault.toString(),
      marketBids: marketInfo.bids.toString(),
      marketAsks: marketInfo.asks.toString(),
      marketEventQueue: marketInfo.eventQueue.toString(),
      lookupTableAccount: PublicKey.default.toString(),
    };
  }

  async getLiquidity(poolKeys, tokenMintAddress) {
    // Fetch the account information for both the base and quote vaults
    const baseVaultAccount = await this.connection.getAccountInfo(
      new PublicKey(poolKeys.baseVault),
    );
    const quoteVaultAccount = await this.connection.getAccountInfo(
      new PublicKey(poolKeys.quoteVault),
    );

    if (baseVaultAccount === null || quoteVaultAccount === null) {
      throw Error('Error fetching vault account information');
    }

    // Decode the account data using the appropriate layout to get the balance
    const baseBalance = baseVaultAccount.lamports / LAMPORTS_PER_SOL; // Assuming direct SOL balance for simplicity
    const quoteBalance = quoteVaultAccount.lamports / LAMPORTS_PER_SOL; // For SPL tokens, you might need additional decoding based on the SPL token layout
    const basepriceinsol = quoteBalance / baseBalance;
    const basepriceinusd = basepriceinsol * 143;
    const valueUSDbaseBalance = baseBalance * basepriceinusd;
    const valueUSDquoteBalace = quoteBalance * 143;
    const liquidityAvailable = valueUSDbaseBalance + valueUSDquoteBalace;

    return {
      baseBalance,
      quoteBalance,
      liquidityAvailable,
    };
  }

  async swap(
    tokenMintAddress: string,
    solanaAddress: string,
    tokenAAmount: number,
    poolKeys: any,
    direction: typeof this.direction,
  ) {
    try {
      const transactionDetails = await this.getSwapTransaction(
        solanaAddress,
        tokenAAmount,
        poolKeys,
        this.maxLamports,
        this.useVersionedTransaction,
        direction,
      );

      const tx = transactionDetails.tx;
      const serializedTx = tx.serialize();
      const transactionHash = sha256(serializedTx);
      console.log('TX Hash: ' + transactionHash);

      if (this.executeSwap) {
        const txid = this.useVersionedTransaction
          ? await this.sendVersionedTransaction(
              tx as VersionedTransaction,
              this.maxRetries,
            )
          : await this.sendLegacyTransaction(
              tx as Transaction,
              this.maxRetries,
            );

        console.log(`https://solscan.io/tx/${txid}`);
      } else {
        const simRes = this.useVersionedTransaction
          ? await this.simulateVersionedTransaction(tx as VersionedTransaction)
          : await this.simulateLegacyTransaction(tx as Transaction);

        console.log(simRes);
      }

      return {
        tx: transactionDetails.tx as VersionedTransaction,
        amountOut: transactionDetails.amountOut,
        minAmountOut: transactionDetails.minAmountOut,
      };
    } catch (error) {
      console.log(error);
      throw new Error(error);
    }
  }

  convertLamportsToSol(lamports) {
    return lamports / 1_000_000_000; // 1 SOL = 1,000,000,000 lamports
  }

  convertSolToLamports(sol) {
    return sol * 1_000_000_000; // 1 SOL = 1,000,000,000 lamports
  }

  async swapOnlyAmm(input: TestTxInputInfo | any) {
    // -------- pre-action: get pool info --------
    try {
      const targetPoolInfo = await this.formatAmmKeysById(input.targetPool);
      targetPoolInfo
        ? console.log('found the target pool')
        : console.log('cannot find the target pool');
      const poolKeys = jsonInfo2PoolKeys(targetPoolInfo) as LiquidityPoolKeys;

      // -------- step 1: coumpute amount out --------
      const { amountOut, minAmountOut } = Liquidity.computeAmountOut({
        poolKeys: poolKeys,
        poolInfo: await Liquidity.fetchInfo({
          connection: this.connection,
          poolKeys,
        }),
        amountIn: input.inputTokenAmount,
        currencyOut: input.outputToken,
        slippage: input.slippage,
      });

      // -------- step 2: create instructions by SDK function --------
      const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
        connection: this.connection,
        poolKeys,
        userKeys: {
          tokenAccounts: input.walletTokenAccounts,
          owner: input.wallet.publicKey,
        },
        amountIn: input.inputTokenAmount,
        amountOut: minAmountOut,
        fixedSide: 'in',
        makeTxVersion: this.makeTxVersion,
      });

      // return { txids: await this.buildAndSendTx(innerTransactions) };
      return;
    } catch (error) {
      console.log(error);
    }
  }

  async sendTx(
    connection: Connection,
    txs: (VersionedTransaction | Transaction)[],
    options?: SendOptions,
  ): Promise<string[]> {
    const txids: string[] = [];
    for (const iTx of txs) {
      if (iTx instanceof VersionedTransaction) {
        iTx.sign([this.wallet.payer]);
        txids.push(await connection.sendTransaction(iTx, options));
      } else {
        txids.push(
          await connection.sendTransaction(iTx, [this.wallet.payer], options),
        );
      }
    }
    return txids;
  }

  async buildAndSendTx(
    innerSimpleV0Transaction: InnerSimpleV0Transaction[],
    options?: SendOptions,
  ) {
    try {
      const willSendTx = await buildSimpleTransaction({
        connection: this.connection,
        makeTxVersion: this.makeTxVersion,
        payer: this.wallet.publicKey,
        innerTransactions: innerSimpleV0Transaction,
        addLookupTableInfo: this.addLookupTableInfo,
      });

      return await this.sendTx(this.connection, willSendTx, options);
    } catch (error) {
      console.log(error);
      throw new Error(error.message);
    }
  }

  async getTokenDetailsFromSPLRegistry(token: string) {
    // Fetch token metadata from the SPL Token Registry
    const tokenListProvider = new TokenListProvider();
    const tokens = await tokenListProvider.resolve();
    const tokenList = tokens.filterByChainId(ENV.MainnetBeta).getList();

    // Create a map of token addresses to token info
    const tokenMap = tokenList.reduce((map, item) => {
      map.set(item.address, item);
      return map;
    }, new Map<string, TokenInfo>());

    // Get token info from the SPL Token Registry
    const tokenInfo = tokenMap.get(token);
    if (tokenInfo) {
      console.log('Token Details');
      console.log('Token Address: ' + tokenInfo.address);
      console.log('Token ChainId: ' + tokenInfo.chainId);
      console.log('Token Symbol: ' + tokenInfo.symbol);
      console.log('Token Name: ' + tokenInfo.name);
      console.log('Token Decimals: ' + tokenInfo.decimals);

      return {
        chainId: tokenInfo.chainId,
        symbol: tokenInfo.symbol,
        name: tokenInfo.name,
        decimals: tokenInfo.decimals,
      };
    } else {
      console.log('Token Info not found in SPL Token Registry');
    }
  }

  async getTokenMetadataFromMetaplex(token: string) {
    try {
      let mint: any = await this.connection.getParsedAccountInfo(
        new PublicKey(token),
      );
      const metaplex = Metaplex.make(this.connection);
      const mintAddress = new PublicKey(token);
      const metadataAccount = metaplex
        .nfts()
        .pdas()
        .metadata({ mint: mintAddress });

      const metadataAccountInfo = await this.connection.getAccountInfo(
        metadataAccount,
      );

      if (metadataAccountInfo) {
        const token = await metaplex
          .nfts()
          .findByMint({ mintAddress: mintAddress });

        console.log('Token Details');
        console.log('Token Address: ' + token.address);
        console.log('Token Symbol: ' + token.symbol);
        console.log('Token Name: ' + token.name);
        console.log('Token Decimals: ' + mint.value.data.parsed.info.decimals);

        return {
          tokenName: token.name,
          tokenSymbol: token.symbol,
          decimals: mint.value.data.parsed.info.decimals,
        };
      }
    } catch (error) {
      throw new Error(error);
    }
  }

  async getTokenAccounts(owner: PublicKey) {
    const tokenResp = await this.connection.getTokenAccountsByOwner(owner, {
      programId: TOKEN_PROGRAM_ID,
    });

    const accounts: TokenAccount[] = [];
    for (const { pubkey, account } of tokenResp.value) {
      accounts.push({
        programId: TOKEN_PROGRAM_ID,
        pubkey,
        accountInfo: SPL_ACCOUNT_LAYOUT.decode(account.data),
      });
    }

    return accounts;
  }

  async parsePoolInfo(token: string, poolId: string) {
    try {
      const owner = new PublicKey(token);
      const tokenAccounts = await this.getTokenAccounts(owner);

      // Example to get pool info
      const info = await this.connection.getAccountInfo(new PublicKey(poolId));
      if (!info) return;

      const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(info.data);
      const openOrders = await OpenOrders.load(
        this.connection,
        poolState.openOrders,
        this.OPENBOOK_PROGRAM_ID, // OPENBOOK_PROGRAM_ID(marketProgramId) of each pool can get from api: https://api.raydium.io/v2/sdk/liquidity/mainnet.json
      );

      const baseDecimal = 10 ** poolState.baseDecimal.toNumber(); // e.g. 10 ^ 6
      const quoteDecimal = 10 ** poolState.quoteDecimal.toNumber();

      const baseTokenAmount = await this.connection.getTokenAccountBalance(
        poolState.baseVault,
      );
      const quoteTokenAmount = await this.connection.getTokenAccountBalance(
        poolState.quoteVault,
      );

      const basePnl = poolState.baseNeedTakePnl.toNumber() / baseDecimal;
      const quotePnl = poolState.quoteNeedTakePnl.toNumber() / quoteDecimal;

      const openOrdersBaseTokenTotal =
        openOrders.baseTokenTotal.toNumber() / baseDecimal;
      const openOrdersQuoteTokenTotal =
        openOrders.quoteTokenTotal.toNumber() / quoteDecimal;

      const base =
        (baseTokenAmount.value?.uiAmount || 0) +
        openOrdersBaseTokenTotal -
        basePnl;
      const quote =
        (quoteTokenAmount.value?.uiAmount || 0) +
        openOrdersQuoteTokenTotal -
        quotePnl;

      const denominator = new BN(10).pow(poolState.baseDecimal);

      const addedLpAccount = tokenAccounts.find((a) =>
        a.accountInfo.mint.equals(poolState.lpMint),
      );

      const adjustedBaseTokenAmount = base;
      const adjustedQuoteTokenAmount = quote;

      // Calculate the price of the base token in terms of the quote token
      const baseTokenPrice = adjustedBaseTokenAmount / adjustedQuoteTokenAmount;

      const lpWorhtInSol =
        (baseTokenAmount.value.uiAmount / quoteTokenAmount.value.uiAmount) *
        Number(poolState.lpReserve.div(denominator).toString());

      console.log(
        'Price of the base token in terms of the quote token: ' +
          baseTokenPrice.toFixed(6),
      );

      console.log('lpWorhtInSol ', lpWorhtInSol * 143);

      console.log(
        '\npool total base ' + base,
        '\npool total quote ' + quote,
        '\nbase vault balance ' + baseTokenAmount.value.uiAmount,
        '\nquote vault balance ' + quoteTokenAmount.value.uiAmount,
        '\nbase tokens in openorders ' + openOrdersBaseTokenTotal,
        '\nquote tokens in openorders ' + openOrdersQuoteTokenTotal,
        '\ntotal lp ' + poolState.lpReserve.div(denominator).toString(),
        '\naddedLpAmount ' +
          (addedLpAccount?.accountInfo.amount.toNumber() || 0) / baseDecimal,
      );

      // return baseTokenPrice.toFixed(6);
      return;
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async getTokenBalance(vault: PublicKey, decimals: number): Promise<number> {
    const balance = await this.connection.getTokenAccountBalance(vault);
    return parseFloat(balance.value.amount) / Math.pow(10, decimals); // Adjust the balance for the token's decimals
  }

  calculateSolPercentage(solAmount, solValueInUnits) {
    return (solAmount * solValueInUnits).toFixed(6);
  }

  async getTheTokenPrice(
    tokenMintAddress: string,
    solanaAddress: string,
    lpPairAddress: string,
    buyAmount: number,
  ) {
    try {
      const targetPoolInfo = await this.formatAmmKeysById(lpPairAddress);
      // console.log(targetPoolInfo);
      // console.log('-------------------------');
      const poolKeys = jsonInfo2PoolKeys(targetPoolInfo) as LiquidityPoolKeys;
      const directionIn = poolKeys.quoteMint.toString() == tokenMintAddress;

      // Get the liquidity information
      const { liquidityAvailable } = await this.getLiquidity(
        poolKeys,
        tokenMintAddress,
      );

      // console.log(`Loaded pool keys`);
      const { amountOut, minAmountOut } = await this.calcAmountOutithRetry(
        poolKeys,
        buyAmount,
        directionIn,
      );
      return {
        amountOut: amountOut.toFixed(),
        minAmountOut: minAmountOut.toFixed(),
        liquidityAvailable,
      };
    } catch (error) {
      console.log('Some Error on calculateAmountOut in getTheTokenPrice');
      throw new Error('Some Error on calculateAmountOut in getTheTokenPrice');
    }
  }

  async getTheSolPrice(
    tokenMintAddress: string,
    solanaAddress: string,
    lpPairAddress: string,
    buyAmount: number,
  ) {
    try {
      const targetPoolInfo = await this.formatAmmKeysById(lpPairAddress);
      // console.log(targetPoolInfo);
      // console.log('-------------------------');
      const poolKeys = jsonInfo2PoolKeys(targetPoolInfo) as LiquidityPoolKeys;
      const directionIn = poolKeys.quoteMint.toString() == solanaAddress;
      // console.log(`Loaded pool keys`);
      const { amountOut, minAmountOut } = await this.calcAmountOutithRetry(
        poolKeys,
        buyAmount,
        directionIn,
      );
      return {
        amountOut: amountOut.toFixed(),
        minAmountOut: minAmountOut.toFixed(),
      };
    } catch (error) {
      throw new Error(error.message);
    }
  }

  /**
   *
   * @param tokenMintAddress string
   * @param solanaAddress string
   * @param lpPairAddress string
   * @param buyAmount number
   * @returns
   */
  async doSandwich(
    tokenMintAddress: string,
    solanaAddress: string,
    lpPairAddress: string,
    buyAmount: number,
  ) {
    try {
      console.log('-------------------------');
      console.log('Starting swap');
      console.log('My Public Key: ', this.wallet.publicKey.toBase58());
      console.log('tokenMintAddress ', tokenMintAddress);

      const tokenBasePrice = await this.web3Service.getTokenPriceBirdsEye(
        tokenMintAddress,
      );

      const tokenAData = await this.getTokenMetadataFromMetaplex(
        tokenMintAddress,
      );
      console.log('-------------------------');
      const tokenBData = await this.getTokenMetadataFromMetaplex(solanaAddress);
      console.log('-------------------------');
      console.log('Solane Price ', tokenBasePrice.solPrice.value);
      console.log(
        `${tokenAData.tokenName} Price `,
        tokenBasePrice.tokenPrice.value,
      );
      const baseTokenPriceInUsd =
        tokenBasePrice.solPrice.value / tokenBasePrice.tokenPrice.value;
      const toSwapAmount = this.calculateSolPercentage(
        buyAmount,
        baseTokenPriceInUsd,
      );
      console.log('1 SOL = ', baseTokenPriceInUsd, ' ', tokenAData.tokenSymbol);
      console.log(
        `${buyAmount} SOL = ${toSwapAmount} ${tokenAData.tokenSymbol}`,
      );

      console.log('-------------------------');
      console.log('Pool Information: ');
      await this.parsePoolInfo(tokenMintAddress, lpPairAddress);
      console.log('-------------------------');

      const targetPoolInfo = await this.formatAmmKeysById(lpPairAddress);
      console.log(targetPoolInfo);
      console.log('-------------------------');
      const poolKeys = jsonInfo2PoolKeys(targetPoolInfo) as LiquidityPoolKeys;
      console.log(`Loaded pool keys`);

      if (!poolKeys) {
        console.log('Pool info not found');
        throw new Error('Pool info not found');
      } else {
        console.log('Found pool info');
      }

      await this.createToken(
        tokenMintAddress,
        lpPairAddress,
        tokenAData.tokenName,
        tokenAData.tokenSymbol,
        tokenAData.decimals,
      );

      const { amountOut, minAmountOut, tx } = await this.swap(
        solanaAddress,
        tokenMintAddress,
        buyAmount,
        poolKeys,
        'in',
      );
      console.log(
        `Swapping ${buyAmount} |  of ${tokenMintAddress} of amount ${amountOut.toFixed()} || ${minAmountOut.toFixed()}  for ${solanaAddress}`,
      );

      // const txDetails = await this.swap(
      //   tokenMintAddress,
      //   solanaAddress,
      //   Number(minAmountOut.toFixed()),
      //   poolKeys,
      //   'in',
      // );
      console.log(
        '================================================================',
      );
      return;
      // return { tx1: tx, tx2: txDetails.tx };
    } catch (error) {
      console.log(error);
      throw new Error(error.message);
    }
  }

  /**
   *
   * @param tokenMintAddress string
   * @param solanaAddress string
   * @param lpPairAddress string
   * @param buyAmount number
   * @returns Maximum tokens we bought, minimum amount we will recieve and jito tx
   */
  async buyTheTokenFromRadium(
    tokenMintAddress: string,
    solanaAddress: string,
    lpPairAddress: string,
    buyAmount: number,
  ) {
    try {
      const targetPoolInfo = await this.formatAmmKeysById(lpPairAddress);
      const poolKeys = jsonInfo2PoolKeys(targetPoolInfo) as LiquidityPoolKeys;

      if (!poolKeys) {
        console.log('Pool info not found');
        throw new Error('Pool info not found');
      }

      const { amountOut, minAmountOut, tx } = await this.swap(
        solanaAddress,
        tokenMintAddress,
        buyAmount,
        poolKeys,
        'in',
      );
      console.log(
        `Swapping ${buyAmount} |  of ${tokenMintAddress} of amount ${amountOut.toFixed()} || ${minAmountOut.toFixed()}  for ${solanaAddress}`,
      );
      // const jitoId = await this.web3Service.sendBundleVTrx(tx);
      return {
        boughtTokens: minAmountOut.toFixed(),
        mightGotTokens: amountOut.toFixed(),
        jitoId: '',
      };
    } catch (error) {
      console.log(error);
      throw new Error(error.message);
    }
  }

  /**
   *
   * @param tokenMintAddress string
   * @param pair string
   * @param amount number
   * @param attempts number of attempts
   * @returns Maximum tokens we bought, minimum amount we will recieve and jito tx
   */
  async buyTokenWithRetry(
    tokenMintAddress: string,
    pair: string,
    amount: number,
    attempts: number = 3,
  ): Promise<any> {
    try {
      const { boughtTokens, mightGotTokens, jitoId } =
        await this.buyTheTokenFromRadium(
          tokenMintAddress,
          'So11111111111111111111111111111111111111112',
          pair,
          amount,
        );
      return { boughtTokens: boughtTokens.toString(), mightGotTokens, jitoId };
    } catch (error) {
      if (attempts > 0) {
        console.log(
          `Attempt failed, ${attempts} retries left. Error: ${error.message}`,
        );
        return this.buyTokenWithRetry(tokenMintAddress, pair, attempts - 1);
      } else {
        throw new Error(
          'Failed to buy token after several attempts: ' + error.message,
        );
      }
    }
  }

  async sellTheTokenFromRadium(
    tokenMintAddress: string,
    solanaAddress: string,
    lpPairAddress: string,
    tokenAAmount: number,
  ) {
    try {
      console.log('Going To Sell The Token', tokenAAmount);

      const targetPoolInfo = await this.formatAmmKeysById(lpPairAddress);
      console.log(targetPoolInfo);
      const poolKeys = jsonInfo2PoolKeys(targetPoolInfo) as LiquidityPoolKeys;

      if (!poolKeys) {
        console.log('Pool info not found');
        throw new Error('Pool info not found');
      }

      const { amountOut, minAmountOut, tx } = await this.swap(
        tokenMintAddress,
        solanaAddress,
        Number(tokenAAmount.toFixed()),
        poolKeys,
        'in',
      );
      console.log(
        `Swapping ${tokenAAmount} |  of ${tokenMintAddress} of amount ${amountOut.toFixed()} || ${minAmountOut.toFixed()}  for ${solanaAddress}`,
      );
      // const jitoId = await this.web3Service.sendBundleVTrx(tx);
      return {
        boughtTokens: minAmountOut.toFixed(),
        mightGotTokens: amountOut.toFixed(),
        jitoId: '',
      };
    } catch (error) {
      console.log(error);
      throw new Error(error.message);
    }
  }

  async sellTokenWithRetry(
    instructions: any,
    attempts: number = 3,
  ): Promise<any> {
    try {
      const { mightGotTokens, boughtTokens, jitoId } =
        await this.sellTheTokenFromRadium(
          instructions.tokenMintAddress,
          'So11111111111111111111111111111111111111112',
          instructions.lpPairAddress, // Assuming pair has a toBase58 method
          Number(instructions.minGet),
        );
      return { mightGotTokens, boughtTokens, jitoId };
    } catch (error) {
      if (attempts > 0) {
        console.log(
          `Attempt to sell failed, ${attempts} retries left. Error: ${error.message}`,
        );
        return this.sellTokenWithRetry(instructions, attempts - 1);
      } else {
        throw new Error(
          'Failed to sell token after several attempts: ' + error.message,
        );
      }
    }
  }

  async calcAmountOutithRetry(
    poolKeys: any,
    rawAmountIn: any,
    swapInDirection: any,
    attempts: number = 3,
  ) {
    try {
      const { amountOut, minAmountOut, amountIn } = await this.calcAmountOut(
        poolKeys,
        rawAmountIn,
        swapInDirection,
      );

      return { amountOut, minAmountOut, amountIn };
    } catch (error) {
      if (attempts > 0) {
        console.log(
          `Attempt to calculate amount failed, ${attempts} retries left. Error: ${error.message}`,
        );
        return this.calcAmountOutithRetry(
          poolKeys,
          rawAmountIn,
          swapInDirection,
          attempts - 1,
        );
      } else {
        throw new Error(
          'Failed to sell token after several attempts: ' + error.message,
        );
      }
    }
  }
}

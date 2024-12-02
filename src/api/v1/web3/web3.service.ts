import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConfigService } from '../../../config/config.service';
import { TwofaService } from '../2fa/2fa.service';
import Moralis from 'moralis';
import axios from 'axios';
const { SolNetwork } = require('@moralisweb3/common-sol-utils');
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import {
  LiquidityPoolJsonInfo,
  Token,
  TokenAmount,
  Percent,
  LOOKUP_TABLE_CACHE,
} from '@raydium-io/raydium-sdk';
import { any } from 'joi';
import { InjectModel } from '@nestjs/mongoose';
import { TokenEntity, TokenDocument } from './entity/token.entity';
import { Model as MongooseModel } from 'mongoose';
import {
  //SimulatedTransactionAccountInfo,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Blockhash,
  SYSVAR_RENT_PUBKEY,
  AddressLookupTableAccount,
  AccountInfo,
  ComputeBudgetProgram,
  Transaction,
  sendAndConfirmTransaction,
  MessageV0,
} from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import {
  Wallet,
  AnchorProvider,
  setProvider,
  Program,
  Idl,
} from '@coral-xyz/anchor';
import * as bs58 from 'bs58';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import * as BN from 'bn.js';
import { geyserClient as jitoGeyserClient } from 'jito-ts';
import {
  SearcherClient,
  searcherClient as jitoSearcherClient,
} from 'jito-ts/dist/sdk/block-engine/searcher.js';
import {
  Bundle,
  Bundle as JitoBundle,
} from 'jito-ts/dist/sdk/block-engine/types.js';
import { JitoService } from './jito.service';
import { PumpFunService } from './pumpfun.service';
import { RadiumService } from './radium.service';
import { amount } from '@metaplex-foundation/js';
import { isError } from 'jito-ts/dist/sdk/block-engine/utils';
import { METADATA_PROGRAM_ID } from '@raydium-io/raydium-sdk-v2';
import { Metadata } from '@metaplex-foundation/mpl-token-metadata';
const IDL = JSON.parse(
  require('fs').readFileSync('src/api/v1/web3/abis/IDL.json', 'utf8'),
);

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
export class Web3Service {
  private readonly logger = new Logger(Web3Service.name);
  private readonly tokenLiquidityLogsPath = './logs/token_liquidity_logs.json';
  private readonly PUMP_PROGRAM = new PublicKey(
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  );
  private readonly connection;
  private readonly wallet;
  private readonly bumperWallet;
  private readonly volumeWallet;
  private readonly provider;
  private readonly program;
  buyArray = []; // Store indices of wallets that have bought

  private readonly keypairsDir = './bumper_keypairs';
  private readonly volKeypairsDir = './volume_keypairs';
  private readonly mainWalletDir = './main_wallets';
  private readonly GEYSER_URL = 'mainnet.rpc.jito.wtf';
  private readonly GEYSER_ACCESS_TOKEN = '00000000-0000-0000-0000-000000000000';
  private readonly geyserClient;

  private readonly global = new PublicKey(
    '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
  );
  private readonly tipAcct = new PublicKey(
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  );
  private readonly eventAuthority = new PublicKey(
    'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
  );
  private readonly feeRecipient = new PublicKey(
    'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
  );

  lookupTables: Map<string, AddressLookupTableAccount> | any;
  addressesForLookupTable: Map<string, Set<string>> | any;
  lookupTablesForAddress: Map<string, Set<string>> | any;
  constructor(
    private readonly config: ConfigService,
    @Inject(forwardRef(() => PumpFunService))
    private readonly pumpFunService: PumpFunService,
    private readonly jitoService: JitoService,
    private readonly radiumService: RadiumService,
  ) {
    this.lookupTables = new Map();
    this.lookupTablesForAddress = new Map();
    this.addressesForLookupTable = new Map();

    this.wallet = this.wallet = new Wallet(
      Keypair.fromSecretKey(
        Uint8Array.from(bs58.decode(this.config.WALLET_PRIVATE_KEY)),
      ),
    );
    this.bumperWallet = Keypair.fromSecretKey(
      bs58.decode(this.config.BUMPER_WALLET_PRIVATE_KEY),
    );

    this.volumeWallet = Keypair.fromSecretKey(
      bs58.decode(this.config.VOLUME_WALLET_PRIVATE_KEY),
    );

    this.connection = new Connection(this.config.RPC_URL, {
      // RPC URL HERE
      commitment: 'confirmed',
    });
    this.provider = new AnchorProvider(this.connection, this.wallet as any, {});
    setProvider(this.provider);

    this.program = new Program(IDL as Idl, this.PUMP_PROGRAM);

    this.geyserClient = jitoGeyserClient(
      this.GEYSER_URL,
      this.GEYSER_ACCESS_TOKEN,
      {
        'grpc.keepalive_timeout_ms': 4000,
      },
    );

    if (!fs.existsSync(this.keypairsDir)) {
      fs.mkdirSync(this.keypairsDir, { recursive: true });
    }

    if (!fs.existsSync(this.volKeypairsDir)) {
      fs.mkdirSync(this.volKeypairsDir, { recursive: true });
    }

    if (!fs.existsSync(this.mainWalletDir)) {
      fs.mkdirSync(this.mainWalletDir, { recursive: true });
    }

    this.getLookupTable(
      // custom lookup tables
      new PublicKey('Gr8rXuDwE2Vd2F5tifkPyMaUR67636YgrZEjkJf9RR9V'),
    );
  }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async getTokenStats(tokenAddress: string) {
    const response = await Moralis.SolApi.token.getTokenPrice({
      network: 'mainnet',
      address: tokenAddress,
    });

    console.log(response.raw);
    return response.raw;
  }

  async getTokenMetadataFromMoralis(
    tokenAddress: string,
  ): Promise<MetadataResponse> {
    const options = {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'X-API-Key': this.config.MORALIS_PUB_KEY,
      },
    };

    try {
      const response: Response = await fetch(
        `https://solana-gateway.moralis.io/token/mainnet/${tokenAddress}/metadata`,
        options,
      );
      if (!response.ok) {
        throw new Error(
          `Error fetching token metadata: ${response.statusText}`,
        );
      }
      const data: MetadataResponse = await response.json();
      console.log('DATA ', data);
      return data;
    } catch (error) {
      console.log(error);
      throw new Error(`Error fetching token metadata: ${error.message}`);
    }
  }

  async getTokenPriceInSOL(tokenMintAddress) {
    try {
      // Fetch token price in USD from a reliable API
      const tokenPriceResponse = await axios.get(
        `https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${tokenMintAddress}&vs_currencies=usd`,
      );
      const tokenPriceInUSD =
        tokenPriceResponse.data[tokenMintAddress.toLowerCase()].usd;

      // Fetch SOL price in USD from a reliable API
      const solPriceResponse = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      );
      const solPriceInUSD = solPriceResponse.data.solana.usd;

      // Calculate the token price in SOL
      const tokenPriceInSOL = tokenPriceInUSD / solPriceInUSD;

      return tokenPriceInSOL;
    } catch (error) {
      console.log('Error fetching token price:', error);
      return null;
    }
  }

  async getSolTokenBalance(tokenAddress: string) {
    try {
      const address = '6HFbaGCU1wuUQ2kHAMU9veqDTdzMmuzJXVE3wscUWEQM';
      const network = SolNetwork.MAINNET;
      const response = await Moralis.SolApi.token.getTokenPrice({
        address: tokenAddress,
        network,
      });
      console.log(response.toJSON());
    } catch (error) {
      console.log('Error fetching token');
      return 'Error fetching token';
    }
  }

  async getTokenPriceBirdsEye(token: string) {
    const options = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-API-KEY': 'a7537812032a44cb81cf0145a65e6c01',
      },
      body: JSON.stringify({
        list_address: `So11111111111111111111111111111111111111112,${token}`,
      }),
    };

    try {
      const response = await fetch(
        'https://public-api.birdeye.so/defi/multi_price?include_liquidity=false',
        options,
      );
      const data = await response.json();

      // Extract the price data for SOL and the specified token
      const solPrice = data.data['So11111111111111111111111111111111111111112'];
      const tokenPrice = data.data[token];

      // Return the extracted prices
      return {
        solPrice,
        tokenPrice,
      };
    } catch (err) {
      console.error(err);
      throw new Error('Failed to fetch token prices');
    }
  }

  isValidSolanaAddress(address: PublicKey) {
    try {
      // This will throw an error if the address is not valid
      new PublicKey(address);
      return true; // The address is valid if no error is thrown
    } catch (e) {
      return false; // The address is invalid
    }
  }

  async executeSwaps(
    BuyAmt: number,
    keypair: Keypair,
    ca: PublicKey,
    bCurve: PublicKey,
    abCurve: PublicKey,
    jitoTip: number,
    block: string | Blockhash,
  ) {
    try {
      const BundledTxns: VersionedTransaction[] = [];

      const SolIxs = SystemProgram.transfer({
        // Enough to send unique txn
        fromPubkey: this.bumperWallet.publicKey,
        toPubkey: keypair.publicKey,
        lamports: BuyAmt + 0.0025 * LAMPORTS_PER_SOL,
      });

      const message = new TransactionMessage({
        payerKey: this.bumperWallet.publicKey,
        recentBlockhash: block,
        instructions: [SolIxs],
      }).compileToV0Message();

      const sendsol = new VersionedTransaction(message);

      sendsol.sign([this.bumperWallet]);

      if (sendsol.serialize().length > 1232) {
        throw new Error('Transaction too Big');
      }

      /*
      // Simulate the transaction
      const simulationResult = await this.connection.simulateTransaction(
        sendsol,
        {
          commitment: 'processed',
        },
      );

      if (simulationResult.value.err) {
        console.log('Simulation error:', simulationResult.value.err);
      } else {
        console.log('Simulation success. Logs:');
        simulationResult.value.logs?.forEach((log) => console.log(log));
      }
      */

      BundledTxns.push(sendsol);

      const TokenATA = await getAssociatedTokenAddress(ca, keypair.publicKey);

      const createTokenBaseAta =
        createAssociatedTokenAccountIdempotentInstruction(
          this.bumperWallet.publicKey,
          TokenATA,
          keypair.publicKey,
          ca,
        );

      const { buyIxs } = await this.makeSwap(
        Math.floor(BuyAmt * 0.95),
        TokenATA,
        keypair,
        bCurve,
        abCurve,
        ca,
      );

      const tipIxn = SystemProgram.transfer({
        fromPubkey: this.bumperWallet.publicKey,
        toPubkey: this.tipAcct,
        lamports: BigInt(jitoTip),
      });

      const swapIxs: TransactionInstruction[] = [];

      swapIxs.push(createTokenBaseAta, ...buyIxs, tipIxn);

      const addressesMain: PublicKey[] = [];
      swapIxs.forEach((ixn) => {
        ixn.keys.forEach((key) => {
          addressesMain.push(key.pubkey);
        });
      });

      const lookupTablesMain =
        this.computeIdealLookupTablesForAddresses(addressesMain);

      const message1 = new TransactionMessage({
        payerKey: keypair.publicKey,
        recentBlockhash: block,
        instructions: swapIxs,
      }).compileToV0Message(lookupTablesMain);

      const swaptx = new VersionedTransaction(message1);

      swaptx.sign([this.bumperWallet, keypair]);

      if (swaptx.serialize().length > 1232) {
        throw new Error('Transaction too Big');
      }

      BundledTxns.push(swaptx);

      // Simulate the transaction
      const simulationResult = await this.connection.simulateTransaction(
        sendsol,
        {
          commitment: 'processed',
        },
      );

      if (simulationResult.value.err) {
        console.log('Simulation error:', simulationResult.value.err);
      } else {
        console.log('Simulation success. Logs:');
        simulationResult.value.logs?.forEach((log) => console.log(log));
        // await this.sendBundleVTrxs(BundledTxns);
        await this.saveTransactionDetails(
          keypair.publicKey.toString(),
          'jitoTxId',
          (BuyAmt + 0.0025) / LAMPORTS_PER_SOL,
          'volume',
        );
      }
    } catch (error) {
      console.log(error);
    }
  }

  serializeBuyLayout(amount, maxSolCost) {
    const buffer = Buffer.alloc(16); // Two Int64 values
    buffer.writeBigInt64LE(BigInt(amount), 0);
    buffer.writeBigInt64LE(BigInt(maxSolCost), 8);
    return buffer;
  }

  deserializeBuyLayout(buffer) {
    return {
      amount: buffer.readBigInt64LE(0),
      maxSolCost: buffer.readBigInt64LE(8),
    };
  }

  // SellLayout functions
  serializeSellLayout(amount, minSolOutput) {
    const buffer = Buffer.alloc(16); // Two Int64 values
    buffer.writeBigInt64LE(BigInt(amount), 0);
    buffer.writeBigInt64LE(BigInt(minSolOutput), 8);
    return buffer;
  }

  deserializeSellLayout(buffer) {
    return {
      amount: buffer.readBigInt64LE(0),
      minSolOutput: buffer.readBigInt64LE(8),
    };
  }

  // BondingCurveLayout functions
  serializeBondingCurveLayout(
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
  ) {
    const buffer = Buffer.alloc(41); // Five Int64 values and one flag
    buffer.writeBigInt64LE(BigInt(virtualTokenReserves), 0);
    buffer.writeBigInt64LE(BigInt(virtualSolReserves), 8);
    buffer.writeBigInt64LE(BigInt(realTokenReserves), 16);
    buffer.writeBigInt64LE(BigInt(realSolReserves), 24);
    buffer.writeBigInt64LE(BigInt(tokenTotalSupply), 32);
    buffer.writeInt8(complete ? 1 : 0, 40);
    return buffer;
  }

  deserializeBondingCurveLayout(buffer) {
    return {
      virtualTokenReserves: buffer.readBigInt64LE(0),
      virtualSolReserves: buffer.readBigInt64LE(8),
      realTokenReserves: buffer.readBigInt64LE(16),
      realSolReserves: buffer.readBigInt64LE(24),
      tokenTotalSupply: buffer.readBigInt64LE(32),
      complete: buffer.readInt8(40) !== 0,
    };
  }

  // GlobalLayout functions
  deserializeGlobalLayout(buffer) {
    const initialized = buffer.readInt8(0) !== 0;
    const authority = buffer.slice(1, 33);
    const feeRecipient = buffer.slice(33, 65);
    const initialVirtualTokenReserves = buffer.readBigInt64LE(65);
    const initialVirtualSolReserves = buffer.readBigInt64LE(73);
    const initialRealTokenReserves = buffer.readBigInt64LE(81);
    const tokenTotalSupply = buffer.readBigInt64LE(89);
    const feeBasisPoints = buffer.readBigInt64LE(97);
    return {
      initialized,
      authority,
      feeRecipient,
      initialVirtualTokenReserves,
      initialVirtualSolReserves,
      initialRealTokenReserves,
      tokenTotalSupply,
      feeBasisPoints,
    };
  }

  async GPA(bonding_curve: PublicKey) {
    const curve = new PublicKey(bonding_curve);
    const data = await this.connection.getAccountInfo(curve, {
      commitment: 'confirmed',
    });

    if (data === null) {
      throw Error;
    }
    const buffer = Buffer.from(data.data).slice(8);
    const decodedData = this.deserializeBondingCurveLayout(buffer);
    const vTokenReserve = decodedData.virtualTokenReserves.toString();
    const vSolReserve = decodedData.virtualSolReserves.toString();
    const rTokenReserves = decodedData.realTokenReserves.toString();
    const rSolReserves = decodedData.realSolReserves.toString();
    const tokenTotalSupply = decodedData.tokenTotalSupply.toString();
    const adjustedVTokenReserve =
      decodedData.virtualTokenReserves / BigInt(10 ** 6);
    const adjustedVSolReserve =
      decodedData.virtualSolReserves / BigInt(10 ** 9);
    //const virtualTokenPrice = decodedData.adjustedVSolReserve / decodedData.adjustedVTokenReserve;
    return {
      vTokenReserve,
      vSolReserve,
      rTokenReserves,
      rSolReserves,
      tokenTotalSupply,
      adjustedVTokenReserve,
      adjustedVSolReserve,
      //virtualTokenPrice
    };
  }

  buyQuote(e: BN, t: any) {
    if (e.eq(new BN(0)) || !t) {
      return new BN(0);
    }

    let product = t.virtualSolReserves.mul(t.virtualTokenReserves);
    let newSolReserves = t.virtualSolReserves.add(e);
    let newTokenAmount = product.div(newSolReserves).add(new BN(1));
    let s = t.virtualTokenReserves.sub(newTokenAmount);
    s = BN.min(s, t.realTokenReserves);
    //let fee = calculateFee(e, t.feeBasisPoints);
    return s;
  }

  async calculateBuyAmount(
    bondingCurvePublicKey: PublicKey,
    solAmountToBuy: number,
  ): Promise<number> {
    const {
      vTokenReserve,
      vSolReserve,
      rTokenReserves,
      //feeBasisPoints
    } = await this.GPA(bondingCurvePublicKey);

    // Set bonding curve parameters based on fetched data
    let t = {
      virtualSolReserves: new BN(vSolReserve),
      virtualTokenReserves: new BN(vTokenReserve),
      realTokenReserves: new BN(rTokenReserves),
      // feeBasisPoints: new BN(100),
    };

    // Calculate buy amount using the buyQuote function
    const tokens = this.buyQuote(new BN(solAmountToBuy), t);
    let formattedTokens = tokens / 10 ** 6;

    //let formattedSOL = solAmountToBuy / LAMPORTS_PER_SOL;
    //console.log(`Tokens you can buy with ${formattedSOL} SOL:`, formattedTokens);

    return formattedTokens;
  }

  async sendBundleVTrxs(bundledTxns: VersionedTransaction[]) {
    try {
      console.log('Going To Send Bundle');
      const decodedKey = new Uint8Array(
        JSON.parse(
          fs.readFileSync('src/api/v1/web3/abis/blockengine.json').toString(),
        ) as number[],
      );
      const keypair = Keypair.fromSecretKey(decodedKey);
      const BLOCK_ENGINE_URLS = ['amsterdam.mainnet.block-engine.jito.wtf'];
      const searcherClients: SearcherClient[] = [];

      for (const url of BLOCK_ENGINE_URLS) {
        const client = jitoSearcherClient(url, keypair, {
          'grpc.keepalive_timeout_ms': 4000,
        });
        searcherClients.push(client);
      }

      // all bundles sent get automatically forwarded to the other regions.
      // assuming the first block engine in the array is the closest one
      const searcherClient = searcherClients[0];

      const bundleId = await searcherClient.sendBundle(
        new JitoBundle(bundledTxns, bundledTxns.length),
      );

      console.log(`Swap with BundleID ${bundleId} sent.`);

      /*
          // Assuming onBundleResult returns a Promise<BundleResult>
          const result = await new Promise((resolve, reject) => {
            searcherClient.onBundleResult(
            (result) => {
                console.log('Received bundle result:', result);
                resolve(result); // Resolve the promise with the result
            },
            (e: Error) => {
                console.error('Error receiving bundle result:', e);
                reject(e); // Reject the promise if there's an error
            }
            );
        });
    
        console.log('Result:', result);
        */
      return bundleId;
    } catch (error) {
      const err = error as any;
      console.error('Error sending bundle:', err.message);

      if (
        err?.message?.includes('Bundle Dropped, no connected leader up soon')
      ) {
        console.error(
          'Error sending bundle: Bundle Dropped, no connected leader up soon.',
        );
      } else {
        console.error('An unexpected error occurred:', err.message);
      }
    }
  }

  async sendBundleVTrx(bundledTxn: VersionedTransaction) {
    try {
      console.log('Going To Send Bundle');
      const decodedKey = new Uint8Array(
        JSON.parse(
          fs.readFileSync('src/api/v1/web3/abis/blockengine.json').toString(),
        ) as number[],
      );
      const bundleTransactionLimit = parseInt('3');
      const keypair = Keypair.fromSecretKey(decodedKey);
      const BLOCK_ENGINE_URLS = ['amsterdam.mainnet.block-engine.jito.wtf'];
      const searcherClients: SearcherClient[] = [];

      for (const url of BLOCK_ENGINE_URLS) {
        const client = jitoSearcherClient(url, keypair, {
          'grpc.keepalive_timeout_ms': 4000,
        });
        searcherClients.push(client);
      }

      // all bundles sent get automatically forwarded to the other regions.
      // assuming the first block engine in the array is the closest one
      const searcherClient = searcherClients[0];

      // const bundleId = await searcherClient.sendBundle(
      //   new JitoBundle(bundledTxns, bundledTxns.length),
      // );

      const _tipAccount = await this.getJitoTipAccount();
      console.log('tip account:', _tipAccount);
      const tipAccount = new PublicKey(_tipAccount);

      const bund = new Bundle([], bundleTransactionLimit);
      const resp = await this.connection.getLatestBlockhash('processed');

      if (bundledTxn instanceof VersionedTransaction) {
        bund.addTransactions(bundledTxn);
      }

      let maybeBundle = bund.addTipTx(
        this.wallet.payer,
        0.002 * LAMPORTS_PER_SOL,
        tipAccount,
        resp.blockhash,
      );

      if (isError(maybeBundle)) {
        throw maybeBundle;
      }

      const response_bund = await searcherClient.sendBundle(maybeBundle);
      console.log(`Swap with BundleID ${response_bund} sent.`);
      return response_bund;
    } catch (error) {
      console.log(error);
      const err = error as any;
      console.error('Error sending bundle:', err.message);

      if (
        err?.message?.includes('Bundle Dropped, no connected leader up soon')
      ) {
        console.error(
          'Error sending bundle: Bundle Dropped, no connected leader up soon.',
        );
      } else {
        console.error('An unexpected error occurred:', err.message);
      }
    }
  }

  async makeSwap(
    volAmt: number,
    ata: PublicKey,
    keypair: Keypair,
    bCurve: PublicKey,
    abCurve: PublicKey,
    mint: PublicKey,
  ) {
    try {
      console.log('Starting makeSwap with volAmt:', volAmt);

      const amountData = await this.calculateBuyAmount(bCurve, volAmt);

      console.log('Calculated buy amount:', amountData);

      const amount = Math.floor(amountData * 10 ** 6);
      const maxSolCost = volAmt + volAmt * 100000; // Infinite slippage

      console.log('Creating buy instruction...');
      const buyIx = await this.program.methods
        .buy(new BN(amount), new BN(maxSolCost))
        .accounts({
          global: this.global,
          feeRecipient: this.feeRecipient,
          mint,
          bondingCurve: bCurve,
          associatedBondingCurve: abCurve,
          associatedUser: ata,
          user: keypair.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
          eventAuthority: this.eventAuthority,
          program: this.PUMP_PROGRAM,
        })
        .instruction();

      console.log('Creating sell instruction...');
      const sellIx = await this.program.methods
        .sell(new BN(amount), new BN(0))
        .accounts({
          global: this.global,
          feeRecipient: this.feeRecipient,
          mint,
          bondingCurve: bCurve,
          associatedBondingCurve: abCurve,
          associatedUser: ata,
          user: keypair.publicKey,
          systemProgram: SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          eventAuthority: this.eventAuthority,
          program: this.PUMP_PROGRAM,
        })
        .instruction();

      console.log('Buy and Sell instructions created.');

      let buyIxs: TransactionInstruction[] = [buyIx];
      let sellIxs: TransactionInstruction[] = [sellIx];

      console.log('makeSwap completed successfully.');
      return { buyIxs, sellIxs };
    } catch (error) {
      console.error('Error in makeSwap:', error);
      throw new Error(error.message);
    }
  }

  private updateCache(
    lutAddress: PublicKey,
    lutAccount: AddressLookupTableAccount,
  ) {
    this.lookupTables.set(lutAddress.toBase58(), lutAccount);

    this.addressesForLookupTable.set(lutAddress.toBase58(), new Set());

    for (const address of lutAccount.state.addresses) {
      const addressStr = address.toBase58();
      this.addressesForLookupTable.get(lutAddress.toBase58()).add(addressStr);
      if (!this.lookupTablesForAddress.has(addressStr)) {
        this.lookupTablesForAddress.set(addressStr, new Set());
      }
      this.lookupTablesForAddress.get(addressStr).add(lutAddress.toBase58());
    }
  }

  private processLookupTableUpdate(
    lutAddress: PublicKey,
    data: AccountInfo<Buffer>,
  ) {
    const lutAccount = new AddressLookupTableAccount({
      key: lutAddress,
      state: AddressLookupTableAccount.deserialize(data.data),
    });

    this.updateCache(lutAddress, lutAccount);
    return;
  }

  async getLookupTable(
    lutAddress: PublicKey,
  ): Promise<AddressLookupTableAccount | undefined | null> {
    const lutAddressStr = lutAddress.toBase58();
    if (this.lookupTables.has(lutAddressStr)) {
      return this.lookupTables.get(lutAddressStr);
    }

    const lut = await this.connection.getAddressLookupTable(lutAddress);
    if (lut.value === null) {
      return null;
    }

    this.updateCache(lutAddress, lut.value);

    return lut.value;
  }

  computeIdealLookupTablesForAddresses(
    addresses: PublicKey[],
  ): AddressLookupTableAccount[] {
    const MIN_ADDRESSES_TO_INCLUDE_TABLE = 2;
    const MAX_TABLE_COUNT = 3;

    const addressSet = new Set<string>();
    const tableIntersections = new Map<string, number>();
    const selectedTables: AddressLookupTableAccount[] = [];
    const remainingAddresses = new Set<string>();
    let numAddressesTakenCareOf = 0;

    for (const address of addresses) {
      const addressStr = address?.toBase58();

      if (addressSet.has(addressStr)) continue;
      addressSet.add(addressStr);

      const tablesForAddress =
        this.lookupTablesForAddress.get(addressStr) || new Set();

      if (tablesForAddress.size === 0) continue;

      remainingAddresses.add(addressStr);

      for (const table of tablesForAddress) {
        const intersectionCount = tableIntersections.get(table) || 0;
        tableIntersections.set(table, intersectionCount + 1);
      }
    }

    const sortedIntersectionArray = Array.from(
      tableIntersections.entries(),
    ).sort((a, b) => b[1] - a[1]);

    for (const [lutKey, intersectionSize] of sortedIntersectionArray) {
      if (intersectionSize < MIN_ADDRESSES_TO_INCLUDE_TABLE) break;
      if (selectedTables.length >= MAX_TABLE_COUNT) break;
      if (remainingAddresses.size <= 1) break;

      const lutAddresses: any = this.addressesForLookupTable.get(lutKey);

      const addressMatches = new Set(
        [...remainingAddresses].filter((x) => lutAddresses.has(x)),
      );

      if (addressMatches.size >= MIN_ADDRESSES_TO_INCLUDE_TABLE) {
        selectedTables.push(this.lookupTables.get(lutKey));
        for (const address of addressMatches) {
          remainingAddresses.delete(address);
          numAddressesTakenCareOf++;
        }
      }
    }

    return selectedTables;
  }

  async checkTokenAccountExists(
    accountPublicKeyString: PublicKey,
  ): Promise<boolean> {
    try {
      const accountPublicKey = new PublicKey(accountPublicKeyString);
      const accountInfo = await this.connection.getAccountInfo(
        accountPublicKey,
      );

      if (accountInfo === null) {
        console.log(`Account ${accountPublicKeyString} does not exist.`);
        return false;
      } else {
        console.log(`Account ${accountPublicKeyString} exists.`);
        return true;
      }
    } catch (error) {
      console.error(`Error checking account: ${error}`);
      return false; // Assuming false in case of error, adjust as needed
    }
  }

  deleteKeypairFile(keypair: Keypair) {
    const identifier = keypair.publicKey.toString(); // Use the public key as identifier
    const filename = `keypair-${identifier}.json`;
    const filePath = path.join(this.keypairsDir, filename);
    try {
      fs.unlinkSync(filePath);
      console.log(`Deleted file for keypair with zero balance: ${filename}`);
    } catch (err) {
      console.error(`Error deleting file: ${filename}`, err);
    }
  }

  deleteKeypairFileFromVolumeDir(keypair: Keypair) {
    const identifier = keypair.publicKey.toString(); // Use the public key as identifier
    const filename = `keypair-${identifier}.json`;
    const filePath = path.join(this.volKeypairsDir, filename);
    try {
      fs.unlinkSync(filePath);
      console.log(`Deleted file for keypair with zero balance: ${filename}`);
    } catch (err) {
      console.error(`Error deleting file: ${filename}`, err);
    }
  }

  // Function to load all keypairs from a specified directory
  loadKeypairs() {
    const keypairs: Keypair[] = [];
    const files = fs.readdirSync(this.keypairsDir);

    files.forEach((file) => {
      if (file.endsWith('.json')) {
        // Ensure the file is a .json file
        const filePath = path.join(this.keypairsDir, file);
        const fileData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const keypair = Keypair.fromSecretKey(new Uint8Array(fileData));
        keypairs.push(keypair);
      }
    });

    return keypairs;
  }

  checkKeypairsExist() {
    try {
      // Read the directory contents
      const files = fs.readdirSync(this.keypairsDir);

      // Check if there are any JSON files in the directory
      const keypairFiles = files.filter((file) => file.endsWith('.json'));

      // If there are JSON files, return true, indicating that keypair files exist
      return keypairFiles.length > 0;
    } catch (err) {
      console.error('Error accessing the keypairs directory:', err);
      return false; // Return false if there's an error accessing the directory
    }
  }

  encodeU64(value) {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(value), 0);
    return buffer;
  }

  encodeTransaction(amount, maxSolCost) {
    const opcode = Buffer.from([0x66]); // Opcode for 'buy' instruction
    const constantPrefix = Buffer.from('063d1201daebea', 'hex'); // The constant part after opcode

    // Encoding the amount and maxSolCost
    const encodedAmount = this.encodeU64(amount);
    const encodedMaxSolCost = this.encodeU64(maxSolCost);

    // Concatenating all parts: opcode, constantPrefix, encodedAmount, encodedMaxSolCost
    const encodedData = Buffer.concat([
      opcode,
      constantPrefix,
      encodedAmount,
      encodedMaxSolCost,
    ]);
    return encodedData;
  }

  async createATA(mint, wallets) {
    try {
      const wallet = wallets;

      const pubkey = wallet.publicKey;
      const owner = new PublicKey(pubkey.toString());

      // const keypair = Keypair.fromSecretKey(bs58.decode(wallet.privKey));
      const mintToken = new PublicKey(mint);

      // Get the associated token address
      const associatedToken = getAssociatedTokenAddressSync(
        mintToken,
        owner,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const ata = associatedToken.toBase58();
      const ataIX = createAssociatedTokenAccountIdempotentInstruction(
        owner,
        associatedToken,
        owner,
        mintToken,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );

      return { ata, ataIX };
    } catch (error) {
      console.log('An error occurred, check logs.txt for more information.');
      throw error; // Rethrow the error after logging it
    }
  }

  async getJitoTipAccount() {
    try {
      const jitpTipAccounts = [
        'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
        'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
        '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
        '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
        'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
        'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
        'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
        'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
      ];

      return jitpTipAccounts[
        Math.floor(Math.random() * jitpTipAccounts.length)
      ];
    } catch (error) {
      return 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY';
    }
  }

  loadKeypairsFromVolumeDir(): Keypair[] {
    // Define a regular expression to match filenames like 'keypair1.json', 'keypair2.json', etc.
    const keypairRegex = /^keypair\d+\.json$/;
    // .filter((file) => keypairRegex.test(file)) // Use the regex to test each filename

    return fs.readdirSync(this.volKeypairsDir).map((file) => {
      console.log('file ', file);
      const filePath = path.join(this.volKeypairsDir, file);
      const secretKeyString = fs.readFileSync(filePath, { encoding: 'utf8' });
      const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
      return Keypair.fromSecretKey(secretKey);
    });
  }

  checkKeypairsExistForVolume() {
    try {
      // Read the directory contents
      const files = fs.readdirSync(this.volKeypairsDir);

      // Check if there are any JSON files in the directory
      const keypairFiles = files.filter((file) => file.endsWith('.json'));

      // If there are JSON files, return true, indicating that keypair files exist
      return keypairFiles.length > 0;
    } catch (err) {
      console.error('Error accessing the keypairs directory:', err);
      return false; // Return false if there's an error accessing the directory
    }
  }

  async buyTheShitCoin(body: any) {
    // const config = await loadConfig();

    //   const wallets = await loadWallets();
    const cycles = parseFloat(body.cycles);
    const delay = parseFloat(body.total_delay_per_tx);

    const PUMP_PUBLIC_KEY = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
    const pump = new PublicKey(PUMP_PUBLIC_KEY);

    const url = `https://frontend-api.pump.fun/coins/${body.contract_addresses}`;

    const response = await axios.get(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive',
      },
    });

    if (response.status !== 200) {
      console.log(`Error: ${response.status}`);
      return;
    } else {
      console.log(`Success: ${response.status}`);
    }

    const data = response.data;
    const bCurve = data.bonding_curve;
    const aCurve = data.associated_bonding_curve;

    const mint = new PublicKey(body.contract_addresses);
    const bondingCurve = new PublicKey(bCurve);
    const aBondingCurve = new PublicKey(aCurve);

    const decimals = 9;
    const pumpDecimals = 6;
    const buyAmountLamports = body.buy_amount * 10 ** decimals;
    console.log(buyAmountLamports);

    const keypairs: Keypair[] = this.loadKeypairsFromVolumeDir();
    // get ATA instructions
    for (let i = 0; i < keypairs.length; i++) {
      const thisWallet = keypairs[i];

      console.log(`Processing wallet: ${thisWallet.publicKey}`);

      const payer = Keypair.fromSecretKey(thisWallet.secretKey);
      const wallet = new PublicKey(thisWallet.publicKey);

      const tokenAccount = await this.createATA(mint.toBase58(), thisWallet);
      const tokenAccountPubKey = tokenAccount.ata;

      const ataIx = tokenAccount.ataIX;

      console.log(tokenAccountPubKey);

      // fetch balance of wallet
      let walletBalance = await this.connection.getBalance(wallet);
      console.log('Wallet balance: ' + walletBalance);

      const SYSTEM_PROGAM_ID = '11111111111111111111111111111111';
      const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      const SYSVAR_RENT_ID = 'SysvarRent111111111111111111111111111111111';
      const global = new PublicKey(
        '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
      );
      const feeRecipient = new PublicKey(
        'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
      );
      const idkThisOne = new PublicKey(
        'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
      );

      const account1 = global;
      const account2 = feeRecipient; // Writeable
      const account3 = mint;
      const account4 = bondingCurve; // Writeable
      const account5 = aBondingCurve; // Writeable
      const account6 = new PublicKey(tokenAccountPubKey); // Writeable
      const account7 = wallet; // Writeable & Signer & Fee Payer
      const account8 = new PublicKey(SYSTEM_PROGAM_ID); // Program
      const account9 = new PublicKey(TOKEN_PROGRAM_ID); // Program
      const account10 = new PublicKey(SYSVAR_RENT_ID);
      const account11 = idkThisOne;
      const account12 = pump;

      // Example usage:
      const amountData = await this.calculateBuyAmount(
        bondingCurve,
        buyAmountLamports,
      );
      let amount: any = amountData * 10 ** pumpDecimals;
      amount = amount.toFixed(0);

      const maxSolCost = buyAmountLamports + buyAmountLamports * 0.15;
      const transactionBuffer = this.encodeTransaction(amount, maxSolCost);

      const swapIn = new TransactionInstruction({
        programId: pump,
        keys: [
          {
            pubkey: account1,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account2,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: account3,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account4,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: account5,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: account6,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: account7,
            isSigner: true,
            isWritable: true,
          },
          {
            pubkey: account8,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account9,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account10,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account11,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account12,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: transactionBuffer,
      });

      const txFee = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 0.001 * LAMPORTS_PER_SOL,
      });

      const trx = new Transaction().add(txFee).add(ataIx).add(swapIn);

      trx.feePayer = wallet;
      let blockhashObj = await this.connection.getLatestBlockhash('finalized');
      let latestBlockhash = blockhashObj.blockhash;
      trx.recentBlockhash = latestBlockhash;

      trx.sign(payer);

      const fullTX = trx.serialize();

      try {
        const txid = await this.connection.sendRawTransaction(fullTX, {
          preflightCommitment: 'confirmed',
          skipPreflight: true,
          maxRetries: 10,
        });

        console.log(`${i} Transaction ID: https://solscan.io/tx/${txid}`);
        console.log(
          "To improve performance, we will not programatically confirm TX's please check solscan.",
        );

        // set 15s delay before next transaction
        await new Promise((resolve) => setTimeout(resolve, 15000));
      } catch (error) {
        console.log('An error occurred, check logs.txt for more information.');
        console.log(error);
        throw error; // Rethrow the error after logging it
      }
    }
    return;
  }

  async sellTheShitCoin(body) {
    // const config = await loadConfig();

    // const wallets = await loadWallets();
    const cycles = parseFloat(body.cycles);
    const delay = parseFloat(body.total_delay_per_tx);

    const PUMP_PUBLIC_KEY = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
    const pump = new PublicKey(PUMP_PUBLIC_KEY);

    const url = `https://frontend-api.pump.fun/coins/${body.contract_addresses}`;

    const response = await axios.get(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive',
      },
    });

    if (response.status !== 200) {
      console.log(`Error: ${response.status}`);
      return;
    } else {
      console.log(`Success: ${response.status}`);
    }

    const keypairs: Keypair[] = this.loadKeypairsFromVolumeDir();
    // get ATA instructions
    for (let i = 0; i < keypairs.length; i++) {
      const thisWallet = keypairs[i];
      const mint = new PublicKey(body.contract_addresses);

      console.log(`Processing wallet: ${thisWallet.publicKey}\n`);

      const payer = Keypair.fromSecretKey(thisWallet.secretKey);
      const wallet = new PublicKey(thisWallet.publicKey);

      const tokenAccount = await this.createATA(mint.toBase58(), thisWallet);
      const tokenAccountPubKey = tokenAccount.ata;

      const ataIx = tokenAccount.ataIX;

      console.log(tokenAccountPubKey);

      // fetch balance of wallet
      let walletBalance = await this.connection.getBalance(wallet);

      if (walletBalance < 0) {
        console.log('Wallet SOL balance too low, skipping.');
        continue;
      }

      const data = response.data;
      const bCurve = data.bonding_curve;
      const aCurve = data.associated_bonding_curve;
      const virtualSolReserves = data.virtual_sol_reserves;
      const virtualTokenReserves = data.virtual_token_reserves;

      const bondingCurve = new PublicKey(bCurve);
      const aBondingCurve = new PublicKey(aCurve);

      let sellAmount;
      try {
        sellAmount = await this.connection.getTokenAccountBalance(
          new PublicKey(tokenAccountPubKey),
        );
      } catch (error) {
        continue;
      }
      let sellAmountLamports = sellAmount.value.amount;
      sellAmount = sellAmount.value.uiAmount;

      if (sellAmount <= 0) {
        console.log('Token balance too low (empty), skipping.\n');
        continue;
      }

      const SYSTEM_PROGAM_ID = '11111111111111111111111111111111';
      const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      const global = new PublicKey(
        '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
      );
      const feeRecipient = new PublicKey(
        'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
      );

      const account1 = global;
      const account2 = feeRecipient; // Writeable
      const account3 = mint;
      const account4 = bondingCurve; // Writeable
      const account5 = aBondingCurve; // Writeable
      const account6 = new PublicKey(tokenAccountPubKey); // Writeable
      const account7 = wallet; // Writeable & Signer & Fee Payer
      const account8 = new PublicKey(SYSTEM_PROGAM_ID); // Program
      const account9 = new PublicKey(
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      ); // Program
      const account10 = new PublicKey(TOKEN_PROGRAM_ID);
      const account11 = new PublicKey(
        'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
      );
      const account12 = new PublicKey(
        '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      ); // Program

      const pricePer = virtualSolReserves / virtualTokenReserves / 1000;

      let slippage = 1 - 0.5;

      let minSolOutput: any = null;
      minSolOutput = parseFloat((sellAmount * pricePer).toString());
      minSolOutput = parseInt((minSolOutput * slippage * 1e9).toString());

      console.log(`Selling ${sellAmount} tokens for ${minSolOutput / 1e9} SOL`);

      const sell = BigInt('12502976635542562355');
      const amount = BigInt(sellAmountLamports);
      const min_sol_output = BigInt(minSolOutput);

      const integers = [sell, amount, min_sol_output];

      const binary_segments = integers.map((integer) => {
        const buffer = Buffer.alloc(8);
        buffer.writeBigUInt64LE(integer);
        return buffer;
      });

      const transactionBuffer = Buffer.concat(binary_segments);

      const swapOut = new TransactionInstruction({
        programId: pump,
        keys: [
          {
            pubkey: account1,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account2,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: account3,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account4,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: account5,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: account6,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: account7,
            isSigner: true,
            isWritable: true,
          },
          {
            pubkey: account8,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account9,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account10,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account11,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account12,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: transactionBuffer,
      });

      const txFee = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 0.001 * LAMPORTS_PER_SOL,
      });

      const trx = new Transaction().add(txFee).add(ataIx).add(swapOut);

      trx.feePayer = wallet;
      let blockhashObj = await this.connection.getLatestBlockhash('finalized');
      let latestBlockhash = blockhashObj.blockhash;
      trx.recentBlockhash = latestBlockhash;

      trx.sign(payer);

      const fullTX = trx.serialize();

      try {
        const txid = await this.connection.sendRawTransaction(fullTX, {
          preflightCommitment: 'confirmed',
          skipPreflight: true,
          maxRetries: 10,
        });

        console.log(`${i} Transaction ID: https://solscan.io/tx/${txid}`);
        console.log(
          "To improve performance, we will not programatically confirm TX's please check solscan.",
        );

        // set 15s delay before next transaction
        await new Promise((resolve) => setTimeout(resolve, 15000));
      } catch (error) {
        console.log('An error occurred, check logs.txt for more information.');
        throw error; // Rethrow the error after logging it
      }
      return '';
    }
  }

  // Spam buys For Bumper
  async getTheBumperUp(body) {
    try {
      const jitoTipAmt = +'0.001' * LAMPORTS_PER_SOL;

      const cycles = parseFloat(body.cycles);
      const delay = parseFloat(body.total_delay_per_tx);

      // Clear existing keypairs
      // const files = fs.readdirSync(this.keypairsDir);
      // for (const file of files) {
      //   const filePath = path.join(this.keypairsDir, file);
      //   fs.unlinkSync(filePath);
      // }

      const url = `https://frontend-api.pump.fun/coins/${body.contract_addresses}`;

      const response = await axios.get(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept-Encoding': 'gzip, deflate, br',
          Connection: 'keep-alive',
        },
      });

      if (response.status !== 200) {
        console.log(`Error: ${response.status}`);
        return;
      } else {
        console.log(`Success: ${response.status}`);
      }

      const data = response.data;
      const bCurve = data.bonding_curve;
      const abCurve = data.associated_bonding_curve;

      const mint = new PublicKey(body.contract_addresses);
      const bondingCurve = new PublicKey(bCurve);
      const aBondingCurve = new PublicKey(abCurve);

      const amount = this.distributeAmount(body.total_amount, cycles);
      for (let i = 0; i < cycles; i++) {
        console.log(`Cycle ${i + 1}`);
        const keypair = Keypair.generate();

        // Validate the generated keypair's public key
        if (this.isValidSolanaAddress(keypair.publicKey)) {
          const filename = `keypair-${keypair.publicKey.toString()}.json`;
          const filePath = path.join(this.keypairsDir, filename);
          fs.writeFileSync(
            filePath,
            JSON.stringify(Array.from(keypair.secretKey)),
          );
        } else {
          console.error('Invalid keypair generated, skipping...');
        }

        const { blockhash } = await this.connection.getLatestBlockhash();
        console.log('Token Mint ', mint.toBase58());
        console.log('Bonding Curve ', bondingCurve.toBase58());
        console.log('A Bonding Curve ', aBondingCurve.toBase58());
        console.log('SOL amount used: ', amount[i]);
        await this.executeSwaps(
          Number((amount[i] * LAMPORTS_PER_SOL).toFixed(0)),
          keypair,
          mint,
          bondingCurve,
          aBondingCurve,
          jitoTipAmt,
          blockhash,
        );
        console.log('Next Iteration\n');

        // Wait for the specified delay before proceeding to the next cycle
        await this.sleep(delay);
      }

      console.log('Execution completed.');
    } catch (error) {
      throw new Error(error.message);
    }
  }

  // Transfer all the tokens to main wallet
  async getTheBumperDown(body) {
    const mint = new PublicKey(body.contract_addresses);
    const jitoTipAmtInput = '0.001';
    const jitoTipAmt = parseFloat(jitoTipAmtInput) * LAMPORTS_PER_SOL;

    const walletATA = await getAssociatedTokenAddress(
      mint,
      this.bumperWallet.publicKey,
    );

    let keypairsExist = this.checkKeypairsExist();

    while (keypairsExist) {
      const keypairs = this.loadKeypairs(); // Reload keypairs each iteration
      let txsSigned: VersionedTransaction[] = [];
      let maxSize = 0;
      const { blockhash } = await this.connection.getLatestBlockhash();

      for (let i = 0; i < keypairs.length; i++) {
        const keypair = keypairs[i];
        console.log(
          `Processing keypair ${i + 1}/${keypairs.length}:`,
          keypair.publicKey.toString(),
        );

        const ataKeypair = await getAssociatedTokenAddress(
          mint,
          keypair.publicKey,
        );

        if (await this.checkTokenAccountExists(ataKeypair)) {
          const instructionsForChunk: TransactionInstruction[] = [];

          const balance = await this.connection.getTokenAccountBalance(
            ataKeypair,
          );

          instructionsForChunk.push(
            createAssociatedTokenAccountIdempotentInstruction(
              this.bumperWallet.publicKey,
              walletATA,
              this.bumperWallet.publicKey,
              mint,
            ),
            createTransferInstruction(
              ataKeypair,
              walletATA,
              keypair.publicKey,
              +balance.value.amount,
            ),
            createCloseAccountInstruction(
              ataKeypair,
              this.bumperWallet.publicKey,
              keypair.publicKey,
            ),
          );

          if (maxSize === 0) {
            const tipSwapIxn = SystemProgram.transfer({
              fromPubkey: this.bumperWallet.publicKey,
              toPubkey: this.tipAcct,
              lamports: BigInt(jitoTipAmt),
            });
            instructionsForChunk.push(tipSwapIxn);
          }

          const message = new TransactionMessage({
            payerKey: this.bumperWallet.publicKey,
            recentBlockhash: blockhash,
            instructions: instructionsForChunk,
          }).compileToV0Message();

          const versionedTx = new VersionedTransaction(message);

          versionedTx.sign([this.bumperWallet, keypair]);

          txsSigned.push(versionedTx);

          // -------- step 4: send bundle --------

          // Simulate each transaction
          for (const tx of txsSigned) {
            try {
              const simulationResult =
                await this.connection.simulateTransaction(tx, {
                  commitment: 'processed',
                });
              console.log(simulationResult);

              if (simulationResult.value.err) {
                console.error(
                  'Simulation error for transaction:',
                  simulationResult.value.err,
                );
              } else {
                console.log('Simulation success for transaction. Logs:');
                simulationResult.value.logs?.forEach((log) => console.log(log));
                await this.saveTransactionDetails(
                  keypair.publicKey.toString(),
                  'jitoTxId',
                  (balance.value.amount / LAMPORTS_PER_SOL + 0.0025) /
                    LAMPORTS_PER_SOL,
                  'volume',
                );
              }
            } catch (error) {
              console.error('Error during simulation:', error);
            }
          }
          maxSize++;

          // When maxSize reaches 5 or it's the last keypair, send the bundle
          if (maxSize === 5 || i === keypairs.length - 1) {
            await this.sendBundleVTrxs(txsSigned); // Send the current bundle
            txsSigned = []; // Reset for the next bundle
            maxSize = 0; // Reset counter
          }
        } else {
          console.log(
            `Skipping keypair with zero balance:`,
            keypair.publicKey.toString(),
          );
          this.deleteKeypairFile(keypair); // Handle file deletion
        }
      }
      keypairsExist = this.checkKeypairsExist();
    }
    console.log('All transactions processed and no more keypairs left.');
  }

  // Convert Token to SOL
  async convertBumperTokenToWSOL(body) {
    try {
      console.log(
        'Bumper Wallet Ppublick Key : ',
        this.volumeWallet.publicKey.toString(),
      );
      const PUMP_PUBLIC_KEY = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
      const pump = new PublicKey(PUMP_PUBLIC_KEY);

      const url = `https://frontend-api.pump.fun/coins/${body.contract_addresses}`;

      const response = await axios.get(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept-Encoding': 'gzip, deflate, br',
          Connection: 'keep-alive',
        },
      });

      if (response.status !== 200) {
        console.log(`Error: ${response.status}`);
        return;
      } else {
        console.log(`Success: ${response.status}`);
      }

      const mint = new PublicKey(body.contract_addresses);

      console.log(`Processing wallet: ${this.volumeWallet.publicKey}\n`);

      const payer = Keypair.fromSecretKey(this.volumeWallet.secretKey);
      const wallet = new PublicKey(this.volumeWallet.publicKey);

      const tokenAccount = await this.createATA(
        mint.toBase58(),
        this.volumeWallet,
      );
      const tokenAccountPubKey = tokenAccount.ata;

      const ataIx = tokenAccount.ataIX;

      console.log(tokenAccountPubKey);

      // fetch balance of wallet
      let walletBalance = await this.connection.getBalance(wallet);

      if (walletBalance < 0) {
        console.log('Wallet SOL balance too low, skipping.');
        return;
      }

      const data = response.data;
      const bCurve = data.bonding_curve;
      const aCurve = data.associated_bonding_curve;
      const virtualSolReserves = data.virtual_sol_reserves;
      const virtualTokenReserves = data.virtual_token_reserves;

      const bondingCurve = new PublicKey(bCurve);
      const aBondingCurve = new PublicKey(aCurve);

      let sellAmount = await this.connection.getTokenAccountBalance(
        new PublicKey(tokenAccountPubKey),
      );
      let sellAmountLamports = sellAmount.value.amount;
      sellAmount = sellAmount.value.uiAmount;
      if (sellAmount <= 0) {
        console.log('Token balance too low (empty), skipping.\n');
        return;
      }

      const SYSTEM_PROGAM_ID = '11111111111111111111111111111111';
      const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      const global = new PublicKey(
        '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
      );
      const feeRecipient = new PublicKey(
        'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
      );

      const account1 = global;
      const account2 = feeRecipient; // Writeable
      const account3 = mint;
      const account4 = bondingCurve; // Writeable
      const account5 = aBondingCurve; // Writeable
      const account6 = new PublicKey(tokenAccountPubKey); // Writeable
      const account7 = wallet; // Writeable & Signer & Fee Payer
      const account8 = new PublicKey(SYSTEM_PROGAM_ID); // Program
      const account9 = new PublicKey(
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      ); // Program
      const account10 = new PublicKey(TOKEN_PROGRAM_ID);
      const account11 = new PublicKey(
        'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
      );
      const account12 = new PublicKey(
        '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      ); // Program

      const pricePer = virtualSolReserves / virtualTokenReserves / 1000;

      let slippage = 1 - 0.5;

      let minSolOutput: any = null;
      minSolOutput = parseFloat((sellAmount * pricePer).toString());
      minSolOutput = parseInt((minSolOutput * slippage * 1e9).toString());

      console.log(`Selling ${sellAmount} tokens for ${minSolOutput / 1e9} SOL`);

      const sell = BigInt('12502976635542562355');
      const amount = BigInt(sellAmountLamports);
      const min_sol_output = BigInt(minSolOutput);

      const integers = [sell, amount, min_sol_output];

      const binary_segments = integers.map((integer) => {
        const buffer = Buffer.alloc(8);
        buffer.writeBigUInt64LE(integer);
        return buffer;
      });

      const transactionBuffer = Buffer.concat(binary_segments);

      const swapOut = new TransactionInstruction({
        programId: pump,
        keys: [
          {
            pubkey: account1,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account2,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: account3,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account4,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: account5,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: account6,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: account7,
            isSigner: true,
            isWritable: true,
          },
          {
            pubkey: account8,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account9,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account10,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account11,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account12,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: transactionBuffer,
      });

      const txFee = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 0.001 * LAMPORTS_PER_SOL,
      });

      const trx = new Transaction().add(txFee).add(ataIx).add(swapOut);

      trx.feePayer = wallet;
      let blockhashObj = await this.connection.getLatestBlockhash('finalized');
      let latestBlockhash = blockhashObj.blockhash;
      trx.recentBlockhash = latestBlockhash;

      const message1 = new TransactionMessage({
        payerKey: trx.feePayer,
        recentBlockhash: trx.recentBlockhash,
        instructions: trx.instructions,
      }).compileToV0Message();

      const swaptx = new VersionedTransaction(message1);

      swaptx.sign([payer]);

      let txsSigned: VersionedTransaction[] = [];
      txsSigned.push(swaptx);

      // Simulate each transaction
      for (const tx of txsSigned) {
        try {
          const simulationResult = await this.connection.simulateTransaction(
            tx,
            {
              commitment: 'processed',
            },
          );
          console.log(simulationResult);

          if (simulationResult.value.err) {
            console.error(
              'Simulation error for transaction:',
              simulationResult.value.err,
            );
          } else {
            console.log('Simulation success for transaction. Logs:');
            simulationResult.value.logs?.forEach((log) => console.log(log));
            await this.saveTransactionDetails(
              this.volumeWallet.publicKey.toString(),
              'jitoTxId',
              minSolOutput / LAMPORTS_PER_SOL,
              'volume',
            );
          }
        } catch (error) {
          console.error('Error during simulation:', error);
        }
      }

      try {
        // const txid = await this.jitoService.send_bundle(swaptx);
        // console.log(`JITO Bundle ID : ${txid}`);
      } catch (error) {
        console.log('An error occurred, check logs.txt for more information.');
        throw error; // Rethrow the error after logging it
      }
      return '';
    } catch (error) {
      console.log(error);
      throw new Error(error.message);
    }
  }

  distributeAmount(totalAmount, numberOfWallets) {
    if (numberOfWallets <= 0 || totalAmount <= 0) {
      throw new Error(
        'Total amount and number of wallets must be greater than zero.',
      );
    }

    // Calculate the minimum amount each wallet should receive
    const minAmountPerWallet = 0.01;

    // Check if the total amount is sufficient to give each wallet the minimum amount
    if (totalAmount < numberOfWallets * minAmountPerWallet) {
      throw new Error(
        'Total amount is not enough to distribute the minimum amount to each wallet.',
      );
    }

    let amounts = new Array(numberOfWallets).fill(minAmountPerWallet);
    let remainingAmount = totalAmount - numberOfWallets * minAmountPerWallet;

    for (let i = 0; i < numberOfWallets - 1; i++) {
      let maxAmount =
        remainingAmount - (numberOfWallets - i - 1) * minAmountPerWallet;
      let randomAmount = Math.random() * maxAmount;
      randomAmount = Math.round(randomAmount * 100) / 100; // Round to 2 decimal places
      amounts[i] += randomAmount;
      remainingAmount -= randomAmount;
    }

    // Assign the remaining amount to the last wallet
    amounts[numberOfWallets - 1] += Math.round(remainingAmount * 100) / 100;

    return amounts;
  }

  async prepareWalletsForVolumePFun(body: any) {
    try {
      const jitoTipAmt = +0.001 * LAMPORTS_PER_SOL;
      const cycles = body.cycles;
      const amountToDistribute = body.buy_amount;

      const ixs: TransactionInstruction[] = [];
      const sendTxns: VersionedTransaction[] = [];
      const { blockhash } = await this.connection.getLatestBlockhash();

      // Clear existing keypairs
      // const files = fs.readdirSync(this.volKeypairsDir);
      // for (const file of files) {
      //   const filePath = path.join(this.volKeypairsDir, file);
      //   fs.unlinkSync(filePath);
      // }

      console.log(
        'Going to Transfer From: ',
        this.volumeWallet.publicKey.toString(),
      );

      for (let i = 0; i < cycles; i++) {
        const keypair = Keypair.generate();

        // Validate the generated keypair's public key
        if (this.isValidSolanaAddress(keypair.publicKey)) {
          const filename = `keypair-${keypair.publicKey.toString()}.json`;
          const filePath = path.join(this.volKeypairsDir, filename);
          fs.writeFileSync(
            filePath,
            JSON.stringify(Array.from(keypair.secretKey)),
          );

          ixs.push(
            SystemProgram.transfer({
              fromPubkey: this.volumeWallet.publicKey,
              toPubkey: keypair.publicKey,
              lamports: Math.floor(amountToDistribute * LAMPORTS_PER_SOL),
            }),
          );
          // Debugging line before sending transaction
          console.log(`Preparing to send transaction ${i + 1}`);
          console.log(
            `Sent ${Number(amountToDistribute) + 0.0025} SOL to Wallet ${
              i + 1
            } (${keypair.publicKey.toString()})`,
          );
        } else {
          console.error('Invalid keypair generated, skipping...');
        }
      }
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: this.volumeWallet.publicKey,
          toPubkey: new PublicKey(await this.getJitoTipAccount()),
          lamports: BigInt(jitoTipAmt),
        }),
      );

      const txns: VersionedTransaction[] = [];
      const instructionChunks = this.pumpFunService.chunkArray(ixs, 20); // Adjust the chunk size as needed

      for (let i = 0; i < instructionChunks.length; i++) {
        const versionedTx =
          await this.pumpFunService.createAndSignVersionedTxWithVoumeWallet(
            instructionChunks[i],
            blockhash,
            this.volumeWallet,
          );
        txns.push(versionedTx);
      }

      sendTxns.push(...txns);
      await this.sendBundleVTrxs(sendTxns);
      return '';
    } catch (error) {
      console.error('Error:', error.message); // More descriptive error logging
      throw new Error(error.message);
    }
  }

  async getSolFromVolumeWallets() {
    try {
      console.log("Going to get back sol's");
      const delay = 10000;
      const jitoTipAmt = 0.001 * LAMPORTS_PER_SOL;
      let keypairsExist = this.checkKeypairsExistForVolume();

      while (keypairsExist) {
        const keypairs = this.loadKeypairsFromVolumeDir(); // Reload keypairs each iteration
        let txsSigned: VersionedTransaction[] = [];
        const { blockhash } = await this.connection.getLatestBlockhash();

        for (let i = 0; i < keypairs.length; i++) {
          const keypair = keypairs[i];
          console.log(
            `Processing keypair ${i + 1}/${keypairs.length}:`,
            keypair.publicKey.toString(),
          );

          const balanceLamports = await this.connection.getBalance(
            keypair.publicKey,
          );
          const balanceSol = balanceLamports / LAMPORTS_PER_SOL; // Convert lamports to SOL
          const fee = 0.0025 * LAMPORTS_PER_SOL;
          console.log('balanceLamports ', balanceLamports);
          console.log('fee ', fee);

          console.log('balance (SOL): ', balanceSol);

          if (balanceSol > 0) {
            // Create a temporary transaction instruction to estimate the fee
            const ixs = [
              SystemProgram.transfer({
                fromPubkey: keypair.publicKey,
                toPubkey: this.volumeWallet.publicKey,
                lamports: balanceLamports,
              }),
            ];

            const message = new TransactionMessage({
              payerKey: this.volumeWallet.publicKey,
              recentBlockhash: blockhash,
              instructions: ixs,
            }).compileToV0Message();

            const versionedTx = new VersionedTransaction(message);
            versionedTx.sign([keypair, this.volumeWallet]);

            // Simulate and potentially send the transaction
            // try {
            //   const simulationResult =
            //     await this.connection.simulateTransaction(versionedTx, {
            //       commitment: 'processed',
            //     });
            //   console.log(simulationResult);

            //   if (simulationResult.value.err) {
            //     console.error(
            //       'Simulation error for transaction:',
            //       simulationResult.value.err,
            //     );
            //   } else {
            //     console.log('Simulation success for transaction. Logs:');
            //     simulationResult.value.logs?.forEach((log) => console.log(log));

            //     // Send the transaction if simulation succeeds
            //   }
            // } catch (error) {
            //   console.error('Error during simulation:', error);
            // }
            await this.jitoService.send_bundle(versionedTx);
          } else {
            console.log(
              `Skipping keypair with zero balance:`,
              keypair.publicKey.toString(),
            );
            this.deleteKeypairFileFromVolumeDir(keypair);
          }
        }

        await this.sleep(delay);
        keypairsExist = this.checkKeypairsExistForVolume();
      }
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async convertWSOLToTokenForVolume(
    contract_addresses: string,
    keypair: Keypair,
    buy_amount: any,
  ) {
    try {
      let jitoTxId = '';
      const thisWallet = keypair;
      const PUMP_PUBLIC_KEY = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
      const pump = new PublicKey(PUMP_PUBLIC_KEY);

      const url = `https://frontend-api.pump.fun/coins/${contract_addresses}`;

      const response = await axios.get(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept-Encoding': 'gzip, deflate, br',
          Connection: 'keep-alive',
        },
      });

      if (response.status !== 200) {
        console.log(`Error: ${response.status}`);
        return;
      } else {
        console.log(`Success: ${response.status}`);
      }

      const data = response.data;
      const bCurve = data.bonding_curve;
      const aCurve = data.associated_bonding_curve;

      const mint = new PublicKey(contract_addresses);
      const bondingCurve = new PublicKey(bCurve);
      const aBondingCurve = new PublicKey(aCurve);

      const decimals = 9;
      const pumpDecimals = 6;
      const buyAmountLamports = buy_amount * 10 ** decimals;
      console.log(buyAmountLamports);

      // get ATA instructions

      console.log(`Processing wallet: ${thisWallet.publicKey}`);

      const payer = Keypair.fromSecretKey(thisWallet.secretKey);
      const wallet = new PublicKey(thisWallet.publicKey);

      const tokenAccount = await this.createATA(mint.toBase58(), thisWallet);
      const tokenAccountPubKey = tokenAccount.ata;

      const ataIx = tokenAccount.ataIX;

      console.log(tokenAccountPubKey);

      // fetch balance of wallet
      let walletBalance = await this.connection.getBalance(wallet);
      console.log('Wallet balance: ' + walletBalance);

      const SYSTEM_PROGAM_ID = '11111111111111111111111111111111';
      const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      const SYSVAR_RENT_ID = 'SysvarRent111111111111111111111111111111111';
      const global = new PublicKey(
        '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
      );
      const feeRecipient = new PublicKey(
        'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
      );
      const idkThisOne = new PublicKey(
        'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
      );

      const account1 = global;
      const account2 = feeRecipient; // Writeable
      const account3 = mint;
      const account4 = bondingCurve; // Writeable
      const account5 = aBondingCurve; // Writeable
      const account6 = new PublicKey(tokenAccountPubKey); // Writeable
      const account7 = wallet; // Writeable & Signer & Fee Payer
      const account8 = new PublicKey(SYSTEM_PROGAM_ID); // Program
      const account9 = new PublicKey(TOKEN_PROGRAM_ID); // Program
      const account10 = new PublicKey(SYSVAR_RENT_ID);
      const account11 = idkThisOne;
      const account12 = pump;

      // Example usage:
      const amountData = await this.calculateBuyAmount(
        bondingCurve,
        buyAmountLamports,
      );
      let amount: any = amountData * 10 ** pumpDecimals;
      amount = amount.toFixed(0);
      console.log('Amount = ', amount);

      const maxSolCost = (buyAmountLamports + buyAmountLamports * 0.15).toFixed(
        0,
      );
      console.log('maxSolCost ', maxSolCost);
      const transactionBuffer = this.encodeTransaction(amount, maxSolCost);

      const swapIn = new TransactionInstruction({
        programId: pump,
        keys: [
          {
            pubkey: account1,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account2,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: account3,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account4,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: account5,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: account6,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: account7,
            isSigner: true,
            isWritable: true,
          },
          {
            pubkey: account8,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account9,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account10,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account11,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: account12,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: transactionBuffer,
      });

      const txFee = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 0.001 * LAMPORTS_PER_SOL,
      });

      const trx = new Transaction().add(txFee).add(ataIx).add(swapIn);

      trx.feePayer = wallet;
      let blockhashObj = await this.connection.getLatestBlockhash('finalized');
      let latestBlockhash = blockhashObj.blockhash;
      trx.recentBlockhash = latestBlockhash;

      const message1 = new TransactionMessage({
        payerKey: trx.feePayer,
        recentBlockhash: trx.recentBlockhash,
        instructions: trx.instructions,
      }).compileToV0Message();

      const swaptx = new VersionedTransaction(message1);

      swaptx.sign([payer]);

      // Simulate and potentially send the transaction
      try {
        const simulationResult = await this.connection.simulateTransaction(
          swaptx,
          {
            commitment: 'processed',
          },
        );
        console.log(simulationResult);

        if (simulationResult.value.err) {
          console.error(
            'Simulation error for transaction:',
            simulationResult.value.err,
          );
        } else {
          console.log('Simulation success for transaction. Logs:');
          simulationResult.value.logs?.forEach((log) => console.log(log));

          // Send the transaction if simulation succeeds
          console.log('Going to BUY');
          jitoTxId = await this.jitoService.send_bundle(swaptx);
        }
      } catch (error) {
        console.error('Error during simulation:', error);
      }

      return jitoTxId;
    } catch (error) {
      console.log(error);
      throw new Error(error.message);
    }
  }

  async convertTokenToWSOLForVolume(
    contract_addresses: string,
    keypair: Keypair,
  ) {
    let jitoTxId = '';
    const PUMP_PUBLIC_KEY = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
    const pump = new PublicKey(PUMP_PUBLIC_KEY);

    const url = `https://frontend-api.pump.fun/coins/${contract_addresses}`;

    const response = await axios.get(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive',
      },
    });

    if (response.status !== 200) {
      console.log(`Error: ${response.status}`);
      return;
    } else {
      console.log(`Success: ${response.status}`);
    }

    const mint = new PublicKey(contract_addresses);

    console.log(`Processing wallet: ${keypair.publicKey}\n`);

    const payer = keypair;
    const wallet = new PublicKey(keypair.publicKey);

    const tokenAccount = await this.createATA(mint.toBase58(), keypair);
    const tokenAccountPubKey = tokenAccount.ata;

    const ataIx = tokenAccount.ataIX;

    console.log(tokenAccountPubKey);

    // fetch balance of wallet
    let walletBalance = await this.connection.getBalance(wallet);

    if (walletBalance < 0) {
      console.log('Wallet SOL balance too low, skipping.');
      return;
    }

    const data = response.data;
    const bCurve = data.bonding_curve;
    const aCurve = data.associated_bonding_curve;
    const virtualSolReserves = data.virtual_sol_reserves;
    const virtualTokenReserves = data.virtual_token_reserves;

    const bondingCurve = new PublicKey(bCurve);
    const aBondingCurve = new PublicKey(aCurve);

    let sellAmount;
    try {
      sellAmount = await this.connection.getTokenAccountBalance(
        new PublicKey(tokenAccountPubKey),
      );
    } catch (error) {
      return;
    }
    let sellAmountLamports = sellAmount.value.amount;
    sellAmount = sellAmount.value.uiAmount;

    if (sellAmount <= 0) {
      console.log('Token balance too low (empty), skipping.\n');
      return;
    }

    const SYSTEM_PROGAM_ID = '11111111111111111111111111111111';
    const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const global = new PublicKey(
      '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
    );
    const feeRecipient = new PublicKey(
      'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
    );

    const account1 = global;
    const account2 = feeRecipient; // Writeable
    const account3 = mint;
    const account4 = bondingCurve; // Writeable
    const account5 = aBondingCurve; // Writeable
    const account6 = new PublicKey(tokenAccountPubKey); // Writeable
    const account7 = wallet; // Writeable & Signer & Fee Payer
    const account8 = new PublicKey(SYSTEM_PROGAM_ID); // Program
    const account9 = new PublicKey(
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    ); // Program
    const account10 = new PublicKey(TOKEN_PROGRAM_ID);
    const account11 = new PublicKey(
      'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
    );
    const account12 = new PublicKey(
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    ); // Program

    const pricePer = virtualSolReserves / virtualTokenReserves / 1000;

    let slippage = 1 - 0.5;

    let minSolOutput: any = null;
    minSolOutput = parseFloat((sellAmount * pricePer).toString());
    minSolOutput = parseInt((minSolOutput * slippage * 1e9).toString());

    console.log(`Selling ${sellAmount} tokens for ${minSolOutput / 1e9} SOL`);

    const sell = BigInt('12502976635542562355');
    const amount = BigInt(sellAmountLamports);
    const min_sol_output = BigInt(minSolOutput);

    const integers = [sell, amount, min_sol_output];

    const binary_segments = integers.map((integer) => {
      const buffer = Buffer.alloc(8);
      buffer.writeBigUInt64LE(integer);
      return buffer;
    });

    const transactionBuffer = Buffer.concat(binary_segments);

    const swapOut = new TransactionInstruction({
      programId: pump,
      keys: [
        {
          pubkey: account1,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: account2,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: account3,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: account4,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: account5,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: account6,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: account7,
          isSigner: true,
          isWritable: true,
        },
        {
          pubkey: account8,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: account9,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: account10,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: account11,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: account12,
          isSigner: false,
          isWritable: false,
        },
      ],
      data: transactionBuffer,
    });

    const txFee = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 0.001 * LAMPORTS_PER_SOL,
    });

    const trx = new Transaction().add(txFee).add(ataIx).add(swapOut);

    trx.feePayer = wallet;
    let blockhashObj = await this.connection.getLatestBlockhash('finalized');
    let latestBlockhash = blockhashObj.blockhash;
    trx.recentBlockhash = latestBlockhash;

    const message1 = new TransactionMessage({
      payerKey: trx.feePayer,
      recentBlockhash: trx.recentBlockhash,
      instructions: trx.instructions,
    }).compileToV0Message();

    const swaptx = new VersionedTransaction(message1);

    swaptx.sign([payer]);

    // Simulate and potentially send the transaction
    try {
      const simulationResult = await this.connection.simulateTransaction(
        swaptx,
        {
          commitment: 'processed',
        },
      );
      console.log(simulationResult);

      if (simulationResult.value.err) {
        console.error(
          'Simulation error for transaction:',
          simulationResult.value.err,
        );
      } else {
        console.log('Simulation success for transaction. Logs:');
        simulationResult.value.logs?.forEach((log) => console.log(log));

        // Send the transaction if simulation succeeds
        jitoTxId = await this.jitoService.send_bundle(swaptx);

        // console.log(`Transaction ID: https://solscan.io/tx/${txid}`);
        console.log(
          "To improve performance, we will not programatically confirm TX's please check solscan.",
        );
      }
      return jitoTxId;
    } catch (error) {
      console.error('Error during simulation:', error);
    }

    return '';
  }

  async pumpTheVolumeUp(body) {
    try {
      const keypairs = this.loadKeypairsFromVolumeDir();
      const cycles = keypairs.length;
      const totalAmount = body.total_amount;
      // const amountToBuy = this.distributeAmount(totalAmount, cycles);
      const ca = body.contract_address;
      const delay = body.delay;

      for (let i = 0; i < cycles; i++) {
        const amountToBuy = Math.random() * totalAmount;
        console.log('Wallet Address: ', keypairs[i].publicKey.toBase58());
        console.log('Amount to Buy = ', amountToBuy);
        console.log('Random Amount to Check ', Math.random() * totalAmount);

        await this.convertWSOLToTokenForVolume(ca, keypairs[i], amountToBuy);
        await this.sleep(delay);
        console.log('--------------');
      }
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async pumpTheVolumeDown(body) {
    try {
      const keypairs = this.loadKeypairsFromVolumeDir();
      const cycles = keypairs.length;
      // const amountToBuy = this.distributeAmount(totalAmount, cycles);
      const ca = body.contract_address;
      const delay = body.delay;

      for (let i = 0; i < cycles; i++) {
        console.log('Wallet Address: ', keypairs[i].publicKey.toBase58());
        await this.convertTokenToWSOLForVolume(ca, keypairs[i]);
        await this.sleep(delay);
        console.log('---------------------');
      }
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async runTheVolumeOperation(body) {
    try {
      const wallets = this.loadKeypairsFromVolumeDir();
      const totalAmount = body.amount_to_use;
      const ca = body.contract_address;
      while (true) {
        // Infinite loop to continue operations indefinitely
        const operationType =
          this.buyArray.length === 0
            ? 'buy'
            : Math.random() > 0.5
            ? 'buy'
            : 'sell';

        const walletIndex =
          operationType === 'buy'
            ? Math.floor(Math.random() * wallets.length)
            : this.buyArray[Math.floor(Math.random() * this.buyArray.length)];

        const selectedWallet = wallets[walletIndex];
        let jitoTxId;
        let buyPrice;

        if (operationType === 'buy') {
          buyPrice = Math.random() * totalAmount; // Random buy price
          jitoTxId = await this.convertWSOLToTokenForVolume(
            ca,
            wallets[walletIndex],
            buyPrice,
          );
          this.buyArray.push(walletIndex); // Store the index of the wallet that performs buy
          console.log(`Wallet ${walletIndex} bought at price ${buyPrice}`);
        } else {
          const sellPrice = Math.random(); // Random sell price
          jitoTxId = await this.convertTokenToWSOLForVolume(
            ca,
            wallets[walletIndex],
          );
          this.buyArray = this.buyArray.filter(
            (index) => index !== walletIndex,
          ); // Remove the wallet index from buyArray after selling
          console.log(`Wallet ${walletIndex} sold at price ${sellPrice}`);
        }
        await this.saveTransactionDetails(
          selectedWallet.publicKey.toString(),
          jitoTxId,
          operationType === 'buy' ? buyPrice : '',
          'volume',
        );
        console.log('jitoTxId ', jitoTxId);
        await this.sleep(1000); // Delay between operations, adjust as necessary
      }
    } catch (error) {
      console.error('Error in runOperation:', error);
      throw new Error(error.message);
    }
  }

  async saveTransactionDetails(walletPublicKey, jitoTxId, amount, type) {
    const filePath = path.join('transactionDetails.json');
    console.log('filePath ', filePath);
    const transaction = {
      walletPublicKey,
      jitoTxId,
      amount,
      type,
      date: new Date().toISOString(),
    };

    try {
      let transactions = [];
      if (fs.existsSync(filePath)) {
        const data = await fs.promises.readFile(filePath, 'utf8');
        transactions = JSON.parse(data);
      }
      transactions.push(transaction);
      await fs.promises.writeFile(
        filePath,
        JSON.stringify(transactions, null, 2),
        'utf8',
      );
    } catch (err) {
      console.error('Error handling the JSON file:', err);
    }
  }

  async getTransactionCount() {
    const filePath = path.join('transactionDetails.json');

    try {
      if (fs.existsSync(filePath)) {
        const data = await fs.promises.readFile(filePath, 'utf8');
        const transactions = JSON.parse(data);
        return transactions.length;
      } else {
        console.log('No transactions file found.');
        return 0;
      }
    } catch (err) {
      console.error('Error reading the transactions file:', err);
      return 0; // Return 0 in case of an error.
    }
  }

  async preaperWallets() {
    try {
      const bumper = Keypair.generate();
      const bumperFilename = `bumper-${bumper.publicKey.toString()}.json`;
      const bumperFilePath = path.join(this.mainWalletDir, bumperFilename);
      fs.writeFileSync(
        bumperFilePath,
        JSON.stringify(Array.from(bumper.secretKey)),
      );
      console.log(`Bumper Wallet Public Key: ${bumper.publicKey.toString()}`);
      console.log(
        `Bumper Wallet Private Key: ${bs58.encode(bumper.secretKey)}\n`,
      );

      const pfun = Keypair.generate();
      const pfunFilename = `pfun-${pfun.publicKey.toString()}.json`;
      const pfunFilePath = path.join(this.mainWalletDir, pfunFilename);
      fs.writeFileSync(
        pfunFilePath,
        JSON.stringify(Array.from(pfun.secretKey)),
      );
      console.log(`Pfun Wallet Public Key: ${pfun.publicKey.toString()}`);
      console.log(`Pfun Wallet Private Key: ${bs58.encode(pfun.secretKey)}\n`);

      const volume = Keypair.generate();
      const volumeFilename = `volume-${volume.publicKey.toString()}.json`;
      const volumeFilePath = path.join(this.mainWalletDir, volumeFilename);
      fs.writeFileSync(
        volumeFilePath,
        JSON.stringify(Array.from(volume.secretKey)),
      );
      console.log(`Volume Wallet Public Key: ${volume.publicKey.toString()}`);
      console.log(
        `Volume Wallet Private Key: ${bs58.encode(volume.secretKey)}\n`,
      );

      const dev = Keypair.generate();
      const devFilename = `dev-${dev.publicKey.toString()}.json`;
      const devFilePath = path.join(this.mainWalletDir, devFilename);
      fs.writeFileSync(devFilePath, JSON.stringify(Array.from(dev.secretKey)));
      console.log(`Dev Wallet Public Key: ${dev.publicKey.toString()}`);
      console.log(`Dev Wallet Private Key: ${bs58.encode(dev.secretKey)}\n`);

      return;
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async getfreezeAuthority(token) {
    try {
      const tokenDetails = await getMint(this.connection, new PublicKey(token));
      return tokenDetails.freezeAuthority?.toString();
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async getMintAuthority(token) {
    try {
      // const tokenDetails = await getMint(this.connection, new PublicKey(token));
      const mintAccountInfo = await this.connection.getParsedAccountInfo(
        new PublicKey(token),
      );
      // Check if the mint authority is null
      const mintAuthority =
        mintAccountInfo.value.data.parsed.info.mintAuthority;
      return mintAuthority;
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async getTokenHolders(mintAddress: string) {
    try {
      const mintPublicKey = new PublicKey(mintAddress);
      const mintInfo = await getMint(this.connection, mintPublicKey);
      let totalHoldings = 0;
      const tokenSupply = mintInfo.supply;
      const largestAccounts = await this.connection.getTokenLargestAccounts(
        mintPublicKey,
      );

      const holders = [];
      for (const accountInfo of largestAccounts.value) {
        const accountDetail = await getAccount(
          this.connection,
          accountInfo.address,
        );
        const balance = accountDetail.amount;
        const percentage = (Number(balance) / Number(tokenSupply)) * 100;
        totalHoldings += Number(percentage.toFixed(4));
        holders.push({
          address: accountInfo.address.toBase58(), // Token account address
          owner: accountDetail.owner.toBase58(), // Owner's wallet address
          balance: balance.toString(), // Keep as string to avoid precision issues
          percentage: Number(percentage.toFixed(4)), // Format percentage to 4 decimal places
        });
      }
      // this.saveToJson({
      //   tokenMintAddress: mintAddress,
      //   totalHoldings,
      //   holders,
      // });
      const majorHolders = holders.filter((holder) => holder.percentage > 80);
      return {
        totalHolders: holders.length,
        areHoldersMoreThan90: totalHoldings,
        isHolderMoreThan90: majorHolders.length > 0,
      };
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async getTokenHoldersWithRetry(
    mintAddress: string,
    attempts: number = 3,
    delay: number = 1000,
  ) {
    try {
      const { totalHolders, areHoldersMoreThan90, isHolderMoreThan90 } =
        await this.getTokenHolders(mintAddress);
      return { totalHolders, areHoldersMoreThan90, isHolderMoreThan90 };
    } catch (error) {
      if (attempts > 0) {
        console.log(
          `Attempt to get token holders amount failed, ${attempts} retries left. Error: ${error.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay)); // Exponential backoff
        return this.getTokenHoldersWithRetry(
          mintAddress,
          attempts - 1,
          delay * 2,
        );
      } else {
        throw new Error(
          'Failed to get Token Holders after several attempts: ' +
            error.message,
        );
      }
    }
  }

  async getTokenHoldersList(mintAddress: string) {
    try {
      const mintPublicKey = new PublicKey(mintAddress);
      const mintInfo = await getMint(this.connection, mintPublicKey);
      let totalHoldings = 0;
      const tokenSupply = mintInfo.supply;
      const largestAccounts = await this.connection.getTokenLargestAccounts(
        mintPublicKey,
      );

      const holders = await Promise.all(
        largestAccounts.value.map(async (accountInfo) => {
          const accountDetail = await getAccount(
            this.connection,
            accountInfo.address,
          );
          const balance = accountDetail.amount;
          const percentage = (Number(balance) / Number(tokenSupply)) * 100;
          totalHoldings += Number(percentage.toFixed(4));
          return {
            address: accountInfo.address.toBase58(), // Token account address
            owner: accountDetail.owner.toBase58(), // Owner's wallet address
            balance: balance.toString(), // Keep as string to avoid precision issues
            percentage: Number(percentage.toFixed(4)), // Format percentage to 4 decimal places
          };
        }),
      );
      // Filter to find holders with more than 80% of token supply
      // this.saveToJson({
      //   tokenMintAddress: mintAddress,
      //   totalHoldings,
      //   holders,
      // });
      return { totalHoldings, holders };
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async getOwnerOfSPLToken(token) {
    try {
      console.log('tokenMintAddress : ', token.tokenMintAddress);
      const tokenMintPublicKey = new PublicKey(token.tokenMintAddress);
      const metadataPDA = PublicKey.findProgramAddressSync(
        [
          Buffer.from('metadata'),
          METADATA_PROGRAM_ID.toBuffer(),
          tokenMintPublicKey.toBuffer(),
        ],
        METADATA_PROGRAM_ID,
      );

      const accountInfo = await this.connection.getAccountInfo(metadataPDA[0]);
      if (!accountInfo) {
        throw new Error('Metadata account not found');
      }

      const metadata = Metadata.deserialize(accountInfo.data);
      const creators = metadata[0].data.creators;

      if (!creators || creators.length === 0) {
        throw new Error('No creators found in metadata');
      }

      return creators;
    } catch (error) {
      console.log(error);
      throw new Error(error.message);
    }
  }

  saveToJson(data, filename = this.tokenLiquidityLogsPath) {
    let existingData = [];

    // Check if the file exists
    if (fs.existsSync(filename)) {
      // Read the existing data
      const fileContent = fs.readFileSync(filename, 'utf8');
      existingData = JSON.parse(fileContent);
    }

    // Add the new data as a new object in the array
    existingData.push({
      checkedAt: new Date(),
      tokenMintAddress: data.tokenMintAddress,
      totalHoldings: data.totalHoldings,
      holders: data.holders,
    });

    // Write the updated data back to the file
    fs.writeFileSync(filename, JSON.stringify(existingData, null, 2), 'utf8');
  }
}

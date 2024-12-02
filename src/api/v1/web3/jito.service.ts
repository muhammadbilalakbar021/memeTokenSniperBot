import { Inject, Injectable, forwardRef } from '@nestjs/common';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { SearcherClient } from 'jito-ts/dist/sdk/block-engine/searcher';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types';
import { isError } from 'jito-ts/dist/sdk/block-engine/utils';
import { ClientReadableStream } from '@grpc/grpc-js';
import { buildSimpleTransaction } from '@raydium-io/raydium-sdk';
import { BundleResult } from 'jito-ts/dist/gen/block-engine/bundle';
import { BN, Wallet } from '@coral-xyz/anchor';
import * as bs58 from 'bs58';
import { ConfigService } from '../../../config/config.service';
import { TxVersion } from '@raydium-io/raydium-sdk-v2';
import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher';
import axios from 'axios';
import { Web3Service } from './web3.service';
import { getExplorerLink } from '@solana-developers/helpers';
import { RadiumService } from './radium.service';

const MEMO_PROGRAM_ID = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';

@Injectable()
export class JitoService {
  connection: Connection;
  wallet: Wallet;
  // define these
  blockEngineUrl = 'amsterdam.mainnet.block-engine.jito.wtf';
  lookupTableCache = {};
  makeTxVersion = TxVersion.V0; // LEGACY
  addLookupTableInfo = undefined; // only mainnet. other = undefined

  constructor(
    private readonly config: ConfigService,
    @Inject(forwardRef(() => Web3Service))
    private readonly web3Service: Web3Service,
    private readonly radiumService: RadiumService,
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

  async build_bundle(
    search: SearcherClient,
    // accounts: PublicKey[],
    // regions: string[],
    bundleTransactionLimit: number,
    tx1: VersionedTransaction,
    tx2: VersionedTransaction,
  ) {
    const _tipAccount = await this.getJitoTipAccount(search);
    console.log('tip account:', _tipAccount);
    const tipAccount = new PublicKey(_tipAccount);

    const bund = new Bundle([], bundleTransactionLimit);
    const resp = await this.connection.getLatestBlockhash('processed');

    if (tx1 instanceof VersionedTransaction) {
      bund.addTransactions(tx1);
    }

    if (tx2 instanceof VersionedTransaction) {
      bund.addTransactions(tx2);
    }

    let maybeBundle = bund.addTipTx(
      this.wallet.payer,
      400000,
      tipAccount,
      resp.blockhash,
    );

    if (isError(maybeBundle)) {
      throw maybeBundle;
    }
    console.log();

    try {
      const response_bund = await search.sendBundle(maybeBundle);
      return response_bund.toString();
    } catch (e) {
      console.error('error sending bundle:', e);
      return '';
    }
  }

  async send_bundle(tx1: VersionedTransaction) {
    this.blockEngineUrl = this.getBlockEngineURL();
    console.log('BLOCK_ENGINE_URL:', this.blockEngineUrl);
    const bundleTransactionLimit = parseInt('3');

    const search = searcherClient(this.blockEngineUrl);
    await this.getNextTickLeader(search);

    const _tipAccount = await this.getJitoTipAccount(search);
    console.log('tip account:', _tipAccount);
    const tipAccount = new PublicKey(_tipAccount);

    const bund = new Bundle([], bundleTransactionLimit);
    const resp = await this.connection.getLatestBlockhash('processed');

    bund.addTransactions(tx1);

    let maybeBundle = bund.addTipTx(
      this.wallet.payer,
      0.001 * LAMPORTS_PER_SOL,
      tipAccount,
      resp.blockhash,
    );

    if (isError(maybeBundle)) {
      throw maybeBundle;
    }
    console.log();

    try {
      const response_bund = await search.sendBundle(maybeBundle);
      console.log(`Swap with BundleID ${response_bund} sent.`);

      return response_bund.toString();
    } catch (e) {
      console.error('error sending bundle:', e);
      return '';
    }
  }

  async getBundleStatus(bundleId: any) {
    const requestBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getBundleStatuses',
      params: [[bundleId]],
    };

    while (true) {
      try {
        const response = await axios.post(this.getJITOApi(), requestBody);
        if (
          response.data &&
          response.data.result &&
          response.data.result.value &&
          response.data.result.value.length > 0
        ) {
          const bundleInfo = response.data.result.value[0];
          // Check the confirmation status
          if (bundleInfo?.confirmation_status === 'confirmed') {
            console.log('Bundle ID: ' + bundleInfo.bundle_id);
            console.log(
              'Bundle confirmed in ' +
              bundleInfo.slot +
              ' and Status: ' +
              bundleInfo.confirmation_status,
            );
            bundleInfo.transactions.map((transaction) => {
              console.log(
                'Transaction Hash ' +
                getExplorerLink('transaction', transaction, 'mainnet-beta'),
              );
            });
            console.log('Bundle processing confirmed, stopping polling.');
            return bundleInfo;
          } else {
            console.log('Bundle not confirmed yet, continuing polling...');
          }
        } else {
          console.error('No valid data received from the bundle status API');
        }
      } catch (error) {
        console.error('Error requesting bundle status:', error);
        throw error;
      }

      // Wait for 1 second before the next request
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  buildMemoTransaction(
    keypair: Keypair,
    recentBlockhash: string,
    message: string,
  ) {
    const ix = new TransactionInstruction({
      keys: [
        {
          pubkey: keypair.publicKey,
          isSigner: true,
          isWritable: true,
        },
      ],
      programId: new PublicKey(MEMO_PROGRAM_ID),
      data: Buffer.from(message),
    });

    const instructions = [ix];

    const messageV0 = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: recentBlockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);

    tx.sign([keypair]);

    return tx;
  }

  async getJitoTipAccount(search) {
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
      return (await search.getTipAccounts())[0];
    }
  }

  getBlockEngineURL() {
    const endpoints = [
      'mainnet.block-engine.jito.wtf',
      'amsterdam.mainnet.block-engine.jito.wtf',
      'frankfurt.mainnet.block-engine.jito.wtf',
      'ny.mainnet.block-engine.jito.wtf',
      'tokyo.mainnet.block-engine.jito.wtf',
    ];
    return endpoints[1];
  }

  getJITOApi() {
    const endpoints = [
      'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
      'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
      'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
      'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
      'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
    ];
    return endpoints[1];
  }

  async getNextTickLeader(search: SearcherClient) {
    let isLeaderSlot = false;

    while (!isLeaderSlot) {
      try {
        const nextLeader = await search.getNextScheduledLeader();
        const numSlots = nextLeader.nextLeaderSlot - nextLeader.currentSlot;
        isLeaderSlot = numSlots <= 2;

        console.log(
          `Next Jito leader slot in ${numSlots} slots. Current Slot: ${nextLeader.currentSlot} and next Leader: ${nextLeader.nextLeaderSlot}`,
        );
      } catch (error) {
        console.error('Error fetching next scheduled leader:', error);
        throw error;
      }

      if (!isLeaderSlot) {
        await this.web3Service.sleep(500);
      }
    }
  }
}

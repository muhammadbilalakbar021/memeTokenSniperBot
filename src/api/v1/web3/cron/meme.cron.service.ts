import { Web3Service } from '../web3.service';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { RadiumService } from '../radium.service';
import { JitoService } from '../jito.service';
import { ConfigService } from '../../../../config/config.service';
import { MemeTokenService } from '../memetoken.service';

@Injectable()
export class MemeTokenCron {
  private readonly logger = new Logger(MemeTokenCron.name);
  private readonly logFilePath = './tokenPriceLogs.txt'; // Specify the log file path
  private readonly solTradeAmount = 3;

  seenSignatures: Set<string> = new Set();
  tokenArray: any = [];
  isOneSaved: number = 0;

  private connection: Connection;
  private readonly RAYDIUM_PUBLIC_KEY =
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
  private readonly raydium = new PublicKey(this.RAYDIUM_PUBLIC_KEY);
  private processedSignatures: Set<string> = new Set();

  constructor(
    private readonly web3Service: Web3Service,
    private readonly radiumService: RadiumService,
    private readonly jitoService: JitoService,
    private readonly configService: ConfigService,
    private readonly memeTokenService: MemeTokenService,
  ) { }

  // @Cron(CronExpression.EVERY_10_SECONDS)
  async checkTokensForConversion() {
    try {
      if (this.tokenArray.length > 0) {
        const pricePromises = this.tokenArray.map(async (token) => {
          return await this.radiumService.getTheTokenPrice(
            token.solanaAddress,
            token.tokenMintAddress,
            token.lpPairAddress,
            token.buyPrice,
          );
        });

        const prices = await Promise.all(pricePromises);
        prices.forEach((price, index) => {
          this.comparePrices(price, this.tokenArray[index], index);
        });
      }
    } catch (error) {
      console.log(error);
      throw new Error('Error while converting Tokens: ' + error.message);
    }
  }

  onModuleInit() {
    // this.logger.log('Initializing SolanaService...');
    // this.connection = new Connection(this.configService.RPC_URL, {
    //   wsEndpoint: 'wss://api.mainnet-beta.solana.com',
    // });
    // this.runProgram().catch((error) =>
    //   this.logger.error('Error in runProgram', error),
    // );
  }

  onModuleDestroy() {
    this.logger.log('Destroying SolanaService...');
    // Perform any necessary cleanup here
  }

  async main() {
    this.logger.log('Monitoring logs...', this.raydium.toString());
    this.connection.onLogs(
      this.raydium,
      ({ logs, err, signature }) => {
        if (err) return;
        if (
          logs &&
          logs.some(
            (log) =>
              log.includes('initialize2') &&
              !this.processedSignatures.has(signature),
          )
        ) {
          this.processedSignatures.add(signature);
          this.logger.log('Signature for Initialize2:', signature);
          this.fetchRaydiumAccounts(signature).catch((error) =>
            this.logger.error('Error in fetchRaydiumAccounts', error),
          );
        }
      },
      'finalized',
    );
  }

  async fetchRaydiumAccounts(signature: string) {
    const txId = signature;
    const tx: any = await this.connection.getParsedTransaction(txId, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    const accounts = tx?.transaction?.message?.instructions.find(
      (ix) => ix.programId.toBase58() === this.RAYDIUM_PUBLIC_KEY,
    )?.accounts;

    if (!accounts) {
      this.logger.log('No accounts were found in the transaction.');
      return;
    }

    // Extracting relevant accounts based on their indexes
    const tokenAIndex = 8;
    const tokenBIndex = 9;
    const tokenAAccount = accounts[tokenAIndex].toBase58();
    const tokenBAccount = accounts[tokenBIndex].toBase58();
    const pair = accounts[4].toBase58();

    // Log the discovery of tokens
    this.logger.log('Tokens and pair identified in the transaction.');

    // Filtering out tokens associated with the excluded token
    const excludedToken = 'So11111111111111111111111111111111111111112';
    const filterTokens = (tokenA: string, tokenB: string): string | null => {
      return tokenA.includes(excludedToken)
        ? tokenB
        : tokenA.includes(excludedToken)
          ? null
          : tokenA;
    };
    const toSaveToken = filterTokens(tokenAAccount, tokenBAccount);

    // Log the URL for transaction exploration
    this.logger.log(
      `Transaction details can be viewed at: ${this.generateExplorerUrl(txId)}`,
    );

    // Retrieve token metadata
    const tokenDetails = await this.radiumService.getTokenMetadataFromMetaplex(
      toSaveToken,
    );
    if (toSaveToken.includes('pump')) {
      this.logger.error(
        `Token identified as a potential Pump-and-Dump token with mint: ${toSaveToken}.`,
      );
      await this.logToFile(
        `Token identified as a potential Pump-and-Dump token with mint: ${toSaveToken}.`,
      );
      await this.memeTokenService.addToken(
        tokenDetails,
        toSaveToken,
        pair,
        0,
        0,
        0,
        0,
        0,
        0,
        '',
        'PumpToken',
        false,
      );
      return;
    }

    // Check if the token is frozen
    const isTokenFreezed = await this.web3Service.getfreezeAuthority(
      toSaveToken,
    );
    if (isTokenFreezed) {
      this.logger.error(
        `Token is frozen; trading halted for ${toSaveToken} with authority: ${isTokenFreezed}.`,
      );
      await this.logToFile(
        `Token is frozen; trading halted for ${toSaveToken} with authority: ${isTokenFreezed}.`,
      );
      await this.memeTokenService.addToken(
        tokenDetails,
        toSaveToken,
        pair,
        0,
        0,
        0,
        0,
        0,
        0,
        '',
        'FrozenToken',
        false,
      );
      return;
    }

    this.logger.verbose(
      `Token ${toSaveToken} is active and eligible for trading.`,
    );

    // Log the token's details including expected trading amounts and liquidity
    const { amountOut, minAmountOut, liquidityAvailable } =
      await this.retrieveTokenTradingDetails(toSaveToken, pair);
    this.logger.log(
      `Token Address: ${toSaveToken}, Minimum Get: ${minAmountOut}, Maximum Get: ${amountOut}, Liquidity Available: ${liquidityAvailable}`,
    );

    // Decision based on liquidity
    if (liquidityAvailable < 2000) {
      this.logger.warn(
        `Insufficient liquidity (${liquidityAvailable}) to proceed with the transaction.`,
      );
      await this.logToFile(
        `Insufficient liquidity (${liquidityAvailable}) availbe for token ${toSaveToken} to proceed with the transaction.`,
      );
      await this.memeTokenService.addToken(
        tokenDetails,
        toSaveToken,
        pair,
        0,
        0,
        0,
        0,
        0,
        0,
        '',
        `${liquidityAvailable} liquidity`,
        false,
      );
      return;
    }

    // Process potential buying
    if (this.isOneSaved <= 100) {
      this.isOneSaved += 1;
      const { boughtTokens, mightGotTokens, jitoId } =
        await this.radiumService.buyTokenWithRetry(
          toSaveToken,
          pair,
          this.solTradeAmount,
        );
      this.logger.log(
        `Token purchase initiated for ${toSaveToken}. Bought ${boughtTokens} tokens with potential for ${mightGotTokens} tokens.`,
      );
      await this.logToFile(
        `Token purchase details: ${toSaveToken}, Bought Tokens: ${mightGotTokens}, Potential Tokens: ${boughtTokens}, Jito ID: ${jitoId}`,
      );

      this.tokenArray.push({
        tokenName: tokenDetails.tokenName,
        tokenSymbol: tokenDetails.tokenSymbol,
        tokenDecimals: tokenDetails.decimals,
        tokenMintAddress: toSaveToken,
        solanaAddress: 'So11111111111111111111111111111111111111112',
        lpPairAddress: pair,
        buyPrice: this.solTradeAmount,
        minGet: minAmountOut,
        maxGet: amountOut,
        liquidityAvailable: liquidityAvailable,
        tokenBuyInSol: this.solTradeAmount,
        minboughtTokens: Number(boughtTokens),
        maxboughtTokens: Number(mightGotTokens),
        buyJitoId: jitoId,
      });

      await this.memeTokenService.addToken(
        tokenDetails,
        toSaveToken,
        pair,
        this.solTradeAmount,
        minAmountOut,
        amountOut,
        liquidityAvailable,
        boughtTokens,
        mightGotTokens,
        jitoId,
        '',
        true,
      );

      return;
    } else {
      this.logger.log(
        `Observation limit reached with ${this.isOneSaved} tokens currently monitored.`,
      );
    }
  }

  async retrieveTokenTradingDetails(toSaveToken: string, pair: string) {
    try {
      return await this.radiumService.getTheTokenPrice(
        'So11111111111111111111111111111111111111112',
        toSaveToken,
        pair,
        this.solTradeAmount,
      );
    } catch (error) {
      this.logger.error(
        `Failed to retrieve trading details for ${toSaveToken}, attempting again.`,
      );
      return await this.radiumService.getTheTokenPrice(
        'So11111111111111111111111111111111111111112',
        toSaveToken,
        pair,
        this.solTradeAmount,
      );
    }
  }

  async comparePrices(newPrice: any, savedToken: any, index: number) {
    const { amountOut, minAmountOut, liquidityAvailable } = newPrice;

    // Calculate percentage changes
    const changeInMinGet =
      ((minAmountOut - savedToken.minboughtTokens) /
        savedToken.minboughtTokens) *
      100;
    const changeInMaxGet =
      ((amountOut - savedToken.maxboughtTokens) / savedToken.maxboughtTokens) *
      100;

    this.logger.log(`Token Address: ${savedToken.tokenMintAddress}`);
    this.logger.log(
      `Previous Minimum Get: ${savedToken.minboughtTokens}, Updated Minimum Get: ${minAmountOut}`,
    );
    this.logger.log(
      `Previous Maximum Get: ${savedToken.maxboughtTokens}, Updated Maximum Get: ${amountOut}`,
    );
    this.logger.log(`Updated Liquidity Availability: ${liquidityAvailable}`);
    this.logger.log(`Change in Minimum Get: ${changeInMinGet.toFixed(2)}%`);
    this.logger.log(`Change in Maximum Get: ${changeInMaxGet.toFixed(2)}%`);

    // Build a comprehensive and formal log entry
    const logEntries = [
      `Token Address: ${savedToken.tokenMintAddress}`,
      `Previous Minimum Get: ${savedToken.minboughtTokens}, Updated Minimum Get: ${minAmountOut}`,
      `Previous Maximum Get: ${savedToken.maxboughtTokens}, Updated Maximum Get: ${amountOut}`,
      `Updated Liquidity Availability: ${liquidityAvailable}`,
      `Change in Minimum Get: ${changeInMinGet.toFixed(2)}%`,
      `Change in Maximum Get: ${changeInMaxGet.toFixed(2)}%`,
    ];

    // Determine the change and append the result to the log entries
    if (changeInMinGet > 0) {
      this.logger.log(
        `Decrease in value observed for token ${savedToken.tokenMintAddress}.`,
      );
      await this.logToFile(
        `Decrease in value observed for token ${savedToken.tokenMintAddress}.`,
      );
      if (Number(liquidityAvailable) < 1000) {
        this.logger.log(
          `Decrease in liquidy observed for token ${savedToken.tokenMintAddress} as now liquidity is ${liquidityAvailable}. Going to sell the tokens`,
        );
        await this.logToFile(
          `Decrease in liquidy observed for token ${savedToken.tokenMintAddress} as now liquidity is ${liquidityAvailable}. Going to sell the tokens`,
        );
        try {
          const { mightGotTokens, boughtTokens, jitoId } =
            await this.radiumService.sellTokenWithRetry(savedToken);
          this.tokenArray.splice(index, 1);
          await this.memeTokenService.updateToken(
            savedToken.tokenMintAddress,
            boughtTokens,
            mightGotTokens,
            jitoId,
            changeInMinGet.toFixed(2),
            liquidityAvailable,
            `Decrease in liquidy observed for token ${savedToken.tokenMintAddress} as now liquidity is ${liquidityAvailable}. Going to sell the tokens`,
            false,
          );
          this.logger.log(
            `Token swapped details: ${savedToken.tokenMintAddress}, Bought Tokens: ${mightGotTokens}, Potential Tokens: ${boughtTokens}, Jito ID: ${jitoId}`,
          );
          await this.logToFile(
            `Token swapped details: ${savedToken.tokenMintAddress}, Bought Tokens: ${mightGotTokens}, Potential Tokens: ${boughtTokens}, Jito ID: ${jitoId}`,
          );
        } catch (error) {
          await this.memeTokenService.updateToken(
            savedToken.tokenMintAddress,
            0,
            0,
            '',
            changeInMinGet.toFixed(2),
            liquidityAvailable,
            'Unable to sell token',
            false,
          );
          this.logger.log(`Unable to sell the token ; Tried 3 Times.`);
          await this.logToFile(`Unable to sell the token ; Tried 3 Times.`);
        }
      }
      if (Math.abs(changeInMinGet) > 50) {
        try {
          const { mightGotTokens, boughtTokens, jitoId } =
            await this.radiumService.sellTokenWithRetry(savedToken);
          this.tokenArray.splice(index, 1);
          await this.memeTokenService.updateToken(
            savedToken.tokenMintAddress,
            boughtTokens,
            mightGotTokens,
            jitoId,
            changeInMinGet.toFixed(2),
            liquidityAvailable,
            `Sold because the token decrease to ${changeInMinGet}`,
            false,
          );
          this.logger.log(
            `Token swapped details: ${savedToken.tokenMintAddress}, Bought Tokens: ${mightGotTokens}, Potential Tokens: ${boughtTokens}, Jito ID: ${jitoId}`,
          );
          await this.logToFile(
            `Token swapped details: ${savedToken.tokenMintAddress}, Bought Tokens: ${mightGotTokens}, Potential Tokens: ${boughtTokens}, Jito ID: ${jitoId}`,
          );
          this.logger.log(
            `Significant decrease noted; executed sell order with retry.`,
          );
          await this.logToFile(
            `Significant decrease noted; executed sell order with retry.`,
          );
        } catch (error) {
          await this.memeTokenService.updateToken(
            savedToken.tokenMintAddress,
            0,
            0,
            '',
            changeInMinGet.toFixed(2),
            liquidityAvailable,
            'Unable to sell token',
            false,
          );
          this.logger.log(`Unable to sell the token ; Tried 3 Times.`);
          await this.logToFile(`Unable to sell the token ; Tried 3 Times.`);
        }
      }
      this.logger.log('--------------------------------');
    } else if (changeInMinGet < 0) {
      this.logger.log(
        `Increase in value observed for token ${savedToken.tokenMintAddress}.`,
      );
      await this.logToFile(
        `Increase in value observed for token ${savedToken.tokenMintAddress}.`,
      );
      if (Math.abs(changeInMinGet) > 2) {
        try {
          const { mightGotTokens, boughtTokens, jitoId } =
            await this.radiumService.sellTokenWithRetry(savedToken);
          this.tokenArray.splice(index, 1);
          await this.memeTokenService.updateToken(
            savedToken.tokenMintAddress,
            boughtTokens,
            mightGotTokens,
            jitoId,
            changeInMinGet.toFixed(2),
            liquidityAvailable,
            `Token swapped details: ${savedToken.tokenMintAddress}, Bought Tokens: ${mightGotTokens}, Potential Tokens: ${boughtTokens}, Jito ID: ${jitoId}`,
            false,
          );
          this.logger.log(
            `Token swapped details: ${savedToken.tokenMintAddress}, Bought Tokens: ${mightGotTokens}, Potential Tokens: ${boughtTokens}, Jito ID: ${jitoId}`,
          );
          await this.logToFile(
            `Token swapped details: ${savedToken.tokenMintAddress}, Bought Tokens: ${mightGotTokens}, Potential Tokens: ${boughtTokens}, Jito ID: ${jitoId}`,
          );
          this.logger.log(
            `Significant increase noted; executed sell order with retry.`,
          );
          await this.logToFile(
            `Significant increase noted; executed sell order with retry.`,
          );
        } catch (error) {
          await this.memeTokenService.updateToken(
            savedToken.tokenMintAddress,
            0,
            0,
            '',
            changeInMinGet.toFixed(2),
            liquidityAvailable,
            'Unable to sell token',
            false,
          );
          this.logger.log(`Unable to sell the token ; Tried 3 Times.`);
          await this.logToFile(`Unable to sell the token ; Tried 3 Times.`);
        }
      }
      this.logger.log('--------------------------------');
    } else {
      this.logger.log(
        `No significant change in value for token ${savedToken.tokenMintAddress}.`,
      );
      await this.logToFile(
        `No significant change in value for token ${savedToken.tokenMintAddress}.`,
      );
      this.logger.log('--------------------------------');
    }

    // Combine all log entries into a single string to be logged and saved
    const finalLogEntry = logEntries.join(', ');

    // Save the log entry to a file
    await this.logToFile(finalLogEntry);
  }

  generateExplorerUrl(txId: string): string {
    return `https://solscan.io/tx/${txId}?cluster=mainnet`;
  }

  async runProgram() {
    try {
      this.tokenArray = await this.memeTokenService.getRadiumTokens();
      await this.main();
    } catch (error) {
      this.logger.error('Error occurred:', error);
      this.logger.log('Restarting the program...');
      await this.sleep(2000);
      this.runProgram();
    }
  }

  sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Logs a message with a timestamp to a specified log file.
   * If the file does not exist, it will be created.
   * Each log entry is appended on a new line.
   * @param message The message to log.
   */
  async logToFile(message: string): Promise<void> {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} - ${message}\n`; // Create a formatted log entry

    try {
      return;
      return await fs.promises.appendFile(this.logFilePath, logEntry, 'utf-8');
      // console.log('Log entry added to file successfully.');
    } catch (error) {
      console.error('Failed to log to file:', error);
    }
  }
}

interface Token {
  tokenName?: string;
  tokenAddress?: string;
  tokenDecimals?: number;
  tokenMintAddress?: string;
  solanaAddress?: string;
  lpPairAddress?: string;
  buyPrice?: number;
  minGet?: number;
  maxGet?: number;
  liquidityAvailable?: number;
  minboughtTokens?: number;
  maxboughtTokens?: number;
  buyJitoId?: string;
  buyTimestamp?: any;
  buyTime?: any;
  minsoldTokens?: number;
  maxsoldTokens?: number;
  soldJitoId?: string;
  sellTimestamp?: number;
  sellTime?: string;
  reason?: string;
  profit?: string;
  liquidityAvailableAtSellTime?: string;
}

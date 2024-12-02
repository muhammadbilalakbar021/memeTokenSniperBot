import { Web3Service } from '../web3.service';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Connection, PublicKey } from '@solana/web3.js';
import { RadiumService } from '../radium.service';
import { JitoService } from '../jito.service';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigService } from '../../../../config/config.service';
import { GainerTokenService } from '../gainertoken.service';

@Injectable()
export class GainerTokenCron {
  private readonly logger = new Logger(GainerTokenCron.name);
  private readonly logFilePath = './logs/confirmed_gainer_logs.txt'; // Specify the log file path
  private readonly tokensFilePath = './logs/gainer_tokens.json'; // Specify the log file path
  private readonly solTradeAmount = 3;

  private connection: Connection;
  private readonly RAYDIUM_PUBLIC_KEY =
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
  private readonly raydium = new PublicKey(this.RAYDIUM_PUBLIC_KEY);
  private processedSignatures: Set<string> = new Set();
  seenSignatures: Set<string> = new Set();
  gainerTokens: any = [];
  isOneSaved: number = 0;

  constructor(
    private readonly web3Service: Web3Service,
    private readonly configService: ConfigService,
    private readonly radiumService: RadiumService,
    private readonly gainerTokenService: GainerTokenService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async checkTokensForNewLiquidity() {
    try {
      // Fetching the tokens that are expected to gain in the future
      this.gainerTokens = await this.gainerTokenService.getFutureGainerTokens();

      // Process each token one by one
      for (const token of this.gainerTokens) {
        await this.gainerTokenService.updateTokenData(token);
        // await this.addToken(tokendetails); // Ensure token is added after its data is updated
      }
    } catch (error) {
      console.log(error);
      throw new Error('Error while converting Tokens: ' + error.message);
    }
  }

  @Cron(CronExpression.EVERY_5_SECONDS)
  async checkTokensForProminentGainers() {
    try {
      // Fetching the tokens that are expected to gain in the future
      this.gainerTokens =
        await this.gainerTokenService.checkTokensForProminentGainers();
      const now = Date.now(); // Current time in milliseconds
      const threeHoursAgo = now - 3 * 60 * 60 * 1000;
      // Process each token one by one
      for (const token of this.gainerTokens) {
        if (
          token.pairCreatedAt &&
          token.pairCreatedAt < threeHoursAgo &&
          token.liquidity_usd > 200000
        ) {
          console.log('Token', token);
          await this.gainerTokenService.gainerFound(token);
        }
        // await this.addToken(tokendetails); // Ensure token is added after its data is updated
      }
    } catch (error) {
      console.log(error);
      throw new Error('Error while converting Tokens: ' + error.message);
    }
  }

  onModuleInit() {
    this.logger.verbose('Initializing Shit Coin Service...');
    this.connection = new Connection(this.configService.RPC_URL, {
      wsEndpoint: 'wss://api.mainnet-beta.solana.com',
    });
  }

  onModuleDestroy() {
    this.logger.verbose('Destroying Gainer Service...');
    // Perform any necessary cleanup here
  }

  generateExplorerUrl(txId: string): string {
    return `https://solscan.io/tx/${txId}?cluster=mainnet`;
  }

  sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async logHelper(text: string) {
    this.logger.verbose(text);
    // await this.logToFile(text);
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
      return await fs.promises.appendFile(this.logFilePath, logEntry, 'utf-8');
      // console.log('Log entry added to file successfully.');
    } catch (error) {
      console.error('Failed to log to file:', error);
    }
  }

  async loadTokens() {
    try {
      const data = await fs.promises.readFile(this.tokensFilePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // If the file does not exist, create it with an empty array
        console.log('File not found, creating new file.');
        await fs.promises.writeFile(this.tokensFilePath, JSON.stringify([]));
        return [];
      } else {
        // Handle other types of errors
        console.error('Failed to read from file:', error);
        return [];
      }
    }
  }

  async addToken(tokenDetails: any) {
    // Load the existing tokens from the file
    const tokenArray = await this.loadTokens();
    const now = new Date();
    const checkTimeStanp = now.getTime(); // Unix timestamp in milliseconds
    const checkTime = `${now.getHours()}:${now
      .getMinutes()
      .toString()
      .padStart(2, '0')}`; // Formatted time string "hour:minute"

    // Create a new token object based on the detailed structure provided
    const newToken = {
      chainId: tokenDetails.chainId,
      dexId: tokenDetails.dexId,
      url: tokenDetails.url,
      pairAddress: tokenDetails.pairAddress,
      baseToken: {
        address: tokenDetails.baseToken.address,
        name: tokenDetails.baseToken.name,
        symbol: tokenDetails.baseToken.symbol,
      },
      quoteToken: {
        address: tokenDetails.quoteToken.address,
        name: tokenDetails.quoteToken.name,
        symbol: tokenDetails.quoteToken.symbol,
      },
      priceNative: tokenDetails.priceNative,
      priceUsd: tokenDetails.priceUsd,
      txns: tokenDetails.txns,
      volume: tokenDetails.volume,
      priceChange: tokenDetails.priceChange,
      liquidity: tokenDetails.liquidity,
      fdv: tokenDetails.fdv,
      pairCreatedAt: tokenDetails.pairCreatedAt,
      checkTimeStanp,
      checkTime,
    };

    // Push the new token into the token array
    tokenArray.push(newToken);

    // Write the updated array back to the file system
    await fs.promises.writeFile(
      this.tokensFilePath,
      JSON.stringify(tokenArray, null, 2),
    );
  }
}

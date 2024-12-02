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
import { GainerTokenService } from '../gainertoken.service';

@Injectable()
export class FutureGainersTokenCron {
  private readonly logger = new Logger(FutureGainersTokenCron.name);
  private readonly logFilePath = './tokenPriceLogs.txt'; // Specify the log file path
  private readonly solTradeAmount = 3;
  private readonly profitPercent = 5;
  private readonly lossPercent = 2;
  private readonly minLiquidity = 100000;

  seenSignatures: Set<string> = new Set();
  tokenArray: any = [];
  gainerArray: any = [];
  isOneSaved: number = 0;

  private connection: Connection;
  private readonly RAYDIUM_PUBLIC_KEY =
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
  private readonly raydium = new PublicKey(this.RAYDIUM_PUBLIC_KEY);
  private processedSignatures: Set<string> = new Set();
  private isModuleRunning: boolean = false;

  constructor(
    private readonly web3Service: Web3Service,
    private readonly radiumService: RadiumService,
    private readonly jitoService: JitoService,
    private readonly configService: ConfigService,
    private readonly memeTokenService: MemeTokenService,
    private readonly gainerTokenService: GainerTokenService,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async buyFutureGainers() {
    if (this.isModuleRunning) return; // Prevent concurrent executions
    this.isModuleRunning = true;

    try {
      this.tokenArray = await this.gainerTokenService.getFutureGainers();
      const currentTime = new Date(); // Get the current time

      const tasks = this.tokenArray.map(async (token) => {
        const createdAt = new Date(token.createdAt); // Convert token creation time to Date object
        const { totalHolders, areHoldersMoreThan90, isHolderMoreThan90 } =
          await this.web3Service.getTokenHoldersWithRetry(
            token.tokenMintAddress,
          );

        if (totalHolders.length === 0) return; // Skip the token if totalHolders length is zero

        if (!isHolderMoreThan90) {
          const { boughtTokens, mightGotTokens, jitoId } =
            await this.radiumService.buyTokenWithRetry(
              token.tokenMintAddress,
              token.lpPairAddress,
              this.solTradeAmount,
            );

          await this.gainerTokenService.addFutureGainerBuy({
            id: token._id,
            tokenName: token.tokenName,
            tokenMintAddress: token.tokenMintAddress,
            solanaAddress: token.solanaAddress,
            lpPairAddress: token.lpPairAddress,
            minGet: boughtTokens,
            maxGet: mightGotTokens,
            buyJitoId: jitoId,
            liquidityAvailable: token.liquidityAvailable,
          });

          this.logger.log(
            `Token purchase initiated for ${token.tokenMintAddress}. Bought ${boughtTokens} tokens with potential for ${mightGotTokens} tokens.`,
          );
        } else if (isHolderMoreThan90) {
          await this.gainerTokenService.updateTokenForMoreThan90Holders(
            token._id,
          );
        }
      });

      await Promise.all(tasks); // Wait for all tasks to complete
    } catch (error) {
      this.logger.error(`Error in buyFutureGainers: ${error.message}`);
    } finally {
      this.isModuleRunning = false;
    }
  }

  @Cron(CronExpression.EVERY_5_SECONDS)
  async checkTokensForConversion() {
    try {
      const gainerArray = await this.gainerTokenService.getBoughtGainers();
      if (gainerArray.length > 0) {
        const pricePromises = gainerArray.map((token) =>
          this.radiumService.getTheTokenPrice(
            token.tokenMintAddress,
            'So11111111111111111111111111111111111111112',
            token.lpPairAddress,
            this.solTradeAmount,
          ),
        );

        const prices = await Promise.all(pricePromises);
        await Promise.all(
          prices.map((price, index) =>
            this.comparePrices(price, gainerArray[index], index),
          ),
        );
      }
    } catch (error) {
      console.error('Error while converting Tokens:', error);
      throw new Error('Error while converting Tokens: ' + error.message);
    }
  }

  onModuleInit() {
    this.logger.log('Initializing SolanaService...');
    this.connection = new Connection(this.configService.RPC_URL, {
      wsEndpoint: 'wss://api.mainnet-beta.solana.com',
    });
  }

  onModuleDestroy() {
    this.logger.log('Destroying SolanaService...');
    // Perform any necessary cleanup here
  }

  async comparePrices(newPrice: any, savedToken: any, index: number) {
    try {
      const { amountOut, minAmountOut, liquidityAvailable } = newPrice;
      // Calculate percentage changes
      const changeInMinGet =
        ((minAmountOut - savedToken.minGet) / savedToken.minGet) * 100;
      const changeInMaxGet =
        ((amountOut - savedToken.maxGet) / savedToken.maxGet) * 100;

      this.logger.log(`Token Address: ${savedToken.tokenMintAddress}`);
      this.logger.log(
        `Previous Minimum Get: ${savedToken.minGet}, Updated Minimum Get: ${minAmountOut}`,
      );
      this.logger.log(
        `Previous Maximum Get: ${savedToken.maxGet}, Updated Maximum Get: ${amountOut}`,
      );
      this.logger.log(`Updated Liquidity Availability: ${liquidityAvailable}`);
      this.logger.log(`Change in Minimum Get: ${changeInMinGet.toFixed(2)}%`);
      this.logger.log(`Change in Maximum Get: ${changeInMaxGet.toFixed(2)}%`);

      // Build a comprehensive and formal log entry
      const logEntries = [
        `Token Address: ${savedToken.tokenMintAddress}`,
        `Previous Minimum Get: ${savedToken.minGet}, Updated Minimum Get: ${minAmountOut}`,
        `Previous Maximum Get: ${savedToken.maxGet}, Updated Maximum Get: ${amountOut}`,
        `Updated Liquidity Availability: ${liquidityAvailable}`,
        `Change in Minimum Get: ${changeInMinGet.toFixed(2)}%`,
        `Change in Maximum Get: ${changeInMaxGet.toFixed(2)}%`,
      ];

      // Determine the change and append the result to the log entries
      if (changeInMinGet > 0) {
        this.logger.log(
          `Decrease in value observed for token ${savedToken.tokenMintAddress}.`,
        );
        // await this.logToFile(
        //   `Decrease in value observed for token ${savedToken.tokenMintAddress}.`,
        // );
        if (Number(liquidityAvailable) < this.minLiquidity) {
          this.logger.log(
            `Decrease in liquidy observed for token ${savedToken.tokenMintAddress} as now liquidity is ${liquidityAvailable}. Going to sell the tokens`,
          );
          // await this.logToFile(
          //   `Decrease in liquidy observed for token ${savedToken.tokenMintAddress} as now liquidity is ${liquidityAvailable}. Going to sell the tokens`,
          // );
          try {
            const { mightGotTokens, boughtTokens, jitoId } =
              await this.radiumService.sellTokenWithRetry(savedToken);
            this.tokenArray.splice(index, 1);
            await this.gainerTokenService.completeTrade({
              id: savedToken._id,
              minSold: boughtTokens,
              maxSold: mightGotTokens,
              sellJitoId: jitoId,
              profit: changeInMinGet.toFixed(2),
              liquidityAtSell: liquidityAvailable,
              reason: `Decrease in liquidy observed for token ${savedToken.tokenMintAddress} as now liquidity is ${liquidityAvailable}. Going to sell the tokens`,
            });
            this.logger.log(
              `Token swapped details: ${savedToken.tokenMintAddress}, Bought Tokens: ${mightGotTokens}, Potential Tokens: ${boughtTokens}, Jito ID: ${jitoId}`,
            );
            // await this.logToFile(
            //   `Token swapped details: ${savedToken.tokenMintAddress}, Bought Tokens: ${mightGotTokens}, Potential Tokens: ${boughtTokens}, Jito ID: ${jitoId}`,
            // );
          } catch (error) {
            this.logger.log(`Unable to sell the token ; Tried 3 Times.`);
            await this.gainerTokenService.completeTrade({
              id: savedToken._id,
              minSold: 0,
              maxSold: 0,
              sellJitoId: 'jitoId',
              profit: changeInMinGet.toFixed(2),
              liquidityAtSell: liquidityAvailable,
              reason: `Unable to sell the token ; Tried 3 Times.`,
            });
            // await this.logToFile(`Unable to sell the token ; Tried 3 Times.`);
          }
        }
        if (Math.abs(changeInMinGet) > this.lossPercent) {
          try {
            const { mightGotTokens, boughtTokens, jitoId } =
              await this.radiumService.sellTokenWithRetry(savedToken);
            await this.gainerTokenService.completeTrade({
              id: savedToken._id,
              minSold: boughtTokens,
              maxSold: mightGotTokens,
              sellJitoId: jitoId,
              profit: changeInMinGet.toFixed(2),
              liquidityAtSell: liquidityAvailable,
              reason: `Sold because the token decrease to ${changeInMinGet}`,
            });

            this.logger.log(
              `Token swapped details: ${savedToken.tokenMintAddress}, Bought Tokens: ${mightGotTokens}, Potential Tokens: ${boughtTokens}, Jito ID: ${jitoId}`,
            );
            // await this.logToFile(
            //   `Token swapped details: ${savedToken.tokenMintAddress}, Bought Tokens: ${mightGotTokens}, Potential Tokens: ${boughtTokens}, Jito ID: ${jitoId}`,
            // );
            this.logger.log(
              `Significant decrease noted; executed sell order with retry.`,
            );
            // await this.logToFile(
            //   `Significant decrease noted; executed sell order with retry.`,
            // );
          } catch (error) {
            this.logger.log(`Unable to sell the token ; Tried 3 Times.`);
            // await this.logToFile(`Unable to sell the token ; Tried 3 Times.`);
            await this.gainerTokenService.completeTrade({
              id: savedToken._id,
              minSold: 0,
              maxSold: 0,
              sellJitoId: 'jitoId',
              profit: changeInMinGet.toFixed(2),
              liquidityAtSell: liquidityAvailable,
              reason: `Unable to sell the token ; Tried 3 Times.`,
            });
          }
        }
        this.logger.log('--------------------------------');
      } else if (changeInMinGet < 0) {
        this.logger.log(
          `Increase in value observed for token ${savedToken.tokenMintAddress}.`,
        );
        // await this.logToFile(
        //   `Increase in value observed for token ${savedToken.tokenMintAddress}.`,
        // );
        if (Math.abs(changeInMinGet) > this.profitPercent) {
          try {
            const { mightGotTokens, boughtTokens, jitoId } =
              await this.radiumService.sellTokenWithRetry(savedToken);
            await this.gainerTokenService.completeTrade({
              id: savedToken._id,
              minSold: boughtTokens,
              maxSold: mightGotTokens,
              sellJitoId: jitoId,
              profit: changeInMinGet.toFixed(2),
              liquidityAtSell: liquidityAvailable,
              reason: `Token swapped details: ${savedToken.tokenMintAddress}, Bought Tokens: ${mightGotTokens}, Potential Tokens: ${boughtTokens}, Jito ID: ${jitoId}`,
            });

            this.logger.log(
              `Token swapped details: ${savedToken.tokenMintAddress}, Bought Tokens: ${mightGotTokens}, Potential Tokens: ${boughtTokens}, Jito ID: ${jitoId}`,
            );
            // await this.logToFile(
            //   `Token swapped details: ${savedToken.tokenMintAddress}, Bought Tokens: ${mightGotTokens}, Potential Tokens: ${boughtTokens}, Jito ID: ${jitoId}`,
            // );
            this.logger.log(
              `Significant increase noted; executed sell order with retry.`,
            );
            // await this.logToFile(
            //   `Significant increase noted; executed sell order with retry.`,
            // );
          } catch (error) {
            this.logger.log(`Unable to sell the token ; Tried 3 Times.`);
            await this.gainerTokenService.completeTrade({
              id: savedToken._id,
              minSold: 0,
              maxSold: 0,
              sellJitoId: 'jitoId',
              profit: changeInMinGet.toFixed(2),
              liquidityAtSell: liquidityAvailable,
              reason: `Unable to sell the token ; Tried 3 Times.`,
            });
            // await this.logToFile(`Unable to sell the token ; Tried 3 Times.`);
          }
        }
        this.logger.log('--------------------------------');
      } else {
        this.logger.log(
          `No significant change in value for token ${savedToken.tokenMintAddress}.`,
        );
        // await this.logToFile(
        //   `No significant change in value for token ${savedToken.tokenMintAddress}.`,
        // );
        this.logger.log('--------------------------------');
      }

      await this.gainerTokenService.updateProfit(
        savedToken._id,
        changeInMinGet.toFixed(2),
      );

      // Combine all log entries into a single string to be logged and saved
      const finalLogEntry = logEntries.join(', ');

      // Save the log entry to a file
      // await this.logToFile(finalLogEntry);
    } catch (error) {
      console.log('Error while comparing ', error.message);
    }
  }

  generateExplorerUrl(txId: string): string {
    return `https://solscan.io/tx/${txId}?cluster=mainnet`;
  }

  sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

import { Injectable, Logger } from '@nestjs/common';
import { Connection, Keypair } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import * as bs58 from 'bs58';
import { ConfigService } from '../../../config/config.service';
import { TxVersion } from '@raydium-io/raydium-sdk-v2';
import { InjectModel } from '@nestjs/mongoose';
import { GainerTokenEntity, GainerTokenDocument } from './entity/gainer.entity';
import { ShitTokenEntity, ShitTokenDocument } from './entity/shittoken.entity';
import * as notifier from 'node-notifier';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Model as MongooseModel } from 'mongoose';
import axios from 'axios';

const MEMO_PROGRAM_ID = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';

@Injectable()
export class GainerTokenService {
  private readonly logger = new Logger(GainerTokenService.name);
  private readonly liquidityCheckValue = 100000;
  connection: Connection;
  wallet: Wallet;
  constructor(
    private readonly config: ConfigService,
    @InjectModel(ShitTokenEntity.name)
    private readonly shitTokenModel: MongooseModel<ShitTokenDocument>,
    @InjectModel(GainerTokenEntity.name)
    private readonly gainerTokenModel: MongooseModel<GainerTokenDocument>,
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

  async getUndraftedTokens() {
    try {
      return await this.shitTokenModel.find({ isValid: true, isGainer: false });
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async getFutureGainerTokens() {
    try {
      return await this.shitTokenModel.find({
        isValid: true,
        isGainer: true,
        isComfirmedGainer: false,
      });
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async checkTokensForProminentGainers() {
    try {
      return await this.shitTokenModel.find({
        isValid: true,
        isGainer: true,
        isComfirmedGainer: false,
      });
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async addToken(
    tokenDetails: any,
    toSaveToken: string,
    pair: string,
    toBuyTokensForSolAmount: number,
    minAmountToOut: number,
    amountToOut: number,
    totalLiquidityAvailable: number,
    reason: string,
    isValid: boolean,
  ) {
    return await this.shitTokenModel.create({
      tokenName: tokenDetails.tokenName,
      tokenSymbol: tokenDetails.tokenSymbol,
      tokenDecimals: tokenDetails.decimals,
      tokenMintAddress: toSaveToken,
      solanaAddress: 'So11111111111111111111111111111111111111112',
      lpPairAddress: pair,
      buyPrice: toBuyTokensForSolAmount,
      minGet: minAmountToOut,
      maxGet: amountToOut,
      liquidityFound: totalLiquidityAvailable,
      liquidityAvailable: totalLiquidityAvailable,
      maxLiquidity: totalLiquidityAvailable,
      minLiquidity: totalLiquidityAvailable,
      reason: reason,
      recievedAt: `${new Date().getHours()}:${new Date()
        .getMinutes()
        .toString()
        .padStart(2, '0')}`,
      isValid: isValid,
      wasFutureGainer:
        totalLiquidityAvailable > this.liquidityCheckValue ? true : false,
      createdAt: new Date(),
    });
  }

  async updateToken(mintId, liquidityAvailable, reason = '', isValid = true) {
    try {
      const now = new Date(); // Get the current date and time
      const checkTimestamp = now.getTime(); // Unix timestamp in milliseconds

      // Format the date and time into a single string
      const checkTime = `${now.getFullYear()}-${(now.getMonth() + 1)
        .toString()
        .padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')} ${now
        .getHours()
        .toString()
        .padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
      liquidityAvailable > this.liquidityCheckValue
        ? notifier.notify({
            title: `Mint Id ${mintId}`,
            message: `Token has reacehed Liquidity ${liquidityAvailable}`,
          })
        : '';
      return await this.shitTokenModel.updateOne(
        { tokenMintAddress: mintId },
        {
          liquidityAvailable,
          reason,
          isValid: liquidityAvailable < 10000 ? false : true,
          isGainer:
            liquidityAvailable > this.liquidityCheckValue ? true : false,
          liquidityWentToZeroAt: liquidityAvailable < 10000 ? checkTime : '',
        },
      );
    } catch (error) {
      this.logger.error(`Error updating token: ${error.message}`);
    }
  }

  async updatePositiveLiquid(mintId, maxLiquidity, reason = '') {
    try {
      const token = await this.shitTokenModel.findOne({
        tokenMintAddress: mintId,
      });
      if (token) {
        if (maxLiquidity > token.maxLiquidity) {
          await this.shitTokenModel.updateOne(
            { tokenMintAddress: mintId },
            {
              maxLiquidity,
              reason,
            },
          );
        } else {
          this.logger.verbose(
            `New maxLiquidity ${maxLiquidity} is not greater than the current value ${token.maxLiquidity}`,
          );
        }
      } else {
        this.logger.error(`Token with mint ID ${mintId} not found`);
      }
    } catch (error) {
      this.logger.error(`Error updating positive liquidity: ${error.message}`);
    }
  }

  async updateNegativeLiquid(mintId, minLiquidity, reason = '') {
    try {
      const token = await this.shitTokenModel.findOne({
        tokenMintAddress: mintId,
      });
      if (token) {
        if (minLiquidity < token.minLiquidity) {
          await this.shitTokenModel.updateOne(
            { tokenMintAddress: mintId },
            {
              minLiquidity,
              reason,
            },
          );
        } else {
          this.logger.verbose(
            `New minLiquidity ${minLiquidity} is not less than the current value ${token.minLiquidity}`,
          );
        }
      } else {
        this.logger.error(`Token with mint ID ${mintId} not found`);
      }
    } catch (error) {
      this.logger.error(`Error updating negative liquidity: ${error.message}`);
    }
  }

  async updateIsValidForOldTokens() {
    try {
      const threeHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

      // Find tokens that meet the criteria
      const tokens = await this.shitTokenModel.find({
        createdAt: { $lt: threeHoursAgo },
        liquidityAvailable: { $lt: 50000 },
        isValid: true,
      });

      if (tokens.length > 0) {
        // Update each token's isValid field to false
        for (const token of tokens) {
          await this.shitTokenModel.updateOne(
            { _id: token._id },
            {
              isValid: false,
              reason:
                'Monitored the token for more than 3 hours and it was a shit token',
              updatedAt: new Date(),
            },
          );
          this.logger.verbose(
            `Updated token ${token.tokenMintAddress} with ID ${token._id}: set isValid to false`,
          );
        }
      } else {
        this.logger.verbose('No tokens found that meet the criteria');
      }
    } catch (error) {
      this.logger.error(
        `Error updating isValid for old tokens: ${error.message}`,
      );
    }
  }

  async getTokenDetails(tokenMintAddress: string) {
    try {
      const token = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${tokenMintAddress}`,
      );
      console.log(token.data);

      return {
        priceNative: token.data.priceNative,
        priceUsd: token.data.priceUsd,
        txns_m5_buys: token.data.txns.m5.buys,
        txns_m5_sells: token.data.txns.m5.sells,
        txns_h1_buys: token.data.txns.h1.buys,
        txns_h1_sells: token.data.txns.h1.sells,
        txns_h6_buys: token.data.txns.h6.buys,
        txns_h6_sells: token.data.txns.h6.sells,
        txns_h24_buys: token.data.txns.h24.buys,
        txns_h24_sells: token.data.txns.h24.sells,
        volume_h24: token.data.volume.h24,
        volume_h6: token.data.volume.h6,
        volume_h1: token.data.volume.h1,
        volume_m5: token.data.volume.m5,
        priceChange_m5: token.data.priceChange.m5,
        priceChange_h1: token.data.priceChange.h1,
        priceChange_h6: token.data.priceChange.h6,
        priceChange_h24: token.data.priceChange.h24,
        liquidity_usd: token.data.liquidity.usd,
        liquidity_base: token.data.liquidity.base,
        liquidity_quote: token.data.liquidity.quote,
        fdv: token.data.fdv,
        pairCreatedAt: token.data.pairCreatedAt,
      };
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async updateTokenData(tokenObject: any) {
    try {
      const token = await this.shitTokenModel.findById(tokenObject._id);
      if (token) {
        const tokenDetails = (
          await axios.get(
            `https://api.dexscreener.com/latest/dex/tokens/${token.tokenMintAddress}`,
          )
        )?.data.pairs[0];
        // Update token with new data
        const now = new Date(); // Get the current date and time
        const checkTimestamp = now.getTime(); // Unix timestamp in milliseconds

        // Format the date and time into a single string
        const checkTime = `${now.getFullYear()}-${(now.getMonth() + 1)
          .toString()
          .padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')} ${now
          .getHours()
          .toString()
          .padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        await this.shitTokenModel.updateOne(
          { _id: tokenObject._id },
          {
            priceNative: tokenDetails.priceNative,
            priceUsd: tokenDetails.priceUsd,
            txns_m5_buys: tokenDetails.txns.m5.buys,
            txns_m5_sells: tokenDetails.txns.m5.sells,
            txns_h1_buys: tokenDetails.txns.h1.buys,
            txns_h1_sells: tokenDetails.txns.h1.sells,
            txns_h6_buys: tokenDetails.txns.h6.buys,
            txns_h6_sells: tokenDetails.txns.h6.sells,
            txns_h24_buys: tokenDetails.txns.h24.buys,
            txns_h24_sells: tokenDetails.txns.h24.sells,
            volume_h24: tokenDetails.volume.h24,
            volume_h6: tokenDetails.volume.h6,
            volume_h1: tokenDetails.volume.h1,
            volume_m5: tokenDetails.volume.m5,
            priceChange_m5: tokenDetails.priceChange.m5,
            priceChange_h1: tokenDetails.priceChange.h1,
            priceChange_h6: tokenDetails.priceChange.h6,
            priceChange_h24: tokenDetails.priceChange.h24,
            liquidity_usd: tokenDetails.liquidity.usd,
            liquidity_base: tokenDetails.liquidity.base,
            liquidity_quote: tokenDetails.liquidity.quote,
            fdv: tokenDetails.fdv,
            pairCreatedAt: tokenDetails.pairCreatedAt,
            isGainer:
              tokenDetails.liquidity.usd < this.liquidityCheckValue
                ? false
                : true,
            // isValid: tokenDetails.liquidity.usd < 90000 ? false : true,
            liquidityAvailable: tokenDetails.liquidity.usd,
            maxLiquidity:
              tokenDetails.liquidity.usd > token.maxLiquidity
                ? tokenDetails.liquidity.usd
                : token.maxLiquidity,
            minLiquidity:
              tokenDetails.liquidity.usd < token.minLiquidity
                ? tokenDetails.liquidity.usd
                : token.minLiquidity,
            isComfirmedGainer: false,
            liquidityWentToZeroAt:
              tokenDetails.liquidity.usd < 10000 ? checkTime : '',
          },
        );
        this.logger.warn(`Token ${tokenObject._id} updated successfully`);
        return tokenDetails;
      } else {
        this.logger.error(`Token with ID ${tokenObject._id} not found`);
      }
    } catch (error) {
      this.logger.error(`Error updating token data: ${error.message}`);
    }
  }

  async gainerFound(token: any) {
    try {
      notifier.notify({
        title: `Gainer Token Found ${token.tokenName}`,
        message: `Token has reacehed ${token.tokenMintAddress} Liquidity ${token.liquidity_usd}`,
      });
      return await this.shitTokenModel.findByIdAndUpdate(
        { _id: token.id },
        {
          isValid: true,
          isGainer: true,
          isComfirmedGainer: true,
        },
      );
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async getFutureGainers() {
    try {
      return await this.shitTokenModel.find({
        wasFutureGainer: true,
        isTokenMoved: false,
        isValid: true,
        isGainer: true,
      });
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async addFutureGainerBuy(tokenDetails: any) {
    try {
      const now = new Date(); // Get the current date and time

      // Format the date and time into a single string
      const checkTime = `${now.getFullYear()}-${(now.getMonth() + 1)
        .toString()
        .padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')} ${now
        .getHours()
        .toString()
        .padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

      await this.gainerTokenModel.create({
        tokenName: tokenDetails.tokenName,
        tokenMintAddress: tokenDetails.tokenMintAddress,
        solanaAddress: tokenDetails.solanaAddress,
        lpPairAddress: tokenDetails.lpPairAddress,
        minGet: tokenDetails.minGet,
        maxGet: tokenDetails.maxGet,
        buyJitoId: 'buyJitoId',
        liquidityAvailable: tokenDetails.liquidityAvailable,
        recievedAt: new Date(),
        boughtAt: checkTime,
      });

      return await this.shitTokenModel.findByIdAndUpdate(
        {
          _id: tokenDetails.id,
        },
        {
          isTokenMoved: true,
        },
      );
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async updateTokenForMoreThan90Holders(id: any) {
    return await this.shitTokenModel.findByIdAndUpdate(
      {
        _id: id,
      },
      {
        isValid: false,
        isTokenMoved: true,
        reason: 'token has a holder for more than 90%',
      },
    );
  }

  async getBoughtGainers() {
    try {
      return await this.gainerTokenModel.find({ isTraded: false });
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async completeTrade(tokenDetails: any) {
    try {
      const now = new Date(); // Get the current date and time

      // Format the date and time into a single string
      const checkTime = `${now.getFullYear()}-${(now.getMonth() + 1)
        .toString()
        .padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')} ${now
        .getHours()
        .toString()
        .padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

      return await this.gainerTokenModel.findByIdAndUpdate(
        {
          _id: tokenDetails.id,
        },
        {
          minSold: tokenDetails.minSold,
          maxSold: tokenDetails.maxSold,
          sellJitoId: 'minSold',
          profit: tokenDetails.profit,
          liquidityAtSell: tokenDetails.liquidityAtSell,
          reason: tokenDetails.reason,
          isTraded: true,
          tradedAt: checkTime,
        },
      );
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async updateProfit(token_id, profit) {
    try {
      const token = await this.gainerTokenModel.findById(token_id);
      return await this.gainerTokenModel.findByIdAndUpdate(
        { _id: token_id },
        {
          maxprofitWent:
            Number(profit) < token.maxprofitWent
              ? Number(profit) < -70
                ? token.maxprofitWent
                : Number(profit)
              : token.maxprofitWent,
        },
      );
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async getAnalytics() {
    try {
      const trades: any = await this.gainerTokenModel.find({
        isTraded: true,
      });
      let profitOnes = 0;
      let lostOnes = 0;
      let maxTotalProfit = 0;
      let minTotalProfit = 0;

      for (let i = 0; i < trades.length; i++) {
        const trade = trades[i];
        const tokendetails = await this.shitTokenModel.findOne({
          tokenMintAddress: trade.tokenMintAddress,
        });

        // Merge tokendetails into trade object
        if (tokendetails) {
          const {
            buyPrice,
            liquidityFound,
            maxLiquidity,
            minLiquidity,
            liquidityWentToZeroAt,
          } = tokendetails;
          trades[i] = {
            ...trade.toObject(),
            buyPrice,
            liquidityFound,
            maxLiquidity,
            minLiquidity,
            liquidityWentToZeroAt,
          };
        }

        // Set the type based on profit condition
        if (Number(trade.profit) < -4 && Number(trade.profit) > -80) {
          trades[i].type = 'profit';
          profitOnes += 1;
          maxTotalProfit = maxTotalProfit + (trade.maxSold - 3);
          minTotalProfit = minTotalProfit + (trade.minSold - 3);
        } else {
          trades[i].type = 'loss';
          lostOnes += 1;
        }
      }

      return {
        profit: profitOnes,
        loss: lostOnes,
        totalMaxProfit: maxTotalProfit,
        totalMinProfit: minTotalProfit,
        trades,
      };
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async prepareDataForCSV() {
    try {
      const trades: any = await this.gainerTokenModel.find({
        isTraded: true,
      });

      const lossTrades = []; // Array to hold only loss trades
      const profitTrades = []; // Array to hold only profit trades

      for (let i = 0; i < trades.length; i++) {
        const trade = trades[i];
        const tokendetails = await this.shitTokenModel.findOne({
          tokenMintAddress: trade.tokenMintAddress,
        });

        // Merge tokendetails into trade object
        if (tokendetails) {
          const {
            buyPrice,
            liquidityFound,
            maxLiquidity,
            minLiquidity,
            liquidityWentToZeroAt,
          } = tokendetails;
          trades[i] = {
            ...trade.toObject(),
            buyPrice,
            liquidityFound,
            maxLiquidity,
            minLiquidity,
            liquidityWentToZeroAt,
          };
        }

        // Set the type based on profit condition
        if (Number(trade.profit) < -4 && Number(trade.profit) > -90) {
          trades[i].type = 'profit';
          profitTrades.push(trades[i]);
        } else {
          trades[i].type = 'loss';
          lossTrades.push(trades[i]); // Add only loss trades to the array
        }
      }

      // Return only the loss trades
      return { lossTrades, profitTrades };
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async saveTradesAsCsv() {
    const analyticsData = await this.prepareDataForCSV(); // Assuming this returns the trade data
    const lossCsvContent = this.convertToCsv(analyticsData.lossTrades);
    const profitCsvContent = this.convertToCsv(analyticsData.profitTrades);

    await this.writeToFile('loss_trades.csv', lossCsvContent);
    await this.writeToFile('profit_trades.csv', profitCsvContent);
  }

  private convertToCsv(trades: any[]): string {
    const headers = 'Token Address,Buy Price,Max Sold,Min Sold,Profit Type\n';
    const rows = trades
      .map((trade) => {
        const { tokenMintAddress, buyPrice, maxSold, minSold, type } = trade;
        return `${tokenMintAddress},${buyPrice},${maxSold},${minSold},${type}`;
      })
      .join('\n');

    return headers + rows;
  }

  private async writeToFile(
    fileName: string,
    csvContent: string,
  ): Promise<void> {
    await fs.writeFile(fileName, csvContent);
    console.log('File has been saved to', fileName);
  }
}

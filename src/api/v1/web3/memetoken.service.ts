import { Injectable, Logger } from '@nestjs/common';
import { Connection, Keypair } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import * as bs58 from 'bs58';
import { ConfigService } from '../../../config/config.service';
import { TxVersion } from '@raydium-io/raydium-sdk-v2';
import { InjectModel } from '@nestjs/mongoose';
import { GainerTokenEntity, GainerTokenDocument } from './entity/gainer.entity';
import { Model as MongooseModel } from 'mongoose';
import { RadiumTokenEntity, RadiumTokenDocument } from './entity/radium.entity';

const MEMO_PROGRAM_ID = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';

@Injectable()
export class MemeTokenService {
  private readonly logger = new Logger(MemeTokenService.name);
  connection: Connection;
  wallet: Wallet;
  // define these
  blockEngineUrl = 'amsterdam.mainnet.block-engine.jito.wtf';
  lookupTableCache = {};
  makeTxVersion = TxVersion.V0; // LEGACY
  addLookupTableInfo = undefined; // only mainnet. other = undefined

  constructor(
    private readonly config: ConfigService,
    @InjectModel(RadiumTokenEntity.name)
    private readonly tokenModel: MongooseModel<RadiumTokenDocument>,
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

  async getRadiumTokens() {
    try {
      return await this.tokenModel.find({ isValid: true });
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
    minboughtTokens: number,
    mightGotTokens: number,
    jitoId: string,
    reason: string,
    isValid: boolean,
  ) {
    return await this.tokenModel.create({
      tokenName: tokenDetails.tokenName,
      tokenAddress: tokenDetails.tokenSymbol,
      tokenDecimals: tokenDetails.decimals,
      tokenMintAddress: toSaveToken,
      solanaAddress: 'So11111111111111111111111111111111111111112',
      lpPairAddress: pair,
      buyPrice: toBuyTokensForSolAmount,
      minGet: minAmountToOut,
      maxGet: amountToOut,
      liquidityAvailable: totalLiquidityAvailable,
      minboughtTokens: minboughtTokens,
      maxboughtTokens: mightGotTokens,
      buyJitoId: jitoId,
      buyTimestamp: new Date().getTime(),
      buyTime: `${new Date().getHours()}:${new Date()
        .getMinutes()
        .toString()
        .padStart(2, '0')}`,
      reason: reason,
      isValid,
    });
  }

  async updateToken(
    mintId: string,
    minsoldTokens: any,
    maxsoldTokens: any,
    soldJitoId: string,
    profit: string,
    liquidityAvailable: string,
    reason: string = '',
    isValid = true,
  ) {
    try {
      return await this.tokenModel.updateOne(
        { tokenMintAddress: mintId },
        {
          liquidityAvailable,
          minsoldTokens: minsoldTokens,
          maxsoldTokens: maxsoldTokens,
          soldJitoId: soldJitoId,
          sellTimestamp: new Date().getTime(), // Get current time in milliseconds
          sellTime: `${new Date().getHours()}:${new Date()
            .getMinutes()
            .toString()
            .padStart(2, '0')}`, // Format time as HH:mm
          profit: profit,
          liquidityAvailableAtSellTime: liquidityAvailable, // Update liquidity available for the token in Jito
          reason,
          isValid,
        },
      );
    } catch (error) {
      this.logger.error(`Error updating token: ${error.message}`);
    }
  }
}

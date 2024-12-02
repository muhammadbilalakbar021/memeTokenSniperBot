import { Document } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export type RadiumTokenDocument = RadiumTokenEntity & Document & { _id?: any };

@Schema({ timestamps: true })
export class RadiumTokenEntity {
  _id?: any;

  @Prop({ required: true })
  tokenName: string;

  @Prop({ required: true })
  tokenAddress: string;

  @Prop({ required: true })
  tokenDecimals: number;

  @Prop({ required: true })
  tokenMintAddress: string;

  @Prop({ required: true })
  solanaAddress: string;

  @Prop({ required: true })
  lpPairAddress: string;

  @Prop({ required: true })
  buyPrice: number;

  @Prop({ required: true })
  minGet: number;

  @Prop({ required: true })
  maxGet: number;

  @Prop({ required: false })
  liquidityFound?: number;

  @Prop({ required: false })
  liquidityAvailable?: number;

  @Prop({ required: false })
  reason: string;

  @Prop({ required: true })
  recievedAt: string;

  @Prop({ required: false })
  maxLiquidity?: number;

  @Prop({ required: false })
  minLiquidity?: number;

  @Prop({ required: false, default: true })
  isValid: boolean;

  @Prop({ required: false, default: new Date() })
  createdAt: Date;
}

export const RadiumTokenSchema =
  SchemaFactory.createForClass(RadiumTokenEntity);

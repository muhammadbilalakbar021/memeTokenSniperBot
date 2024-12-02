import { Document } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export type GainerTokenDocument = GainerTokenEntity & Document & { _id?: any };

@Schema({ timestamps: true })
export class GainerTokenEntity {
  _id?: any;

  @Prop({ required: true })
  tokenName: string;

  @Prop({ required: true })
  tokenMintAddress: string;

  @Prop({ required: true })
  lpPairAddress: string;

  @Prop({ required: true })
  minGet: number;

  @Prop({ required: true })
  maxGet: number;

  @Prop({ required: false })
  boughtAt: string;

  @Prop({ required: true })
  buyJitoId: string;

  @Prop({ required: false })
  liquidityAvailable?: number;

  @Prop({ required: false })
  reason: string;

  @Prop({ required: false })
  sellPrice: number;

  @Prop({ required: false })
  minSold: number;

  @Prop({ required: false })
  maxSold: number;

  @Prop({ required: false })
  sellJitoId: string;

  @Prop({ required: false })
  profit: string;

  @Prop({ required: false, default: 0 })
  maxprofitWent: number;

  @Prop({ required: false })
  liquidityAtSell: string;

  @Prop({ required: true })
  recievedAt: string;

  @Prop({ required: false, default: false })
  isTraded: boolean;

  @Prop({ required: false })
  tradedAt: string;

  @Prop({ required: false, default: new Date() })
  createdAt: Date;
}

export const GainerTokenSchema =
  SchemaFactory.createForClass(GainerTokenEntity);

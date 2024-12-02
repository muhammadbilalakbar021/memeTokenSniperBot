import { Document } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export type TokenDocument = TokenEntity &
  Document & {
    _id?: any;
  };

@Schema({ timestamps: true })
export class TokenEntity {
  _id?: any;

  @Prop({ required: true, default: '' })
  token_name: string;

  @Prop({ required: true, default: '' })
  token_symbol: string;

  @Prop({ required: true, default: '' })
  token_decimal: number;

  @Prop({ required: true, default: '' })
  token_address: string;

  @Prop({ required: true, default: '' })
  lp_pair: string;

  @Prop({ required: false, default: true })
  isValid: boolean;

  @Prop({ required: false, default: new Date() })
  createdAt: Date;
}

export const TokenSchema = SchemaFactory.createForClass(TokenEntity);

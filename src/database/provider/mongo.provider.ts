import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '../../config/config.module';
import { ConfigService } from '../../config/config.service';
import { print } from '../utils/log';
import { JwtEntity, JwtSchema } from '../../api/v1/auth/entity/jwt.entity';
import {
  AccountSchema,
  AccountEntity,
} from '../../api/v1/account/entity/account.entity';
import {
  AdminAccountEntity,
  AdminAccountSchema,
} from '../../api/v1/account/entity/adminAccount.entity';
import {
  TokenEntity,
  TokenSchema,
} from '../../api/v1/web3/entity/token.entity';
import {
  GainerTokenEntity,
  GainerTokenSchema,
} from '../../api/v1/web3/entity/gainer.entity';
import {
  RadiumTokenEntity,
  RadiumTokenSchema,
} from '../../api/v1/web3/entity/radium.entity';
import {
  ShitTokenEntity,
  ShitTokenSchema,
} from '../../api/v1/web3/entity/shittoken.entity';

let MongoDataBaseProvider;
try {
  MongoDataBaseProvider = [
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        uri: configService.MONGO_CLUSTER_URI,
        useNewUrlParser: true,
        useUnifiedTopology: true,
      }),
    }),
    MongooseModule.forFeature([
      { name: AccountEntity.name, schema: AccountSchema },
      { name: JwtEntity.name, schema: JwtSchema },
      { name: AdminAccountEntity.name, schema: AdminAccountSchema },
      { name: TokenEntity.name, schema: TokenSchema },
      { name: GainerTokenEntity.name, schema: GainerTokenSchema },
      { name: RadiumTokenEntity.name, schema: RadiumTokenSchema },
      { name: ShitTokenEntity.name, schema: ShitTokenSchema },
    ]),
  ];
  print('Mongo Db Connected');
} catch (error) {
  print('Mongo Db Not Connected');
}
export default MongoDataBaseProvider;

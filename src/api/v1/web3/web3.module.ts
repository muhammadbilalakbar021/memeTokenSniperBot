import { TwofaModule } from './../2fa/2fa.module';
import {
  forwardRef,
  MiddlewareConsumer,
  Module,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule } from '../../../config/config.module';
import { ConfigService } from '../../../config/config.service';
import { DatabaseModule } from '../../../database/database.module';
import { ResponseService } from '../../../utils/response/response.service';
import { Web3Controller } from './web3.controller';
import { Web3Service } from './web3.service';
import { FutureGainersTokenCron } from './cron/future.gainers.cron.service';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Web3 = require('web3');
import Moralis from 'moralis';
import { SPLService } from './spl.service';
import { RadiumService } from './radium.service';
import { JitoService } from './jito.service';
import { PumpFunService } from './pumpfun.service';
import { ShitTokenCron } from './cron/shit.cron.service';
import { GainerTokenService } from './gainertoken.service';
import { MemeTokenService } from './memetoken.service';
import { GainerTokenCron } from './cron/gainer.cron.service';

@Module({
  imports: [ConfigModule, TwofaModule, DatabaseModule],
  controllers: [Web3Controller],
  providers: [
    Web3Service,
    SPLService,
    RadiumService,
    JitoService,
    ResponseService,
    PumpFunService,
    FutureGainersTokenCron,
    ShitTokenCron,
    GainerTokenService,
    MemeTokenService,
    GainerTokenCron,
    {
      provide: 'SolWeb3',
      useFactory: (config: ConfigService) => {
        return new Web3(new Web3.providers.HttpProvider(config.RPC_URL));
      },
      inject: [ConfigService],
    },
    {
      provide: 'SolMoralis',
      useFactory: (config: ConfigService) => {
        return Moralis.start({
          apiKey: config.MORALIS_PUB_KEY,
          logLevel: 'verbose',
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: [
    Web3Service,
    SPLService,
    RadiumService,
    JitoService,
    PumpFunService,
  ],
})
export class Web3Module {
  // configure(consumer: MiddlewareConsumer) {
  //   consumer.apply(TokenNotExists).forRoutes({
  //     path: 'web3/convertToken/:id',
  //     method: RequestMethod.POST,
  //   });
  // }
}

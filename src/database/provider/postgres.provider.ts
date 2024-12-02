import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '../../config/config.module';
import { ConfigService } from '../../config/config.service';
import { print } from '../utils/log';
import { TypeOrmModule } from '@nestjs/typeorm';

let PostGresDataBaseProvider;
try {
  PostGresDataBaseProvider = [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.POSTGRESS_HOST,
        port: parseInt(configService.POSTGRESS_PORT, 10),
        username: configService.POSTGRESS_USERNAME,
        password: configService.POSTGRESS_PASSWORD,
        database: configService.POSTGRESS_DATABASE,
        synchronize: true,
      }),
    }),
  ];
  print('postgres Db Connected');
} catch (error) {
  print('postgres Db Not Connected');
}
export default PostGresDataBaseProvider;

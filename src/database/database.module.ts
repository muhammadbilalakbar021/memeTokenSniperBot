import { Global, Module } from '@nestjs/common';
import MongoDataBaseProvider from './provider/mongo.provider';
import PostGresDataBaseProvider from './provider/postgres.provider';

@Global()
@Module({
  imports: [...MongoDataBaseProvider],
  exports: [...MongoDataBaseProvider],
})
export class DatabaseModule {}

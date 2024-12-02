import { Injectable, NestMiddleware } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConsoleService } from '../../../../utils/console/console.service';
import { ResponseService } from '../../../../utils/response/response.service';
import { AccountDocument, AccountEntity } from '../entity/account.entity';

@Injectable()
export class accountAlreadyExists implements NestMiddleware {
  constructor(
    private readonly consoleService: ConsoleService,
    @InjectModel(AccountEntity.name)
    private readonly accountModel: Model<AccountDocument>,
    private responseService: ResponseService,
  ) {}
  async use(req: any, res: any, next: () => void) {
    try {
      const doubleCheckAccount = await this.accountModel.findOne({
        address: req?.body?.address,
        isDeleted: false,
      });
      if (doubleCheckAccount) {
        console.log(doubleCheckAccount);
        return this.responseService.dbError('Account already Exists', res);
      }
    } catch (error) {
      this.responseService.serverFailureResponse(error.message, res);
    }
    next();
  }
}
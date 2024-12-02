import { MasterWalletDto } from './dto/masterWallet.dto';
import { Web3Service } from './web3.service';
import { ResponseService } from '../../../utils/response/response.service';
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../../../utils/decorators/public.decorator';
import { swapDto } from './dto/swap.dto';
import { AdminRoleGuard } from '../auth/guard/roles.guard';
import { publicDecrypt } from 'crypto';
import { RadiumService } from './radium.service';
import { SPLService } from './spl.service';
import { JitoService } from './jito.service';
import { PumpFunService } from './pumpfun.service';
import { GainerTokenService } from './gainertoken.service';

@Controller('web3')
export class Web3Controller {
  constructor(
    private readonly responseService: ResponseService,
    private readonly Web3Service: Web3Service,
    private readonly radiumService: RadiumService,
    private readonly splService: SPLService,
    private readonly pumpFunService: PumpFunService,
    private readonly jitoService: JitoService,
    private readonly gainerTokenService: GainerTokenService,
  ) {}

  @Public()
  @Post('mintToken')
  async mintToken(@Body() body: any, @Req() req: any, @Res() res: Response) {
    try {
      this.responseService.successResponse(true, '', res);
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('prepare_wallets')
  async prepare_wallets(
    @Body() body: any,
    @Req() req: any,
    @Res() res: Response,
  ) {
    try {
      this.responseService.successResponse(
        true,
        await this.Web3Service.getTransactionCount(),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('start_bumper_buy')
  async start_buy(@Body() body: any, @Req() req: any, @Res() res: Response) {
    try {
      this.responseService.successResponse(
        true,
        await this.Web3Service.getTheBumperUp(body),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('convert_bumper_token')
  async convertBumperTokenToWSOL(
    @Body() body: any,
    @Req() req: any,
    @Res() res: Response,
  ) {
    try {
      this.responseService.successResponse(
        true,
        await this.Web3Service.convertBumperTokenToWSOL(body),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('start_bumper_sell')
  async retieve_all_bumper(
    @Body() body: any,
    @Req() req: any,
    @Res() res: Response,
  ) {
    try {
      this.responseService.successResponse(
        true,
        await this.Web3Service.getTheBumperDown(body),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('prepare_wallets_for_volume_pfun')
  async prepareWalletsForDump(
    @Body() body: any,
    @Req() req: any,
    @Res() res: Response,
  ) {
    try {
      this.responseService.successResponse(
        true,
        await this.Web3Service.prepareWalletsForVolumePFun(body),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('get_sol_from_volume_wallet')
  async getSolBackFromVolumeWallets(
    @Body() body: any,
    @Req() req: any,
    @Res() res: Response,
  ) {
    try {
      this.responseService.successResponse(
        true,
        await this.Web3Service.getSolFromVolumeWallets(),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('buy_the_pump')
  async buyThePump(@Body() body: any, @Req() req: any, @Res() res: Response) {
    try {
      this.responseService.successResponse(
        true,
        await this.Web3Service.pumpTheVolumeUp(body),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('sell_the_pump')
  async sellTheDump(@Body() body: any, @Req() req: any, @Res() res: Response) {
    try {
      this.responseService.successResponse(
        true,
        await this.Web3Service.pumpTheVolumeDown(body),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('run_the_volume_operation')
  async runTheVolumeOperation(
    @Body() body: any,
    @Req() req: any,
    @Res() res: Response,
  ) {
    try {
      this.responseService.successResponse(
        true,
        await this.Web3Service.runTheVolumeOperation(body),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('create_LUT')
  async createLUT(@Body() body: any, @Req() req: any, @Res() res: Response) {
    try {
      this.responseService.successResponse(
        true,
        await this.pumpFunService.createLUT(),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('extendLUT')
  async extendLUT(@Body() body: any, @Req() req: any, @Res() res: Response) {
    try {
      this.responseService.successResponse(
        true,
        await this.pumpFunService.extendLUT(),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('simulateAndWriteBuys')
  async simulateAndWriteBuys(
    @Body() body: any,
    @Req() req: any,
    @Res() res: Response,
  ) {
    try {
      this.responseService.successResponse(
        true,
        await this.pumpFunService.simulateAndWriteBuys(),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('generateATAandSOL')
  async generateATAandSOL(
    @Body() body: any,
    @Req() req: any,
    @Res() res: Response,
  ) {
    try {
      this.responseService.successResponse(
        true,
        await this.pumpFunService.generateATAandSOL(),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('buyBundle')
  async buyBundle(@Body() body: any, @Req() req: any, @Res() res: Response) {
    try {
      this.responseService.successResponse(
        true,
        await this.pumpFunService.buyBundle(),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('createToken')
  async createToken(@Body() body: any, @Req() req: any, @Res() res: Response) {
    try {
      this.responseService.successResponse(
        true,
        await this.pumpFunService.createToken(),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('sellXPercentagePF')
  async sellXPercentagePF(
    @Body() body: any,
    @Req() req: any,
    @Res() res: Response,
  ) {
    try {
      this.responseService.successResponse(
        true,
        await this.pumpFunService.sellXPercentagePF(),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('createReturns')
  async createReturns(
    @Body() body: any,
    @Req() req: any,
    @Res() res: Response,
  ) {
    try {
      this.responseService.successResponse(
        true,
        await this.pumpFunService.createReturns(),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('buyTokenFromRadium')
  async buyTokenFromRadium(
    @Body() body: any,
    @Req() req: any,
    @Res() res: Response,
  ) {
    try {
      this.responseService.successResponse(
        true,
        await this.radiumService.buyTheTokenFromRadium(
          body.tokenMintAddress,
          body.solanaAddress,
          body.lpPairAddress,
          body.tokenAAmount,
        ),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('sellTokenFromRadium')
  async sellTokenFromRadium(
    @Body() body: any,
    @Req() req: any,
    @Res() res: Response,
  ) {
    try {
      this.responseService.successResponse(
        true,
        await this.radiumService.sellTheTokenFromRadium(
          body.tokenMintAddress,
          body.solanaAddress,
          body.lpPairAddress,
          body.tokenAAmount,
        ),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while sending token.',
        res,
      );
    }
  }

  @Public()
  @Post('getTradeAnalytics')
  async getTradeAnalytics(
    @Body() body: any,
    @Req() req: any,
    @Res() res: Response,
  ) {
    try {
      this.responseService.successResponse(
        true,
        await this.gainerTokenService.getAnalytics(),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while getting trade analytics.',
        res,
      );
    }
  }

  @Public()
  @Post('saveAnalytics')
  async saveAnalytics(
    @Body() body: any,
    @Req() req: any,
    @Res() res: Response,
  ) {
    try {
      this.responseService.successResponse(
        true,
        await this.gainerTokenService.saveTradesAsCsv(),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while getting trade analytics.',
        res,
      );
    }
  }

  @Public()
  @Post('getTokenOwner')
  async getTokenDetails(
    @Body() body: any,
    @Req() req: any,
    @Res() res: Response,
  ) {
    try {
      this.responseService.successResponse(
        true,
        await this.Web3Service.getOwnerOfSPLToken(body),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while getting trade analytics.',
        res,
      );
    }
  }

  @Public()
  @Post('getTokenHolders')
  async getTokenHolders(
    @Body() body: any,
    @Req() req: any,
    @Res() res: Response,
  ) {
    try {
      this.responseService.successResponse(
        true,
        await this.Web3Service.getTokenHoldersList(body.address),
        res,
      );
    } catch (error) {
      return this.responseService.serverFailureResponse(
        typeof error.message == 'string'
          ? error.message
          : 'Some error occurred while getting trade analytics.',
        res,
      );
    }
  }
}

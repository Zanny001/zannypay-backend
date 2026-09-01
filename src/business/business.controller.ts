import { Controller, Get, Post, Body, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BusinessService } from './business.service';
import { ActivateBusinessDto } from './dto/activate-business.dto';

@Controller('business')
@UseGuards(JwtAuthGuard)
export class BusinessController {
  constructor(private readonly businessService: BusinessService) {}

  @Post('activate')
  async activate(@Req() req, @Body() dto: ActivateBusinessDto) {
    const userId = req.user.sub || req.user.userId;
    return this.businessService.activate(userId, dto.businessName);
  }

  @Get('me')
  async getMyBusiness(@Req() req) {
    const userId = req.user.sub || req.user.userId;
    return this.businessService.getMyBusiness(userId);
  }
}

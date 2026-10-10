import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BeneficiariesService } from './beneficiaries.service';
import { CreateBeneficiaryDto } from './dto/create-beneficiary.dto';
import { UpdateBeneficiaryDto } from './dto/update-beneficiary.dto';

@Controller('beneficiaries')
@UseGuards(JwtAuthGuard)
export class BeneficiariesController {
  constructor(private readonly beneficiariesService: BeneficiariesService) {}

  @Get()
  async list(@Req() req) {
    const userId = req.user.sub || req.user.userId;
    return this.beneficiariesService.list(userId);
  }

  @Post()
  async create(@Req() req, @Body() dto: CreateBeneficiaryDto) {
    const userId = req.user.sub || req.user.userId;
    return this.beneficiariesService.create(userId, dto);
  }

  @Patch(':id')
  async update(
    @Req() req,
    @Param('id') id: string,
    @Body() dto: UpdateBeneficiaryDto,
  ) {
    const userId = req.user.sub || req.user.userId;
    return this.beneficiariesService.update(userId, id, dto);
  }

  @Delete(':id')
  async remove(@Req() req, @Param('id') id: string) {
    const userId = req.user.sub || req.user.userId;
    return this.beneficiariesService.remove(userId, id);
  }
}

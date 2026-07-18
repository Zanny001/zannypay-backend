import { Controller, Get, Post, Delete, Body, Param, Req, UseGuards } from '@nestjs/common';
import { BudgetsService } from './budgets.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SetBudgetDto } from './dto/set-budget.dto';

@Controller('budgets')
@UseGuards(JwtAuthGuard)
export class BudgetsController {
  constructor(private readonly budgetsService: BudgetsService) {}

  @Get()
  async getBudgets(@Req() req) {
    const userId = req.user.sub || req.user.userId;
    return this.budgetsService.getBudgets(userId);
  }

  @Post()
  async setBudget(@Req() req, @Body() dto: SetBudgetDto) {
    const userId = req.user.sub || req.user.userId;
    return this.budgetsService.setBudget(userId, dto.category, dto.monthlyLimit);
  }

  @Delete(':category')
  async deleteBudget(@Req() req, @Param('category') category: string) {
    const userId = req.user.sub || req.user.userId;
    return this.budgetsService.deleteBudget(userId, category);
  }
}

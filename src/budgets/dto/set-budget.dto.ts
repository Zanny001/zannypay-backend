import { IsString, IsNumber, Min } from 'class-validator';

export class SetBudgetDto {
  @IsString()
  category: string;

  @IsNumber()
  @Min(1)
  monthlyLimit: number;
}

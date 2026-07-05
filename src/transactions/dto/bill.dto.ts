import { IsString, IsNumber, Min, IsOptional } from 'class-validator';

export class BillDto {
  @IsString()
  billerName: string;

  @IsString()
  category: string;

  @IsNumber()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsString()
  pin: string;
}

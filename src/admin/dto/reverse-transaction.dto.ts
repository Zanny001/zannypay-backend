import { IsString, MinLength } from 'class-validator';

export class ReverseTransactionDto {
  @IsString()
  @MinLength(5)
  reason: string;
}

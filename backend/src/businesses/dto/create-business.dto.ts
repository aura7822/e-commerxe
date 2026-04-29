import {
  IsString,
  IsOptional,
  MaxLength,
  IsArray,
  IsUUID,
  ArrayMinSize,
  ArrayMaxSize,
  IsUrl,
  IsEmail,
  IsInt,
  Min,
  Max,
  IsNotEmpty,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class CreateBusinessDto {
  @ApiProperty({ example: 'SwiftWheels Kenya', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Transform(({ value }: { value: string }) => value.trim())
  name: string;

  @ApiPropertyOptional({ example: 'Nairobi's most affordable car hire service.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({
    description: '1 to 3 category UUIDs',
    example: ['uuid-1', 'uuid-2'],
    isArray: true,
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'At least one category is required' })
  @ArrayMaxSize(3, { message: 'Maximum 3 categories allowed' })
  @IsUUID('4', { each: true })
  category_ids: string[];

  @ApiPropertyOptional({ example: '+254712345678' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @ApiPropertyOptional({ example: 'info@swiftwheels.co.ke' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: 'https://swiftwheels.co.ke' })
  @IsOptional()
  @IsUrl({ require_protocol: true })
  website_url?: string;

  @ApiPropertyOptional({ example: 'Kilimani, Nairobi' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  location?: string;

  @ApiPropertyOptional({ enum: [1, 2, 3, 4, 5], description: 'Card template (1-5)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  template_id?: number;
}

export class UpdateBusinessDto extends PartialType(CreateBusinessDto) {}

export class BusinessQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class FlagBusinessDto {
  @ApiProperty({ example: 'Misleading business description' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

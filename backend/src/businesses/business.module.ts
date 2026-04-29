import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BusinessService } from './business.service';
import { BusinessController } from './business.controller';
import { CardsController } from './cards.controller';
import { Business } from './entities/business.entity';
import { BusinessCard, SlugRedirect } from './entities/business-card.entity';
import { Category } from './entities/category.entity';
import { RlsContextService } from '../database/rls-context.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Business, BusinessCard, SlugRedirect, Category]),
  ],
  providers: [BusinessService, RlsContextService],
  controllers: [BusinessController, CardsController],
  exports: [BusinessService],
})
export class BusinessModule {}

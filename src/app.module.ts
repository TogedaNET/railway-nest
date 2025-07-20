import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { FeedJobsService } from './jobs/feed.jobs';
import { HttpModule } from '@nestjs/axios';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot(),
    RedisModule,
    ScheduleModule.forRoot(),
    HttpModule,
  ],
  providers: [FeedJobsService],
})
export class AppModule {}

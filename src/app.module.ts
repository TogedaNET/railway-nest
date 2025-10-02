import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { FeedJobsService } from './jobs/feed.jobs';
import { HttpModule } from '@nestjs/axios';
import { RedisModule } from './redis/redis.module';
import { SesModule } from './ses/ses.module';
// import { FeedTestController } from './feed-test.controller';

@Module({
  imports: [
    ConfigModule.forRoot(),
    RedisModule,
    SesModule,
    ScheduleModule.forRoot(),
    HttpModule,
  ],
  // controllers: [FeedTestController],
  providers: [FeedJobsService],
})
export class AppModule {}

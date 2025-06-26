import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CacheModule, CacheStore } from '@nestjs/cache-manager';
import { redisStore } from 'cache-manager-redis-store';
import { ScheduleModule } from '@nestjs/schedule';
import { FeedJobsService } from './jobs/feed.jobs';
import { HttpModule } from '@nestjs/axios';

@Module({
  imports: [
    ConfigModule.forRoot(),
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: async () => {
        const store = await redisStore({
          socket: {
            host: process.env.REDISHOST,
            port: +process.env.REDISPORT,
            tls: true,
          },
          url: process.env.REDISURL,
          password: process.env.REDISPASSWORD,
        });
        return {
          store: store as unknown as CacheStore,
          ttl: 60 * 60 * 24 * 7,
        };
      },
    }),
    ScheduleModule.forRoot(),
    HttpModule,
  ],
  providers: [FeedJobsService],
})
export class AppModule {}

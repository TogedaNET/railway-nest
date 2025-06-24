import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { CacheModule, CacheStore } from '@nestjs/cache-manager';
import { redisStore } from 'cache-manager-redis-store';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

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
        }
      }
    }),
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        type: 'postgres',
        host: process.env.POSTGRESHOST,
        port: +process.env.POSTGRESPORT,
        username: process.env.POSTGRESUSER,
        password: process.env.POSTGRESPASSWORD,
        database: process.env.POSTGRESDB,
        synchronize: false,
        ssl: true,
        entities: []
      })
    }),
    ScheduleModule.forRoot()
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

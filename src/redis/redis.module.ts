import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: async (configService: ConfigService) => {
        const client = createClient({
          url: configService.get<string>('REDISURL'),
          socket: { tls: true },
        });
        client.on('error', (err) => console.error('Redis Client Error', err));
        client.on('end', () => console.warn('Redis connection closed'));
        client.on('reconnecting', () =>
          console.warn('Redis client reconnecting...'),
        );
        await client.connect();
        return client;
      },
      inject: [ConfigService],
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}

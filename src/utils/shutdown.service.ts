import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';

@Injectable()
class ShutdownService implements OnApplicationShutdown {
  private readonly logger = new Logger(ShutdownService.name, {
    timestamp: true,
  });
  onApplicationShutdown(signal: string) {
    this.logger.warn('Application shutdown initiated with: ', signal);
  }
}

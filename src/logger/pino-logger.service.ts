import { LoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as pino from 'pino';

export class PinoLoggerService implements LoggerService {
    private logger: any;
    private serviceName: string = 'railway-nest';

    constructor() {
        const token = process.env.BETTER_STACK_TOKEN;
        const targets = [];

        if (token) {
            targets.push({
                target: "@logtail/pino",
                options: {
                    sourceToken: token,
                    options: {
                        endpoint: process.env.BETTER_STACK_ENDPOINT
                    },
                },
            });
        }

        targets.push({
            target: "pino-pretty",
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
            },
        });

        const transport = pino.transport({ targets });
        this.logger = pino(transport);
    }

    log(message: any) {
        this.logger.info({ message, app: this.serviceName });
    }

    error(message: any, error: any) {
        this.logger.error({ message, app: this.serviceName, error });
    }

    warn(message: any) {
        this.logger.warn({ message, app: this.serviceName });
    }

    debug(message: any) {
        this.logger.debug({ message, app: this.serviceName });
    }

    verbose(message: any) {
        this.logger.trace({ message, app: this.serviceName });
    }
}
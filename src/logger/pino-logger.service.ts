import { LoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as pino from 'pino';

export class PinoLoggerService implements LoggerService {
    private logger: any;

    constructor() {
        const token = process.env.BETTER_STACK_TOKEN;
        const transport = pino.transport({
            targets: [
                {
                    target: "@logtail/pino",
                    options: {
                        sourceToken: token,
                        options: {
                            endpoint: process.env.BETTER_STACK_ENDPOINT
                        },
                    },
                },
                {
                    target: "pino-pretty",
                    options: {
                        colorize: true,
                        translateTime: 'SYS:standard',
                    },
                },
            ],
        });
        this.logger = pino(transport);
    }

    log(message: any, ...optionalParams: any[]) {
        this.logger.info(message, ...optionalParams);
    }

    error(message: any, ...optionalParams: any[]) {
        this.logger.error(message, ...optionalParams);
    }

    warn(message: any, ...optionalParams: any[]) {
        this.logger.warn(message, ...optionalParams);
    }

    debug(message: any, ...optionalParams: any[]) {
        this.logger.debug(message, ...optionalParams);
    }

    verbose(message: any, ...optionalParams: any[]) {
        this.logger.trace(message, ...optionalParams);
    }
}
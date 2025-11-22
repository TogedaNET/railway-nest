import { Logger } from '@nestjs/common';

/**
 * Base interface for Redis pub/sub event handlers
 */
export interface IRedisEventHandler {
    /**
     * Handle incoming Redis pub/sub event message
     * @param message - Raw message string from Redis (double-JSON encoded)
     */
    handle(message: string): Promise<void>;
}

/**
 * Base class for Redis event handlers with common parsing logic
 */
export abstract class BaseRedisEventHandler implements IRedisEventHandler {
    protected readonly logger: Logger;

    constructor(loggerContext: string) {
        this.logger = new Logger(loggerContext, { timestamp: true });
    }

    /**
     * Parse double-JSON encoded Redis message
     * All Redis pub/sub messages are double-JSON encoded strings
     */
    protected parseMessage(message: string, eventName: string): any {
        try {
            return typeof message === 'string' ? JSON.parse(JSON.parse(message)) : message;
        } catch (e) {
            this.logger.error(`Failed to parse ${eventName} event message`, e);
            return null;
        }
    }

    abstract handle(message: string): Promise<void>;
}

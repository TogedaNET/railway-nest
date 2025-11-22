import { BaseRedisEventHandler } from './base-event-handler';
import { FeedJobsService } from '../feed.jobs';

/**
 * Handles user.updateFeed Redis pub/sub events
 * Triggers personalized feed regeneration for a specific user
 */
export class UserUpdateFeedEventHandler extends BaseRedisEventHandler {
    constructor(private readonly feedJobsService: FeedJobsService) {
        super('UserUpdateFeedEventHandler');
    }

    async handle(message: string): Promise<void> {
        this.logger.log(`Received user.updateFeed event: ${message}`);

        const parsed = this.parseMessage(message, 'user.updateFeed');
        if (!parsed) return;

        const userId = parsed?.userId;

        if (!userId) {
            this.logger.error('user.updateFeed event missing userId');
            return;
        }

        try {
            await this.feedJobsService.cachePersonalizedFeedForAllUsers([userId]);
            this.logger.log(`Feed updated for user ${userId}`);
        } catch (error) {
            this.logger.error('Error handling user.updateFeed event', error);
        }
    }
}

import { BaseRedisEventHandler } from './base-event-handler';
import { FeedJobsService } from '../feed.jobs';

/**
 * Handles post.created Redis pub/sub events
 * Triggers personalized feed updates for users within 500km of the new post
 */
export class PostCreatedEventHandler extends BaseRedisEventHandler {
    constructor(private readonly feedJobsService: FeedJobsService) {
        super('PostCreatedEventHandler');
    }

    async handle(message: string): Promise<void> {
        this.logger.log(`Received post.created event: ${message}`);

        const postEvent = this.parseMessage(message, 'post.created');
        if (!postEvent) return;

        if (!postEvent.postId) {
            this.logger.error('post.created event missing postId');
            return;
        }

        await this.feedJobsService.prePopulateUserFeedsInRange(postEvent.postId);
    }
}

import { BaseRedisEventHandler } from './base-event-handler';
import { FeedJobsService } from '../feed.jobs';

/**
 * Handles club.created Redis pub/sub events
 * Triggers personalized club feed updates for users within 500km of the new club
 */
export class ClubCreatedEventHandler extends BaseRedisEventHandler {
    constructor(private readonly feedJobsService: FeedJobsService) {
        super('ClubCreatedEventHandler');
    }

    async handle(message: string): Promise<void> {
        this.logger.log(`Received club.created event: ${message}`);

        const clubEvent = this.parseMessage(message, 'club.created');
        if (!clubEvent) return;

        if (!clubEvent.clubId) {
            this.logger.error('club.created event missing clubId');
            return;
        }

        await this.feedJobsService.prePopulateClubFeedsInRange(clubEvent.clubId);
    }
}

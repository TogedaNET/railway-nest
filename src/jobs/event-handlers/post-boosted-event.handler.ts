import { Pool } from 'pg';
import { RedisClientType } from 'redis';
import { BaseRedisEventHandler } from './base-event-handler';
import { SesService } from '../../ses/ses.service';
import { FeedJobsService } from '../feed.jobs';

const ONE_DAY_IN_SECONDS = 60 * 60 * 24;

/**
 * Handles post.boosted Redis pub/sub events
 * Stores boost event in Redis, sends notification email, and updates affected feeds
 */
export class PostBoostedEventHandler extends BaseRedisEventHandler {
    constructor(
        private readonly pgPool: Pool,
        private readonly redisClient: RedisClientType<any, any>,
        private readonly sesService: SesService,
        private readonly feedJobsService: FeedJobsService,
    ) {
        super('PostBoostedEventHandler');
    }

    async handle(message: string): Promise<void> {
        this.logger.log(`Received post.boosted event: ${message}`);

        const parsed = this.parseMessage(message, 'post.boosted');
        if (!parsed) return;

        const allowedTypes = new Set(['one_day']);
        const postId = parsed?.postId;
        const type = parsed?.type;
        const timestamp = parsed?.timestamp;

        if (!postId) {
            this.logger.error('post.boosted event missing postId');
            return;
        }
        if (!allowedTypes.has(type)) {
            this.logger.error(`post.boosted event has invalid type: ${type}`);
            return;
        }

        const eventToStore = {
            postId: String(postId),
            type,
            timestamp: Number(timestamp),
        };

        try {
            if (type === 'one_day') {
                await this.redisClient.set(
                    `post:boosted:${String(postId)}`,
                    JSON.stringify(eventToStore),
                    {
                        EX: ONE_DAY_IN_SECONDS,
                    },
                );
            } else {
                this.logger.error('unknown type of boost event: ', type);
                return;
            }
            this.logger.log(`Stored post.boosted event for post ${postId}`);

            // Fetch post owner's email and send notification
            const { rows: postOwnerRows } = await this.pgPool.query(
                'SELECT ui.email, ui.first_name, p.title FROM post p JOIN user_info ui ON p.user_id = ui.id WHERE p.id = $1',
                [postId],
            );

            if (postOwnerRows.length > 0) {
                const owner = postOwnerRows[0];
                await this.sesService.sendHtmlEmail(
                    owner.email,
                    'Your Event Has Been Boosted!',
                    `
            <h1>Great News, ${owner.first_name || 'there'}!</h1>
            <p>Your event "${owner.title}" has been successfully boosted and will now reach more people!</p>
            <p>Your event will have increased visibility for the next 24 hours.</p>
            <p>Best regards,<br>The Togeda Team</p>
          `,
                    `Great news! Your event "${owner.title}" has been boosted and will reach more people for the next 24 hours.`,
                );
                this.logger.log(`Boost notification email sent to ${owner.email} for post ${postId}`);
            }
        } catch (err) {
            this.logger.error('Failed saving post.boosted event to Redis', err);
            return;
        }

        await this.feedJobsService.prePopulateUserFeedsInRange(eventToStore.postId);
    }
}

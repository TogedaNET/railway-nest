import { Pool } from 'pg';
import { BaseRedisEventHandler } from './base-event-handler';
import { SesService } from '../../ses/ses.service';

/**
 * Handles user.finalizeSignUp Redis pub/sub events
 * Sends welcome email to newly registered users
 */
export class UserFinalizeSignUpEventHandler extends BaseRedisEventHandler {
    constructor(
        private readonly pgPool: Pool,
        private readonly sesService: SesService,
    ) {
        super('UserFinalizeSignUpEventHandler');
    }

    async handle(message: string): Promise<void> {
        this.logger.log(`Received user.finalizeSignUp event: ${message}`);

        const parsed = this.parseMessage(message, 'user.finalizeSignUp');
        if (!parsed) return;

        const userId = parsed?.userId;

        if (!userId) {
            this.logger.error('user.finalizeSignUp event missing userId');
            return;
        }

        try {
            // Fetch user information
            const { rows: userRows } = await this.pgPool.query(
                'SELECT id, email, first_name FROM user_info WHERE id = $1',
                [userId],
            );

            if (!userRows.length) {
                this.logger.warn(`User not found for finalize sign up event. UserId: ${userId}`);
                return;
            }

            const user = userRows[0];

            // Send welcome email
            await this.sesService.sendHtmlEmail(
                user.email,
                'Welcome to Togeda!',
                `
          <h1>Welcome to Togeda, ${user.first_name || 'there'}!</h1>
          <p>Thank you for completing your registration. We're excited to have you join our community!</p>
          <p>With Togeda, you can:</p>
          <ul>
            <li>Discover exciting events near you</li>
            <li>Connect with like-minded people</li>
            <li>Create and share your own experiences</li>
          </ul>
          <p>Get started by exploring events in your area and joining ones that interest you!</p>
          <p>Best regards,<br>The Togeda Team</p>
        `,
                `Welcome to Togeda, ${user.first_name || 'there'}! Thank you for completing your registration. We're excited to have you join our community!`,
            );

            this.logger.log(`Welcome email sent for user ${userId}`);
        } catch (error) {
            this.logger.error('Error handling user.finalizeSignUp event', error);
        }
    }
}

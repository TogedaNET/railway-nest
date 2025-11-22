import { Pool } from 'pg';
import { BaseRedisEventHandler } from './base-event-handler';
import { SesService } from '../../ses/ses.service';

/**
 * Handles paymentIntent.succeeded Redis pub/sub events
 * Sends ticket confirmation emails to users after successful payment
 */
export class PaymentIntentSucceededEventHandler extends BaseRedisEventHandler {
    constructor(
        private readonly pgPool: Pool,
        private readonly sesService: SesService,
    ) {
        super('PaymentIntentSucceededEventHandler');
    }

    async handle(message: string): Promise<void> {
        this.logger.log(`Received paymentIntent.succeeded event: ${message}`);

        const parsed = this.parseMessage(message, 'paymentIntent.succeeded');
        if (!parsed) return;

        const postId = parsed?.postId;
        const userId = parsed?.userId;

        if (!postId || !userId) {
            this.logger.error('paymentIntent.succeeded event missing postId or userId');
            return;
        }

        try {
            // Fetch post and user information
            const { rows: postRows } = await this.pgPool.query(
                'SELECT id, title FROM post WHERE id = $1',
                [postId],
            );

            const { rows: userRows } = await this.pgPool.query(
                'SELECT id, email, first_name FROM user_info WHERE id = $1',
                [userId],
            );

            if (!postRows.length || !userRows.length) {
                this.logger.warn(`Post or user not found for payment intent event. PostId: ${postId}, UserId: ${userId}`);
                return;
            }

            const post = postRows[0];
            const user = userRows[0];

            // Send email notification
            await this.sesService.sendHtmlEmail(
                user.email,
                `Ticket Confirmed - ${post.title}`,
                `
          <h1>Your Ticket is Confirmed!</h1>
          <p>Hi ${user.first_name || 'there'},</p>
          <p>Your payment was successful and your ticket for the following event has been confirmed:</p>
          <h2>${post.title}</h2>
          <p>Best regards,<br>The Togeda Team</p>
        `,
                `Your ticket for "${post.title}" (ID: ${post.id}) has been confirmed. We look forward to seeing you there!`,
            );

            this.logger.log(`Payment confirmation email sent to ${user.email} for post ${postId}`);
        } catch (error) {
            this.logger.error('Error handling paymentIntent.succeeded event', error);
        }
    }
}

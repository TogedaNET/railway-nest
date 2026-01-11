import { Pool, PoolClient } from 'pg';
import { RedisClientType } from 'redis';
import { BaseRedisEventHandler } from './base-event-handler';
import { SesService } from '../../ses/ses.service';

/**
 * Handles user.delete Redis pub/sub events
 * Cleans up user data across the system when a user account is deleted
 * 
 * Event payload: { userId: string, timestamp: number }
 */
export class UserDeleteEventHandler extends BaseRedisEventHandler {
    constructor(
        private readonly pgPool: Pool,
        private readonly redisClient: RedisClientType<any, any>,
        private readonly sesService: SesService,
    ) {
        super('UserDeleteEventHandler');
    }

    async handle(message: string): Promise<void> {
        this.logger.log(`Received user.delete event: ${message}`);

        const parsed = this.parseMessage(message, 'user.delete');
        if (!parsed) return;

        const userId = parsed?.userId;
        const timestamp = parsed?.timestamp;

        if (!userId) {
            this.logger.error('user.delete event missing userId');
            return;
        }

        const client = await this.pgPool.connect();
        try {
            await client.query('BEGIN');

            // 0. Get user email before anonymization
            const { rows: userEmailRows } = await client.query(
                'SELECT email FROM user_info WHERE id = $1',
                [userId],
            );
            const userEmail = userEmailRows.length ? userEmailRows[0].email : 'unknown';
            // 1. Delete all user posts
            const { rows: userPosts } = await client.query(
                'SELECT id FROM post WHERE user_id = $1',
                [userId],
            );

            for (const post of userPosts) {
                await this.deletePost(client, post.id);
                this.logger.log(`Deleted post ${post.id} for user ${userId}`);
            }

            // 2. Delete user-owned chat rooms (direct messages, etc.)
            const { rows: userChatRooms } = await client.query(
                'SELECT id FROM chat_room WHERE user_id = $1',
                [userId],
            );
            for (const chatRoom of userChatRooms) {
                await this.deleteChatRoom(client, chatRoom.id);
                this.logger.log(`Deleted chat room ${chatRoom.id} owned by user ${userId}`);
            }

            // Delete stripe charges for the user
            // await this.pgPool.query('DELETE FROM stripe_charge WHERE user_id = $1', [userId]);

            this.logger.log(`Deleted all posts and related data for user ${userId}`);

            // 3. Handle club memberships
            const { rows: userClubs } = await client.query(
                `SELECT c.id as club_id, COUNT(cm.id) as member_count, c.user_id as owner_id
         FROM club c
         JOIN club_member cm ON c.id = cm.club_id
         WHERE c.id IN (
           SELECT club_id FROM club_member WHERE user_id = $1
         )
         GROUP BY c.id, c.user_id`,
                [userId],
            );

            for (const club of userClubs) {
                const memberCount = Number(club.member_count);

                if (memberCount === 1) {
                    // User is the only member - delete the club

                    // First, delete all posts belonging to this club
                    const { rows: clubPosts } = await client.query(
                        'SELECT id FROM post WHERE club_id = $1',
                        [club.club_id],
                    );
                    for (const clubPost of clubPosts) {
                        await this.deletePost(client, clubPost.id);
                        this.logger.log(`Deleted club post ${clubPost.id} from club ${club.club_id}`);
                    }

                    // Delete club-related data
                    await client.query('DELETE FROM club_member WHERE club_id = $1', [
                        club.club_id,
                    ]);
                    await client.query('DELETE FROM club_interests WHERE club_id = $1', [
                        club.club_id,
                    ]);
                    await client.query('DELETE FROM club_images WHERE club_id = $1', [
                        club.club_id,
                    ]);
                    await client.query('DELETE FROM club_join_requests WHERE club_id = $1', [
                        club.club_id,
                    ]);
                    await client.query('DELETE FROM club_memories WHERE club_id = $1', [
                        club.club_id,
                    ]);

                    // Delete chat rooms belonging to the club
                    const { rows: clubChatRooms } = await client.query(
                        'SELECT id FROM chat_room WHERE club_id = $1',
                        [club.club_id],
                    );
                    for (const chatRoom of clubChatRooms) {
                        await this.deleteChatRoom(client, chatRoom.id);
                    }

                    // Delete activities related to the club
                    await client.query('DELETE FROM activity WHERE club_id = $1', [club.club_id]);

                    // Delete reports about the club
                    await client.query('DELETE FROM report WHERE reported_club_id = $1', [club.club_id]);

                    // TODO archive reports about the club?

                    // Finally, delete the club itself
                    await client.query('DELETE FROM club WHERE id = $1', [club.club_id]);
                    this.logger.log(`Deleted club ${club.club_id} (user was only member)`);
                } else if (memberCount > 1) {
                    // Multiple members - remove user and potentially promote new owner
                    await client.query(
                        'DELETE FROM club_member WHERE user_id = $1 AND club_id = $2',
                        [userId, club.club_id],
                    );

                    // If user was the owner, promote a new owner
                    if (club.owner_id === userId) {
                        // Try to find an admin to promote
                        const { rows: admins } = await client.query(
                            `SELECT cm.user_id FROM club_member cm 
               WHERE cm.club_id = $1 AND cm.type = 0 LIMIT 1`,
                            [club.club_id],
                        );

                        let newOwnerId: string;
                        if (admins.length > 0) {
                            newOwnerId = admins[0].user_id;
                        } else {
                            // No admin found, promote any member
                            const { rows: anyMember } = await client.query(
                                'SELECT user_id FROM club_member WHERE club_id = $1 LIMIT 1',
                                [club.club_id],
                            );
                            if (anyMember.length > 0) {
                                newOwnerId = anyMember[0].user_id;
                                // Promote them to admin
                                await client.query(
                                    `UPDATE club_member SET type = 0
                   WHERE user_id = $1 AND club_id = $2`,
                                    [newOwnerId, club.club_id],
                                );
                            }
                        }

                        // Update club owner
                        if (newOwnerId) {
                            await client.query('UPDATE club SET user_id = $1 WHERE id = $2', [
                                newOwnerId,
                                club.club_id,
                            ]);
                            this.logger.log(
                                `Promoted user ${newOwnerId} as new owner of club ${club.club_id}`,
                            );
                        }
                    }

                    this.logger.log(`Removed user ${userId} from club ${club.club_id}`);
                }
            }

            // 4. Clear Redis caches (Not needed in my opinion)
            // await this.redisClient.del(`personalized:feed:${userId}`);
            // this.logger.log(`Cleared Redis cache for user ${userId}`);

            // 5. Anonymize user data (instead of full deletion for data integrity)
            await client.query(
                `UPDATE user_info SET 
          stripe_account_id = NULL,
          first_name = 'Deleted',
          last_name = 'user',
          email = 'deletedEmail',
          phone_number = 'deletedPhoneNumber',
          verified_email = false,
          verified_phone = false,
          status = 'OFFLINE',
          is_deleted = true
         WHERE id = $1`,
                [userId],
            );
            this.logger.log(`Anonymized user data for user ${userId}`);

            // 6. Clear relationships
            await client.query(
                'DELETE FROM friend_request WHERE from_user_id = $1 OR to_user_id = $1',
                [userId],
            );
            await client.query(
                'DELETE FROM user_friends WHERE user_id = $1 OR friend_id = $1',
                [userId],
            );
            await client.query(
                'DELETE FROM block_users WHERE block_user_id = $1 OR target_user_id = $1',
                [userId],
            );
            this.logger.log(`Cleared relationships for user ${userId}`);

            // 7. Clear collections
            await client.query('DELETE FROM user_saved_posts WHERE user_id = $1', [
                userId,
            ]);
            await client.query('DELETE FROM user_hidden_posts WHERE user_id = $1', [
                userId,
            ]);
            await client.query(
                'DELETE FROM participation_rating WHERE to_user_id = $1',
                [userId],
            );
            await client.query('DELETE FROM unique_device WHERE user_id = $1', [
                userId,
            ]);
            await client.query('DELETE FROM report WHERE reported_user_id = $1', [
                userId,
            ]);
            await client.query('DELETE FROM badge_task WHERE user_id = $1', [userId]);
            await client.query('DELETE FROM user_badges WHERE user_id = $1', [userId]);
            await client.query('DELETE FROM user_interests WHERE user_id = $1', [
                userId,
            ]);
            await client.query('DELETE FROM user_profile_photos WHERE user_id = $1', [
                userId,
            ]);
            await client.query('DELETE FROM club_join_requests WHERE join_requests = $1', [userId]);
            await client.query('DELETE FROM post_join_requests WHERE join_requests = $1', [userId]);
            await client.query('DELETE FROM wait_request WHERE user_id = $1', [userId]);
            await client.query('INSERT INTO user_profile_photos (user_id, profile_photos) VALUES ($1, $2)', [
                userId,
                'https://togeda-profile-photos.s3.eu-central-1.amazonaws.com/istockphoto-1495088043-612x612.jpg', // or some placeholder value
            ]);
            this.logger.log(`Cleared collections for user ${userId}`);

            // 8. Delete activities
            await client.query('DELETE FROM activity WHERE user_id = $1', [userId]);
            this.logger.log(`Deleted activities for user ${userId}`);

            await client.query('COMMIT');
            this.logger.log(
                `User deletion cleanup completed successfully for user ${userId} at timestamp ${timestamp}`,
            );

            // 9. Send email for feedback
            try {
                await this.sesService.sendHtmlEmail(
                    userEmail,
                    'Feedback Request From Togeda',
                    `
          <h2>We're Sorry to See You Go</h2>
          <p>Your account has been successfully deleted from Togeda.</p>
          <p>We'd love to hear your feedback to help us improve. Could you take a moment to let us know why you decided to leave?</p>
          <p>Your insights are valuable to us and will help make Togeda better for everyone.</p>
          <p>Thank you for being part of our community.</p>
        `,
                );
                this.logger.log(`Feedback request sent to ${userEmail} for user ${userId}`);
            } catch (emailError) {
                this.logger.error(`Failed to send deletion notification email for user ${userId}:`, emailError);
                // Don't throw - email failure shouldn't fail the entire deletion process
            }

        } catch (error) {
            await client.query('ROLLBACK');
            this.logger.error(`Error handling user.delete event for user ${userId}:`, error);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Delete a post and all its associated data
     * Follows the same logic as the Java PostService.delete() method
     */
    private async deletePost(client: PoolClient, postId: string): Promise<void> {
        // Delete post participants
        await client.query('DELETE FROM post_participant WHERE post_id = $1', [postId]);

        // Delete participation ratings
        await client.query('DELETE FROM participation_rating WHERE post_id = $1', [postId]);

        // Delete user saves (many-to-many) - removeAllUserSaves()
        await client.query('DELETE FROM user_saved_posts WHERE post_id = $1', [postId]);

        // Delete user hidden posts (many-to-many) - removeAllTimesItWasHidden()
        await client.query('DELETE FROM user_hidden_posts WHERE post_id = $1', [postId]);

        // Delete notifications related to the post (using JSONB operator)
        await client.query(
            `DELETE FROM notification WHERE alert_body::jsonb @> $1::jsonb`,
            [JSON.stringify({ postId })]
        );

        // Archive reports before deleting
        const { rows: reports } = await client.query(
            'SELECT id, description, reporter_id, reported_user_id, reported_post_id, reported_club_id, report_type, created_at FROM report WHERE reported_post_id = $1',
            [postId],
        );

        for (const report of reports) {
            const reportData = JSON.stringify(report);
            await client.query(
                'INSERT INTO archived_report (id, report_data) VALUES ($1, $2)',
                [report.id, reportData],
            );
        }

        // Delete reports
        await client.query('DELETE FROM report WHERE reported_post_id = $1', [postId]);

        // Delete post interests
        await client.query('DELETE FROM post_interests WHERE post_id = $1', [postId]);

        // Delete post images
        await client.query('DELETE FROM post_images WHERE post_id = $1', [postId]);

        // Delete post join requests
        await client.query('DELETE FROM post_join_requests WHERE post_id = $1', [postId]);

        // Delete ratings for the post
        await client.query('DELETE FROM rating WHERE post_id = $1', [postId]);

        // Delete wait requests for the post
        await client.query('DELETE FROM wait_request WHERE post_id = $1', [postId]);

        // Delete activities for the post
        await client.query('DELETE FROM activity WHERE post_id = $1', [postId]);

        // Delete stripe charges for the post
        // await client.query('DELETE FROM stripe_charge WHERE post_id = $1', [postId]);

        // Delete chat room associated with post
        const { rows: chatRooms } = await client.query(
            'SELECT id FROM chat_room WHERE post_id = $1',
            [postId],
        );
        for (const chatRoom of chatRooms) {
            await this.deleteChatRoom(client, chatRoom.id);
        }

        // Delete the post itself
        await client.query('DELETE FROM post WHERE id = $1', [postId]);
    }

    /**
     * Delete a chat room and all its associated data
     * Reusable method for chat room deletion across different contexts
     */
    private async deleteChatRoom(client: PoolClient, chatRoomId: string): Promise<void> {
        // Clear latest_message reference first (foreign key constraint)
        await client.query('UPDATE chat_room SET latest_message = NULL WHERE id = $1', [chatRoomId]);

        // Delete chat message likes
        await client.query(
            'DELETE FROM chat_message_liked_by_users WHERE chat_message_id IN (SELECT id FROM chat_message WHERE chat_id = $1)',
            [chatRoomId],
        );

        // Delete chat message read receipts
        await client.query(
            'DELETE FROM chat_message_read_by_users WHERE chat_message_id IN (SELECT id FROM chat_message WHERE chat_id = $1)',
            [chatRoomId],
        );

        // Delete chat messages
        await client.query('DELETE FROM chat_message WHERE chat_id = $1', [chatRoomId]);

        // Delete active users
        await client.query('DELETE FROM chat_room_active_users WHERE chat_room_id = $1', [chatRoomId]);

        // Delete muted users
        await client.query('DELETE FROM chat_room_muted_users WHERE chat_room_id = $1', [chatRoomId]);

        // Delete participants
        await client.query('DELETE FROM chat_room_participants WHERE chat_room_id = $1', [chatRoomId]);

        // Delete the chat room itself
        await client.query('DELETE FROM chat_room WHERE id = $1', [chatRoomId]);
    }
}

// src/jobs/feed.jobs.ts
import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import * as ngeohash from 'ngeohash';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import * as dayjs from 'dayjs';
import { RedisClientType } from 'redis';
import { SesService } from '../ses/ses.service';

// Type for Mixpanel Engage API response
interface MixpanelEngageUser {
  $distinct_id: string;
  $properties: {
    $name?: string;
    $user_id?: string;
    $last_seen?: string;
    [key: string]: any;
  };
}
interface MixpanelEngageResponse {
  results: MixpanelEngageUser[];
  page: number;
  session_id: string;
  page_size: number;
  total: number;
  status: string;
  computed_at: string;
}

const ONE_DAY_IN_SECONDS = 60 * 60 * 24;

@Injectable()
export class FeedJobsService {
  private readonly logger = new Logger(FeedJobsService.name, {
    timestamp: true,
  });
  private readonly pgPool: Pool;
  private isRunning = false;
  private isRunning2 = false;
  private redisSubscriber: RedisClientType<any, any>;

  constructor(
    private readonly httpService: HttpService,
    @Inject('REDIS_CLIENT')
    private readonly redisClient: RedisClientType<any, any>,
    private readonly sesService: SesService
  ) {
    this.pgPool = new Pool({
      host: process.env.POSTGRESHOST,
      port: +process.env.POSTGRESPORT,
      user: process.env.POSTGRESUSER,
      password: process.env.POSTGRESPASSWORD,
      database: process.env.POSTGRESDB,
      ssl: true,
    });
    this.initRedisSubscriber();
  }

  private async initRedisSubscriber() {
    // node-redis v4+ requires a separate client for pub/sub
    this.redisSubscriber = this.redisClient.duplicate();
    this.redisSubscriber.on('error', (err) =>
      this.logger.error('Redis Subscriber Error for pub/sub', err),
    );
    await this.redisSubscriber.connect();
    await this.redisSubscriber.subscribe('post.created', async (message) => {
      await this.handlePostCreatedEvent(message);
    });
    await this.redisSubscriber.subscribe('post.boosted', async (message) => {
      await this.handlePostBoostedEvent(message);
    });
    await this.redisSubscriber.subscribe('paymentIntent.succeeded', async (message) => {
      await this.handlePaymentIntentSucceededEvent(message);
    });
    await this.redisSubscriber.subscribe('user.finalizeSignUp', async (message) => {
      await this.handleUserFinalizeSignUpEvent(message);
    });
    await this.redisSubscriber.subscribe('user.updateFeed', async (message) => {
      await this.handleUpdateUserFeed(message);
    });
    this.logger.log('Subscribed to Redis channel: post.created');
    this.logger.log('Subscribed to Redis channel: post.boosted');
    this.logger.log('Subscribed to Redis channel: paymentIntent.succeeded');
    this.logger.log('Subscribed to Redis channel: user.finalizeSignUp');
    this.logger.log('Subscribed to Redis channel: user.updateFeed');
  }

  private async handlePostCreatedEvent(message: string) {
    this.logger.log(`Received post.created event: ${message}`);
    let postEvent;
    try {
      postEvent =
        typeof message === 'string' ? JSON.parse(JSON.parse(message)) : message;
    } catch (e) {
      this.logger.error('Failed to parse post.created event message', e);
      return;
    }
    if (!postEvent || !postEvent.postId) {
      this.logger.error('post.created event missing postId');
      return;
    }
    await this.prePopulateUserFeedsInRange(postEvent.postId);
  }

  private async handlePostBoostedEvent(message: string) {
    this.logger.log(`Received post.boosted event: ${message}`);
    let parsed: any;
    try {
      parsed =
        typeof message === 'string' ? JSON.parse(JSON.parse(message)) : message;
    } catch (e) {
      this.logger.error('Failed to parse post.boosted event message', e);
      return;
    }

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
        this.logger.error("unknown type of boost event: ", type);
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
    await this.prePopulateUserFeedsInRange(eventToStore.postId);
  }

  private async handlePaymentIntentSucceededEvent(message: string) {
    this.logger.log(`Received paymentIntent.succeeded event: ${message}`);
    let parsed: any;
    try {
      parsed =
        typeof message === 'string' ? JSON.parse(JSON.parse(message)) : message;
    } catch (e) {
      this.logger.error('Failed to parse paymentIntent.succeeded event message', e);
      return;
    }

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
          <p>Hi ${user.name || 'there'},</p>
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

  private async handleUserFinalizeSignUpEvent(message: string) {
    this.logger.log(`Received user.finalizeSignUp event: ${message}`);
    let parsed: any;
    try {
      parsed =
        typeof message === 'string' ? JSON.parse(JSON.parse(message)) : message;
    } catch (e) {
      this.logger.error('Failed to parse user.finalizeSignUp event message', e);
      return;
    }

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

      this.logger.log(`Welcome email sent to ${user.email} for user ${userId}`);
    } catch (error) {
      this.logger.error('Error handling user.finalizeSignUp event', error);
    }
  }

  private async handleUpdateUserFeed(message: string) {
    this.logger.log(`Received user.updateFeed event: ${message}`);
    let parsed: any;
    try {
      parsed =
        typeof message === 'string' ? JSON.parse(JSON.parse(message)) : message;
    } catch (e) {
      this.logger.error('Failed to parse user.updateFeed event message', e);
      return;
    }

    const userId = parsed?.userId;

    if (!userId) {
      this.logger.error('user.updateFeed event missing userId');
      return;
    }

    try {
      await this.cachePersonalizedFeedForAllUsers([userId]);
      this.logger.log(`Feed updated for user ${userId}`);
    } catch (error) {
      this.logger.error('Error handling user.updateFeed event', error);
    }
  }

  @Cron(CronExpression.EVERY_6_HOURS)
  async updateTrendingPosts() {
    if (this.isRunning) {
      this.logger.warn(
        'updateTrendingPosts skipped: previous run still in progress',
      );
      return;
    }
    this.isRunning = true;
    try {
      this.logger.log('updateTrendingPosts called');

      // 1. Fetch all posts with status 'NOT_STARTED', creation date, user_id, user_role, and participant count
      const { rows: posts } = await this.pgPool.query(
        `SELECT p.id, p.latitude, p.longitude, p.created_at, p.user_id, ui.user_role, 
                COUNT(pp.id) AS participant_count,
                ST_Y(p.user_current_location::geometry) as current_lat, 
                ST_X(p.user_current_location::geometry) as current_lon
         FROM post p
         JOIN user_info ui ON p.user_id = ui.id
         LEFT JOIN post_participant pp ON p.id = pp.post_id
         WHERE p.status = 'NOT_STARTED'
         GROUP BY p.id, p.latitude, p.longitude, p.created_at, p.user_id, ui.user_role`,
      );

      // 2. Cluster posts by geohash (precision 3 ≈ 156km, 2 ≈ 625km, adjust as needed)
      const precision = 2; // ~625km, use 3 for smaller clusters
      const clusters: Record<
        string,
        {
          id: string;
          latitude: number;
          longitude: number;
          created_at: string;
          user_id: number;
          user_role: string;
          participant_count: number;
        }[]
      > = {};

      for (const post of posts) {
        if (post.latitude == null || post.longitude == null) continue;
        const hash = ngeohash.encode(post.latitude, post.longitude, precision);
        if (!clusters[hash]) clusters[hash] = [];
        clusters[hash].push(post);
      }

      // todo could be improved to not get all boosted posts?
      const boostedIds = await this.getBoostedPostsFromRedis();

      // 3. For each cluster, score posts by timing, partner boost, and popularity, and store top 500 in Redis
      // Also add all trending posts to a global geospatial index with TTL
      const geoKey = 'trending:geoindex';
      for (const [clusterHash, clusterPosts] of Object.entries(clusters)) {
        // get travel events created from inside this cluster.
        const travelPosts = posts.filter(post => {
          if (!post.current_lat || !post.current_lon) return false;
          const hash = ngeohash.encode(post.current_lat, post.current_lon, precision);
          this.logger.log(`Current cluster hash: ${clusterHash}`)
          this.logger.log(`Current hash of event with current_lat and current_lon: ${hash}`)
          if (hash === clusterHash) {
            this.logger.log('Same hash!');
            return true; // remove log and refactor with 1 liners
          }
          return false;

        });
        const postsCombined = new Set([...clusterPosts, ...travelPosts]);
        const postIds = Array.from(postsCombined).map((post) => post.id);
        const viewCounts = await this.redisClient.hmGet(
          'analytics:post:views',
          postIds,
        );
        // Create a map for easier lookup
        const viewCountMap = postIds.reduce((map, postId, index) => {
          map[postId] = Number(viewCounts[index]) || 0;
          return map;
        }, {});

        const scored = Array.from(postsCombined).map((post) => {
          const daysSinceCreated = Math.abs(
            dayjs().diff(dayjs(post.created_at), 'day'),
          );
          const timingScore = 50 / (daysSinceCreated + 1);
          const boostedBonus = boostedIds.has(String(post.id)) ? 2 : 1;
          // Popularity score: number of participants
          const participantCount = Number(post.participant_count) || 0;
          const viewCount = viewCountMap[post.id] || 0;
          const popularityScore = Math.min((participantCount * 0.5) + (viewCount * 0.02), 50);
          return {
            ...post,
            score: (timingScore + popularityScore) * boostedBonus,
          };
        });
        // Sort by score descending and take top 500
        const top = scored.sort((a, b) => b.score - a.score).slice(0, 500);

        // Add all posts in this cluster to the global geospatial index and save their score
        for (const post of top) {
          const lat = post.latitude;
          const lon = post.longitude;
          if (
            lon < -180 ||
            lon > 180 ||
            lat < -85.05112878 ||
            lat > 85.05112878
          ) {
            this.logger.warn(
              `Skipping geoAdd for post ${post.id}: out-of-range coordinates (${lat}, ${lon})`,
            );
            continue;
          }
          await this.redisClient.geoAdd(geoKey, {
            longitude: lon,
            latitude: lat,
            member: post.id.toString(),
          });

          // Save score in a sorted set
          await this.redisClient.zAdd('trending:geoindex:scores', [
            {
              score: post.score,
              value: post.id.toString(),
            },
          ]);
        }
      }
      // Set TTL for the geospatial index key
      await this.redisClient.expire(geoKey, ONE_DAY_IN_SECONDS);

      this.logger.log('Trending posts updated in Redis by geohash clusters');
    } catch (error) {
      this.logger.error('Error in updateTrendingPosts', error);
    } finally {
      this.isRunning = false;
    }
  }

  async fetchAllMixpanelCohortUsers(): Promise<string[]> {
    const apiKey = process.env.MIXPANEL_API_KEY;
    if (!apiKey) {
      throw new Error('MIXPANEL_API_KEY environment variable is not set');
    }

    const url = 'https://eu.mixpanel.com/api/query/engage?project_id=3497684';
    const headers = {
      accept: 'application/json',
      authorization: `Basic ${apiKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    };
    const data = 'filter_by_cohort={"id": 5666308}';

    let allUserIds: string[] = [];
    let page = 0;
    let session_id: string | undefined = undefined;
    let keepGoing = true;

    while (keepGoing) {
      try {
        let postData = data;
        if (session_id !== undefined) {
          postData += `&session_id=${session_id}&page=${page}`;
        }

        const response$ = this.httpService.post<MixpanelEngageResponse>(
          url,
          postData,
          {
            headers,
            timeout: 30000, // 30 second timeout
          },
        );

        const response = await firstValueFrom(response$);

        // Check if response is successful
        if (response.status !== 200) {
          throw new Error(
            `Mixpanel API returned status ${response.status}: ${response.statusText}`,
          );
        }

        const body = response.data;

        // Validate response structure
        if (!body || typeof body !== 'object') {
          throw new Error(
            'Invalid response from Mixpanel API: response is not an object',
          );
        }

        // Extract user IDs from this page
        const pageUserIds = this.extractUserIdsFromMixpanelResponse(body);
        allUserIds.push(...pageUserIds);

        // Pagination logic
        if (!body.results || body.results.length === 0) {
          keepGoing = false;
        } else {
          session_id = body.session_id;
          page = body.page + 1;
        }
      } catch (error) {
        this.logger.error(`Error fetching Mixpanel users:`, error.message);
      }
    }
    return allUserIds;
  }

  // Helper to extract user IDs from Mixpanel response
  extractUserIdsFromMixpanelResponse(
    response: MixpanelEngageResponse,
  ): string[] {
    return response.results.map(
      (user) => user.$properties.$user_id || user.$distinct_id,
    );
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async prePopulateAllActiveUsersFeeds() {
    if (this.isRunning2) {
      this.logger.warn(
        'prePopulateAllActiveUsersFeeds skipped: previous run still in progress',
      );
      return;
    }
    this.isRunning2 = true;
    this.logger.log('prePopulateAllActiveUsersFeeds called');
    try {
      const userIds = await this.fetchAllMixpanelCohortUsers();
      this.logger.log(`Active user IDs: ${userIds.length}`);
      await this.cachePersonalizedFeedForAllUsers(userIds);
      this.logger.log(`prePopulateAllActiveUsersFeeds finished`);
    } catch (error) {
      this.logger.error('Error in prePopulateAllActiveUsersFeeds', error);
    } finally {
      this.isRunning2 = false;
    }
  }

  async prePopulateUserFeedsInRange(postId: string) {
    this.logger.log('prePopulateUserFeedsInRange called');
    try {
      // Fetch post location and user_current_location
      const { rows: postRows } = await this.pgPool.query(
        'SELECT latitude, longitude, ST_Y(user_current_location::geometry) as current_lat, ST_X(user_current_location::geometry) as current_lon FROM post WHERE id = $1',
        [postId],
      );
      if (!postRows.length) {
        this.logger.warn(`Post not found for id: ${postId}`);
        return;
      }
      const postLat = postRows[0].latitude;
      const postLon = postRows[0].longitude;
      const postCurrentLat = postRows[0].current_lat;
      const postCurrentLon = postRows[0].current_lon;
      if (postLat == null || postLon == null) {
        this.logger.error(`Post ${postId} missing coordinates`);
        return;
      }
      const userIds = await this.fetchAllMixpanelCohortUsers();
      this.logger.log(`Users active: ${userIds.length}`);

      // Fetch user locations
      const { rows: users } = await this.pgPool.query(
        'SELECT id, COALESCE(ST_Y(user_last_known_location::geometry), latitude) as latitude, COALESCE(ST_Y(user_last_known_location::geometry), longitude) as longitude, FROM user_info WHERE id = ANY($1)',
        [userIds],
      );

      // Filter users within 500km of post location OR if post was created around user's current location
      const filteredUserIds = users
        .filter((u) => {
          if (u.latitude == null || u.longitude == null) return false;

          const distanceToPost = this.haversine(
            postLat,
            postLon,
            u.latitude,
            u.longitude,
          );

          // Include if within 500km of post location
          if (distanceToPost < 500) return true;

          // Include if post was created around user's current location (500km radius)
          if (postCurrentLat != null && postCurrentLon != null) {
            const distanceToUserCurrentLocation = this.haversine(
              postCurrentLat,
              postCurrentLon,
              u.latitude,
              u.longitude,
            );
            if (distanceToUserCurrentLocation < 500) {
              return true;
            }
          }

          return false;
        })
        .map((u) => u.id);
      this.logger.log(
        `Users within 500km or post created/boosted around number of users: ${filteredUserIds.length}`,
      );

      await this.cachePersonalizedFeedForAllUsers(filteredUserIds);
      this.logger.log(`prePopulateUserFeedsInRange finished`);
    } catch (error) {
      this.logger.error('Error in prePopulateUserFeedsInRange', error);
    }
  }

  // Haversine distance in km
  private haversine(lat1, lon1, lat2, lon2) {
    function toRad(x) {
      return (x * Math.PI) / 180;
    }
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // Jaccard index
  private jaccard(setA: Set<any>, setB: Set<any>) {
    const intersection = new Set([...setA].filter((x) => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  async cachePersonalizedFeedForAllUsers(userIds: string[]) {
    // 1. Fetch all user info, interests, friends, clubs
    const { rows: users } = await this.pgPool.query(
      `
      SELECT id, 
             COALESCE(ST_Y(user_last_known_location::geometry), latitude) as latitude, 
             COALESCE(ST_X(user_last_known_location::geometry), longitude) as longitude 
      FROM user_info 
      WHERE id = ANY($1)
    `,
      [userIds],
    );
    const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

    // Interests
    const { rows: userInterests } = await this.pgPool.query(
      `
      SELECT user_id, interest_id FROM user_interests WHERE user_id = ANY($1)
    `,
      [userIds],
    );
    const userInterestMap = {};
    for (const { user_id, interest_id } of userInterests) {
      if (!userInterestMap[user_id]) userInterestMap[user_id] = new Set();
      userInterestMap[user_id].add(interest_id);
    }

    // Friends
    const { rows: userFriends } = await this.pgPool.query(
      `
      SELECT user_id, friend_id FROM user_friends WHERE user_id = ANY($1)
    `,
      [userIds],
    );
    const userFriendMap = {};
    for (const { user_id, friend_id } of userFriends) {
      if (!userFriendMap[user_id]) userFriendMap[user_id] = new Set();
      userFriendMap[user_id].add(friend_id);
    }

    // Clubs
    const { rows: userClubs } = await this.pgPool.query(
      `
      SELECT user_id, club_id FROM club_member WHERE user_id = ANY($1)
    `,
      [userIds],
    );
    const userClubMap = {};
    for (const { user_id, club_id } of userClubs) {
      if (!userClubMap[user_id]) userClubMap[user_id] = new Set();
      userClubMap[user_id].add(club_id);
    }

    // 2. Fetch all posts and their data
    const { rows: allPosts } = await this.pgPool.query(`
      SELECT p.id, p.latitude, p.longitude, p.created_at, p.user_id, ui.user_role, p.club_id,
             COUNT(pp.id) AS participant_count,
             ST_Y(p.user_current_location::geometry) as current_lat,
             ST_X(p.user_current_location::geometry) as current_lon
      FROM post p
      JOIN user_info ui ON p.user_id = ui.id
      LEFT JOIN post_participant pp ON p.id = pp.post_id
      WHERE p.status = 'NOT_STARTED'
      GROUP BY p.id, p.latitude, p.longitude, p.created_at, p.user_id, ui.user_role, p.club_id, p.user_current_location
    `);

    // Post interests
    const { rows: postInterests } = await this.pgPool.query(`
      SELECT post_id, interest_id FROM post_interests
    `);
    const postInterestMap = {};
    for (const { post_id, interest_id } of postInterests) {
      if (!postInterestMap[post_id]) postInterestMap[post_id] = new Set();
      postInterestMap[post_id].add(interest_id);
    }

    // Post participants
    const { rows: postParticipants } = await this.pgPool.query(`
      SELECT post_id, user_id FROM post_participant
    `);
    const postParticipantMap = {};
    for (const { post_id, user_id } of postParticipants) {
      if (!postParticipantMap[post_id]) postParticipantMap[post_id] = new Set();
      postParticipantMap[post_id].add(user_id);
    }

    const redisOps: Array<{ key: string; value: any }> = [];

    // Read boosted post keys once and build a Set of boosted IDs
    let boostedIds = await this.getBoostedPostsFromRedis();

    // 3. For each user, score only posts within 500km (concurrently)
    for (const userId of userIds) {
      const user = userMap[userId];
      if (!user) continue;
      const userLat = user.latitude;
      const userLon = user.longitude;
      const userInterestsSet = userInterestMap[userId] || new Set();
      const userFriendsSet = userFriendMap[userId] || new Set();
      const userClubsSet = userClubMap[userId] || new Set();

      // Filter posts within 500km
      const nearbyPosts = allPosts.filter((post) => {
        const distance = this.haversine(
          userLat,
          userLon,
          post.latitude,
          post.longitude,
        );
        return distance < 500;
      });

      const nearbyCreatedPosts = allPosts.filter((post) => {
        if (post.current_lat && post.current_lon) {
          const distance = this.haversine(
            userLat,
            userLon,
            post.current_lat,
            post.current_lon,
          );
          return distance < 500
        }
        return false;
      });

      const postsCombined = Array.from(new Set([...nearbyPosts, ...nearbyCreatedPosts]));
      const postIds = postsCombined.map((post) => post.id);
      let viewCounts: string[];
      if (postIds.length !== 0) {
        viewCounts = await this.redisClient.hmGet(
          'analytics:post:views',
          postIds,
        );
      }
      // Create a map for easier lookup
      const viewCountMap = postIds.reduce((map, postId, index) => {
        map[postId] = Number(viewCounts[index]) || 0;
        return map;
      }, {});

      const scoredPosts = postsCombined.map((post) => {

        let distance = this.haversine(
          userLat,
          userLon,
          post.latitude,
          post.longitude,
        );
        if (distance > 500 && post.current_lat && post.current_lon) { // travel post
          distance = Math.min(500, this.haversine(
            userLat,
            userLon,
            post.current_lat,
            post.current_lon,
          ));
        }
        const locationScore = Math.max(0, 20 - (distance / 500) * 20);

        // Timing score
        const daysSinceCreated = Math.abs(
          dayjs().diff(dayjs(post.created_at), 'day'),
        );
        const timingScore = 20 / (daysSinceCreated + 1);

        const participantCount = Number(post.participant_count) || 0;
        const viewCount = viewCountMap[post.id] || 0;
        const popularityScore = Math.min((participantCount * 0.5) + (viewCount * 0.02), 10);

        // Jaccard index for interests
        const postInterestsSet = postInterestMap[post.id] || new Set();
        const jaccardScore = this.jaccard(userInterestsSet, postInterestsSet) * 10;

        // Friend with owner
        const friendWithOwnerScore = userFriendsSet.has(post.user_id) ? 15 : 0;

        // Friends with participants
        const postParticipantsSet = postParticipantMap[post.id] || new Set();
        const friendsWithParticipantsScore = Math.min([...postParticipantsSet].filter(
          (pid) => userFriendsSet.has(pid),
        ).length, 15);

        // Participant of club
        const clubParticipantScore =
          post.club_id && userClubsSet.has(post.club_id) ? 15 : 0;

        // Boost factors
        const boostedBonus = boostedIds.has(String(post.id)) ? 2 : 1;

        // Final score (tune weights as needed)
        const score =
          (locationScore +
            timingScore +
            popularityScore +
            jaccardScore +
            friendWithOwnerScore +
            friendsWithParticipantsScore +
            clubParticipantScore) * boostedBonus;

        return { postId: post.id, score };
      });

      // Sort and take top N (e.g., 500)
      const top = scoredPosts.sort((a, b) => b.score - a.score).slice(0, 500);

      // Store in Redis
      const redisKey = `personalized:feed:${userId}`;
      const now = Date.now();
      const feedObj = {
        post_ids: top.map((p) => p.postId),
        version: uuidv4(), // or increment a version counter
        created_at: now,
        total_posts: top.length,
      };
      redisOps.push({
        key: redisKey,
        value: feedObj,
      });
    }
    const pipeline = this.redisClient.multi();
    for (const op of redisOps) {
      pipeline.set(op.key, JSON.stringify(op.value), { EX: 60 * 60 * 24 * 3 }); // 3 days ttl
    }
    await pipeline.exec();
  }

  private async getBoostedPostsFromRedis() {
    let boostedIds = new Set<string>();
    try {
      const keys: string[] = [];
      // node-redis v4 scanIterator is available on the client
      for await (const key of (this.redisClient as any).scanIterator({
        MATCH: 'post:boosted:*',
      })) {
        keys.push(String(key));
      }
      boostedIds = new Set(
        keys.map((k) => k.substring('post:boosted:'.length))
      );
    } catch (e) {
      this.logger.error('Failed to scan boosted post keys from Redis', e);
    }
    return boostedIds;
  }
}

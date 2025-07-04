// src/jobs/feed.jobs.ts
import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Pool } from 'pg';
import * as ngeohash from 'ngeohash';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

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

@Injectable()
export class FeedJobsService {
  private readonly logger = new Logger(FeedJobsService.name, {
    timestamp: true,
  });
  private readonly pgPool: Pool;
  private isRunning = false;
  private isRunning2 = false;

  constructor(
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
    private readonly httpService: HttpService,
  ) {
    this.pgPool = new Pool({
      host: process.env.POSTGRESHOST,
      port: +process.env.POSTGRESPORT,
      user: process.env.POSTGRESUSER,
      password: process.env.POSTGRESPASSWORD,
      database: process.env.POSTGRESDB,
      ssl: true,
    });
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
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

      // 1. Fetch all posts with location, creation date, user_id, user_role, and participant count
      const { rows: posts } = await this.pgPool.query(
        `SELECT p.id, p.latitude, p.longitude, p.created_at, p.user_id, ui.user_role, 
                COUNT(pp.id) AS participant_count
         FROM post p
         JOIN user_info ui ON p.user_id = ui.id
         LEFT JOIN post_participant pp ON p.id = pp.post_id
         WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL
         GROUP BY p.id, p.latitude, p.longitude, p.created_at, p.user_id, ui.user_role`,
      );

      // 2. Cluster posts by geohash (precision 3 ≈ 156km, 2 ≈ 625km, adjust as needed)
      const precision = 2; // ~625km, use 3 for smaller clusters
      const clusters: Record<
        string,
        {
          id: number;
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

      // 3. For each cluster, score posts by timing, partner boost, and popularity, and store top 500 in Redis
      for (const [hash, clusterPosts] of Object.entries(clusters)) {
        const scored = clusterPosts.map((post) => {
          // Timing score: 1 / (hours since created + 1)
          const dayjs = require('dayjs');
          const hoursSinceCreated = Math.abs(
            dayjs().diff(dayjs(post.created_at), 'hour'),
          );
          const timingScore = 1 / (hoursSinceCreated + 1);
          // Boost for partners
          const boost = post.user_role === 'partner' ? 2 : 1;
          // Popularity score: number of participants
          const popularityScore = Number(post.participant_count) || 0;
          return {
            ...post,
            score: timingScore * boost + popularityScore,
          };
        });
        // Sort by score descending and take top 500
        const top = scored.sort((a, b) => b.score - a.score).slice(0, 500);

        // Store in Redis (as a list of post IDs)
        const redisKey = `trending:geo:${hash}`;
        const lastUpdatedKey = `${redisKey}:lastUpdatedAt`;

        await this.cacheManager.set(
          redisKey,
          top.map((p) => p.id),
          60 * 60 * 1000,
        ); // 1 hour TTL
        await this.cacheManager.set(
          lastUpdatedKey,
          new Date().toISOString(),
          0,
        ); // no expiration
      }

      this.logger.log('Trending posts updated in Redis by geohash clusters');
    } catch (error) {
      this.logger.error('Error in updateTrendingPosts', error);
    } finally {
      this.isRunning = false;
    }
  }

  async fetchAllMixpanelCohortUsers(): Promise<string[]> {
    const apiKey = process.env.MIXPANEL_API_KEY;
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
      let postData = data;
      if (session_id !== undefined) {
        postData += `&session_id=${session_id}&page=${page}`;
      }
      const response$ = this.httpService.post<MixpanelEngageResponse>(
        url,
        postData,
        { headers },
      );
      const response = await firstValueFrom(response$);
      const body = response.data;

      // Extract user IDs from this page
      allUserIds.push(...this.extractUserIdsFromMixpanelResponse(body));

      // Pagination logic
      if (
        body.page_size === undefined ||
        body.results.length < body.page_size
      ) {
        keepGoing = false;
      } else {
        session_id = body.session_id;
        page = body.page + 1;
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

  @Cron(CronExpression.EVERY_6_HOURS)
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
      SELECT id, latitude, longitude FROM user_info WHERE id = ANY($1)
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

    // 2. Fetch all candidate posts and their data (trending posts in region, or all posts)
    const { rows: posts } = await this.pgPool.query(`
      SELECT p.id, p.latitude, p.longitude, p.created_at, p.user_id, ui.user_role, p.club_id,
             COUNT(pp.id) AS participant_count
      FROM post p
      JOIN user_info ui ON p.user_id = ui.id
      LEFT JOIN post_participant pp ON p.id = pp.post_id
      WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL
      GROUP BY p.id, p.latitude, p.longitude, p.created_at, p.user_id, ui.user_role, p.club_id
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

    // 3. For each user, score all posts
    for (const userId of userIds) {
      const user = userMap[userId];
      if (!user) continue;
      const userLat = user.latitude;
      const userLon = user.longitude;
      const userInterestsSet = userInterestMap[userId] || new Set();
      const userFriendsSet = userFriendMap[userId] || new Set();
      const userClubsSet = userClubMap[userId] || new Set();

      const scoredPosts = posts.map((post) => {
        // Location score (closer = higher, e.g., 1 / (distance_km + 1))
        const distance = this.haversine(
          userLat,
          userLon,
          post.latitude,
          post.longitude,
        );
        const locationScore = 1 / (distance + 1);

        // Timing score
        const dayjs = require('dayjs');
        const hoursSinceCreated = Math.abs(
          dayjs().diff(dayjs(post.created_at), 'hour'),
        );
        const timingScore = 1 / (hoursSinceCreated + 1);

        // Participant number
        const participantScore = Number(post.participant_count) || 0;

        // Jaccard index for interests
        const postInterestsSet = postInterestMap[post.id] || new Set();
        const jaccardScore = this.jaccard(userInterestsSet, postInterestsSet);

        // Friend with owner
        const friendWithOwnerScore = userFriendsSet.has(post.user_id) ? 1 : 0;

        // Friends with participants
        const postParticipantsSet = postParticipantMap[post.id] || new Set();
        const friendsWithParticipantsScore = [...postParticipantsSet].filter(
          (pid) => userFriendsSet.has(pid),
        ).length;

        // Participant of club
        const clubParticipantScore =
          post.club_id && userClubsSet.has(post.club_id) ? 1 : 0;

        // Boost for partner
        const boost = post.user_role === 'partner' ? 2 : 1;

        // Final score (tune weights as needed)
        const score =
          locationScore * 2 +
          timingScore * 2 +
          participantScore * 1 +
          jaccardScore * 3 +
          friendWithOwnerScore * 2 +
          friendsWithParticipantsScore * 1 +
          clubParticipantScore * 1 +
          boost;

        return { postId: post.id, score };
      });

      // Sort and take top N (e.g., 500)
      const top = scoredPosts.sort((a, b) => b.score - a.score).slice(0, 500);

      // Store in Redis
      const redisKey = `personalized:feed:${userId}`;
      await this.cacheManager.set(
        redisKey,
        top.map((p) => p.postId),
        60 * 60 * 1000,
      ); // 1 hour TTL
    }
  }
}

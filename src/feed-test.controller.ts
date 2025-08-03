// // src/feed-test.controller.ts
// import { Controller, Post, Get, Param, Logger } from '@nestjs/common';
// import { FeedJobsService } from './jobs/feed.jobs';

// @Controller('feed-test')
// export class FeedTestController {
//   private readonly logger = new Logger(FeedTestController.name);

//   constructor(private readonly feedJobsService: FeedJobsService) {}

//   @Post('update-trending-posts')
//   async updateTrendingPosts() {
//     this.logger.log('Manual trigger: updateTrendingPosts');
//     try {
//       await this.feedJobsService.updateTrendingPosts();
//       return { 
//         success: true, 
//         message: 'updateTrendingPosts completed successfully',
//         timestamp: new Date().toISOString()
//       };
//     } catch (error) {
//       this.logger.error('updateTrendingPosts failed:', error);
//       return { 
//         success: false, 
//         error: error.message,
//         timestamp: new Date().toISOString()
//       };
//     }
//   }

//   @Post('pre-populate-all-feeds')
//   async prePopulateAllActiveUsersFeeds() {
//     this.logger.log('Manual trigger: prePopulateAllActiveUsersFeeds');
//     try {
//       await this.feedJobsService.prePopulateAllActiveUsersFeeds();
//       return { 
//         success: true, 
//         message: 'prePopulateAllActiveUsersFeeds completed successfully',
//         timestamp: new Date().toISOString()
//       };
//     } catch (error) {
//       this.logger.error('prePopulateAllActiveUsersFeeds failed:', error);
//       return { 
//         success: false, 
//         error: error.message,
//         timestamp: new Date().toISOString()
//       };
//     }
//   }

//   @Post('pre-populate-feeds-in-range/:postId')
//   async prePopulateUserFeedsInRange(@Param('postId') postId: string) {
//     this.logger.log(`Manual trigger: prePopulateUserFeedsInRange for post ${postId}`);
//     try {
//       await this.feedJobsService.prePopulateUserFeedsInRange(postId);
//       return { 
//         success: true, 
//         message: `prePopulateUserFeedsInRange completed successfully for post ${postId}`,
//         postId,
//         timestamp: new Date().toISOString()
//       };
//     } catch (error) {
//       this.logger.error(`prePopulateUserFeedsInRange failed for post ${postId}:`, error);
//       return { 
//         success: false, 
//         error: error.message,
//         postId,
//         timestamp: new Date().toISOString()
//       };
//     }
//   }

//   @Get('health')
//   async health() {
//     return { 
//       status: 'ok', 
//       service: 'FeedTestController',
//       timestamp: new Date().toISOString()
//     };
//   }

//   @Get('mixpanel-users')
//   async getMixpanelUsers() {
//     this.logger.log('Manual trigger: fetchAllMixpanelCohortUsers');
//     try {
//       const userIds = await this.feedJobsService.fetchAllMixpanelCohortUsers();
//       return { 
//         success: true, 
//         count: userIds.length,
//         userIds: userIds.slice(0, 10), // Return first 10 for preview
//         timestamp: new Date().toISOString()
//       };
//     } catch (error) {
//       this.logger.error('fetchAllMixpanelCohortUsers failed:', error);
//       return { 
//         success: false, 
//         error: error.message,
//         timestamp: new Date().toISOString()
//       };
//     }
//   }
// } 
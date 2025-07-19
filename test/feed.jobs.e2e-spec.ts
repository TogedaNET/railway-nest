import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { FeedJobsService } from '../src/jobs/feed.jobs';

describe('FeedJobsService Cron', () => {
  let service: FeedJobsService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    service = module.get<FeedJobsService>(FeedJobsService);
  });

  it('should run updateTrendingPosts', async () => {
    await service.updateTrendingPosts();
    // Add assertions or checks as needed
  });

  it('should run prePopulateAllActiveUsersFeeds', async () => {
    await service.prePopulateAllActiveUsersFeeds();
    // Add assertions or checks as needed
  });
});

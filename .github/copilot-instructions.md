# Copilot Instructions for Railway-Nest

## Project Overview
This is a NestJS-based social feed management service for Togeda, a location-based social platform. The service generates personalized feeds using geospatial clustering, handles real-time events via Redis pub/sub, and manages automated email notifications.

## Architecture & Data Flow

### Core Service: FeedJobsService (`src/jobs/feed.jobs.ts`)
The heart of the application with three key responsibilities:

1. **Trending Post Generation** (cron: every 6 hours)
   - Clusters posts by geohash (precision 2 = ~625km radius)
   - Scores posts using: timing (50 / days_since_created), popularity (participant_count × 0.5 + view_count × 0.02, capped at 50), boosted multiplier (2x if boosted, 1x otherwise)
   - Stores top 500 per cluster in Redis geospatial index with scores in sorted set
   - **Critical**: Includes "travel posts" in clusters where `user_current_location` (creator's location) falls within the cluster's geohash, not just the event location

2. **Personalized Feed Pre-population** (cron: daily at 2AM, or on-demand via events)
   - Fetches active users from Mixpanel cohort API (cohort ID: 5666308)
   - For each user, scores posts within 500km using combined signals:
     - Location score (20 points max, linear decay by distance)
     - Timing score (20 / days_since_created)
     - Popularity score (capped at 10)
     - Interest overlap via Jaccard similarity (10 points max)
     - Social signals: friend is owner (15), friends are participants (15 max), user's club event (15)
     - Multiplied by 2x if post is boosted
   - Caches top 500 per user in Redis with 3-day TTL at `personalized:feed:{userId}`
   - **Critical**: Includes travel posts where creator's `user_current_location` is within 500km of user, even if event location is further

3. **Redis Event Processing** (pub/sub subscribers)
   - Events are handled by dedicated handler classes in `src/jobs/event-handlers/`
   - `post.created` → triggers `prePopulateUserFeedsInRange()` for users within 500km
   - `post.boosted` → stores boost event in Redis with 1-day TTL, sends SES email to post owner, triggers range update
   - `paymentIntent.succeeded` → sends SES ticket confirmation email
   - `user.finalizeSignUp` → sends SES welcome email
   - `user.updateFeed` → triggers single-user feed cache update
   - `user.delete` → cleans up user data across system (implementation pending)

### Database Patterns
- **Direct SQL, no ORM**: All queries use `pg.Pool` connections with parameterized queries (`$1`, `$2`)
- **Location columns**: 
  - Standard lat/lon: `latitude`, `longitude` (float columns)
  - PostGIS geography: `user_current_location`, `user_last_known_location` (accessed via `ST_Y(col::geometry)` for lat, `ST_X(col::geometry)` for lon)
- **Key relationships**:
  - Users have interests (many-to-many via `user_interests`)
  - Posts have participants (`post_participant`) and interests (`post_interests`)
  - Users belong to clubs (`club_member`) and have friends (`user_friends`)
- **Role system**: `user_info.user_role` includes `partner` role that gets boost multiplier in trending calculations

### Redis Data Structures
- `post:boosted:{postId}` → JSON with `{ postId, type, timestamp }`, TTL: 1 day
- `personalized:feed:{userId}` → JSON with `{ post_ids: [], version, created_at, total_posts }`, TTL: 3 days
- `trending:geoindex` → geospatial index (GEOPOS/GEORADIUS commands), TTL: 1 day
- `trending:geoindex:scores` → sorted set with post scores
- `analytics:post:views` → hash map of post view counts
- **Pub/sub channels**: `post.created`, `post.boosted`, `paymentIntent.succeeded`, `user.finalizeSignUp`, `user.updateFeed`, `user.delete`
- **Node-redis v4+ requires duplicate client for pub/sub** (see `initRedisSubscriber()`)

### Event Handler Architecture
- **Location**: `src/jobs/event-handlers/`
- **Base class**: `BaseRedisEventHandler` provides common parsing logic for double-JSON encoded messages
- **Pattern**: Each event has dedicated handler class implementing `IRedisEventHandler` interface
- **Handler classes**:
  - `PostCreatedEventHandler` - triggers feed updates for nearby users
  - `PostBoostedEventHandler` - stores boost, sends notification, updates feeds
  - `PaymentIntentSucceededEventHandler` - sends ticket confirmation emails
  - `UserFinalizeSignUpEventHandler` - sends welcome emails
  - `UserUpdateFeedEventHandler` - regenerates single user feed
  - `UserDeleteEventHandler` - user data cleanup (implementation pending)
- **Instantiation**: Handlers are created in `FeedJobsService` constructor and passed necessary dependencies

### External Integrations
- **Mixpanel Engage API**: Fetches active user cohort with pagination (session_id required after first page)
- **AWS SES**: Email notifications via `SesService` (only sends if `ENVIRONMENT_NAME == 'PROD'`)
- **Better Stack**: Structured logging via Pino with `@logtail/pino` transport

## Development Workflows

### Running Tests
```bash
# E2E tests (requires live DB/Redis connections)
npm run test:e2e

# Run specific cron job test
npm run test:e2e -- -t "updateTrendingPosts" --forceExit

# Unit tests
npm run test
npm run test:cov  # with coverage
```

### Local Development
```bash
npm run start:dev  # watch mode with hot reload
```

### Required Environment Variables
```bash
# PostgreSQL
POSTGRESHOST=<host>
POSTGRESPORT=5432
POSTGRESUSER=<user>
POSTGRESPASSWORD=<password>
POSTGRESDB=<database>

# Redis (must support TLS)
REDISURL=redis://...

# Mixpanel
MIXPANEL_API_KEY=<base64 encoded>

# AWS SES (eu-central-1 region)
AWS_REGION=eu-central-1
AWS_ACCESS_KEY_ID=<key>
AWS_SECRET_ACCESS_KEY=<secret>
SES_FROM_EMAIL=info@togeda.net
ENVIRONMENT_NAME=PROD  # only send emails in PROD

# Better Stack (optional)
BETTER_STACK_TOKEN=<token>
BETTER_STACK_ENDPOINT=<endpoint>
```

## Critical Implementation Details

### Geospatial Calculations
- **Haversine formula**: `haversine(lat1, lon1, lat2, lon2)` returns distance in km
- **ngeohash library**: `ngeohash.encode(lat, lon, precision)` for clustering
- **Valid coordinate ranges**: lon: [-180, 180], lat: [-85.05112878, 85.05112878] (Redis GEOPOS limits)
- **Distance threshold**: 500km for feed population and post range updates

### Event Message Parsing
All Redis pub/sub messages are **double-JSON encoded strings**:
```typescript
JSON.parse(JSON.parse(message))  // correct
```

### Scoring Algorithm Weights (as of current implementation)
- Location: 0-20 points (linear decay over 500km)
- Timing: 0-20 points (20 / (days_since_created + 1))
- Popularity: 0-10 points (0.5 × participants + 0.02 × views, capped)
- Interest Jaccard: 0-10 points
- Friend is owner: 15 points
- Friends are participants: 0-15 points (1 per friend, capped)
- User's club event: 15 points
- Boosted multiplier: 2x (1 day TTL)

### Email Templates
All SES emails follow pattern:
```typescript
await sesService.sendHtmlEmail(
  email,
  subject,
  `<h1>Title</h1><p>Body</p>`,  // HTML body
  'Plain text fallback',         // text body
);
```

## Common Patterns & Conventions

- **Logger**: Use NestJS Logger with context: `private readonly logger = new Logger(ClassName.name, { timestamp: true })`
- **Cron guards**: Check `isRunning` flag to prevent concurrent executions
- **Batch Redis operations**: Use `.multi()` pipeline for bulk writes
- **Error handling**: Log errors with context, don't throw in event handlers
- **Testing**: E2E tests import full `AppModule`, no mocking of DB/Redis
- **Event handlers**: Extend `BaseRedisEventHandler` for new Redis pub/sub events, inject dependencies via constructor

## Debugging Tips

- Check `analytics:post:views` hash for view count data
- Scan Redis for `post:boosted:*` keys to see active boosts
- Query `user_info` table for `user_last_known_location` vs `latitude/longitude` to debug location issues
- Use `npm run test:e2e -- -t "updateTrendingPosts" --forceExit` to test trending calculation in isolation
- Mixpanel API rate limits: handle pagination carefully with `session_id` and `page` params

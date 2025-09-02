# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
- `npm run start:dev` - Start development server with watch mode
- `npm run start` - Start production server
- `npm run build` - Build the application
- `npm run format` - Format code with Prettier

### Testing  
- `npm run test` - Run unit tests
- `npm run test:watch` - Run tests in watch mode
- `npm run test:cov` - Run tests with coverage
- `npm run test:e2e` - Run end-to-end tests
- `npm run test:e2e -- -t "updateTrendingPosts" --forceExit` - Run specific e2e test

### Code Quality
- `npm run lint` - Run ESLint with auto-fix

## Architecture Overview

This is a NestJS application focused on social feed management and geospatial operations for a location-based social platform. The core functionality revolves around:

### Key Components

**FeedJobsService** (`src/jobs/feed.jobs.ts`)
- Handles automated feed generation with geospatial clustering using geohash
- Manages trending posts calculation based on timing, popularity, and partner boost
- Processes Redis pub/sub events for post creation and boosting
- Integrates with Mixpanel API for active user cohort data
- Implements personalized feed scoring using Jaccard similarity for interests

**Redis Integration** (`src/redis/redis.module.ts`)
- Global Redis client with TLS connection
- Used for caching personalized feeds, trending posts geospatial index, and pub/sub messaging
- Stores boosted post events with TTL

### Database Schema
The application works with a PostgreSQL database containing social platform entities:
- User system: `user_info`, `user_interests`, `user_friends`
- Posts: `post`, `post_participant`, `post_interests`
- Social features: `club`, `club_member`

### Cron Jobs
- `updateTrendingPosts()` - Daily at 2AM, clusters posts by geohash and scores them
- `prePopulateAllActiveUsersFeeds()` - Every 6 hours, generates personalized feeds for all active users

### Environment Variables Required
- PostgreSQL connection: `POSTGRESHOST`, `POSTGRESPORT`, `POSTGRESUSER`, `POSTGRESPASSWORD`, `POSTGRESDB`
- Redis: `REDISURL`
- Mixpanel: `MIXPANEL_API_KEY`
- Axiom logging: `AXIOM_TOKEN`, `AXIOM_DATASET` (optional, defaults to 'railway-nest-logs')

### Geospatial Operations
- Uses ngeohash library for location clustering
- Haversine distance calculations for proximity-based filtering (500km radius)
- Redis geospatial operations for trending posts index

## Development Notes

- Application runs on port 3000
- Uses TypeScript with experimental decorators
- Redis operations use node-redis v4+ with separate clients for pub/sub
- All database operations use raw SQL with pg Pool connections
- Scoring algorithms combine location, timing, social signals, and boost factors
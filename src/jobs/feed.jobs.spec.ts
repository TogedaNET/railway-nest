import { FeedJobsService } from './feed.jobs';

describe('FeedJobsService', () => {
  let service: FeedJobsService;

  beforeEach(() => {
    service = new FeedJobsService(null, null, null);
  });

  describe('jaccard', () => {
    it('should return 1 for identical sets', () => {
      const setA = new Set([1, 2, 3]);
      const setB = new Set([1, 2, 3]);
      expect(service['jaccard'](setA, setB)).toBe(1);
    });

    it('should return 0 for disjoint sets', () => {
      const setA = new Set([1, 2, 3]);
      const setB = new Set([4, 5, 6]);
      expect(service['jaccard'](setA, setB)).toBe(0);
    });

    it('should return correct value for partial overlap', () => {
      const setA = new Set([1, 2, 3]);
      const setB = new Set([2, 3, 4, 5]);
      // intersection: 2,3; union: 1,2,3,4,5 => 2/5
      expect(service['jaccard'](setA, setB)).toBeCloseTo(0.4);
    });
  });

  describe('haversine', () => {
    it('should return 0 for the same point', () => {
      expect(service['haversine'](0, 0, 0, 0)).toBeCloseTo(0);
    });

    it('should return correct distance for known points (London to Paris)', () => {
      // London: 51.5074° N, 0.1278° W
      // Paris: 48.8566° N, 2.3522° E
      // Expected distance ~343 km
      const dist = service['haversine'](51.5074, -0.1278, 48.8566, 2.3522);
      expect(dist).toBeGreaterThan(340);
      expect(dist).toBeLessThan(350);
    });

    it('should return correct distance for 1 degree latitude difference', () => {
      // 1 degree latitude ~111 km
      const dist = service['haversine'](0, 0, 1, 0);
      expect(dist).toBeGreaterThan(110);
      expect(dist).toBeLessThan(112);
    });
  });
});

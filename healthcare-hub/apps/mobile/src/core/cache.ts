import type { CrewJobDto, CrewTodayDto } from '@hub/contracts';
import type { Clock, LocalStore } from './ports';

const TODAY = 'crew:today';
const job = (id: string) => `crew:job:${id}`;

export interface CachedToday {
  today: CrewTodayDto;
  /** When the server last answered (drives "synced HH:MM" and the 30-minute offline start). */
  savedAt: Date;
}

/**
 * Cached shift data lives in the encrypted database until end of shift + 12 hours (server-supplied
 * `cacheUntil`). Patient contact details are cached only until the shift ends and are then gone,
 * even offline ("Only assigned patient details visible; disappear after shift window").
 */
export class CrewCache {
  constructor(
    private readonly store: LocalStore,
    private readonly clock: Clock,
  ) {}

  async saveToday(today: CrewTodayDto): Promise<void> {
    await this.store.setCache(
      TODAY,
      JSON.stringify({ today, savedAt: this.clock().toISOString() }),
      today.cacheUntil,
    );
  }

  async loadToday(): Promise<CachedToday | null> {
    const raw = await this.fresh(TODAY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { today: CrewTodayDto; savedAt: string };
    return { today: v.today, savedAt: new Date(v.savedAt) };
  }

  async saveJob(j: CrewJobDto, shiftEndsAt: string): Promise<void> {
    await this.store.setCache(job(j.id), JSON.stringify(j), shiftEndsAt);
  }

  async loadJob(id: string): Promise<CrewJobDto | null> {
    const raw = await this.fresh(job(id));
    return raw ? (JSON.parse(raw) as CrewJobDto) : null;
  }

  /** Other crew data (policies, profile) under the same expiry rules. */
  async save<T>(key: string, value: T, until: string): Promise<void> {
    await this.store.setCache(key, JSON.stringify(value), until);
  }
  async load<T>(key: string): Promise<T | null> {
    const raw = await this.fresh(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  private async fresh(key: string): Promise<string | null> {
    const c = await this.store.getCache(key);
    if (!c) return null;
    if (new Date(c.until).getTime() <= this.clock().getTime()) {
      await this.store.deleteCache(key);
      return null;
    }
    return c.value;
  }
}

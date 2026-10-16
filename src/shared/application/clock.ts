/** Source of the current time; injectable so tests can control it. */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

/** Source of new identifiers (time-ordered UUIDs in production). */
export abstract class IdGenerator {
  abstract next(): string;
}

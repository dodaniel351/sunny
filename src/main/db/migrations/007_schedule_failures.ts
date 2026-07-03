import type { Migration, MigrationDb } from '../migrate'

// Circuit breaker for the scheduler (autonomy hardening, 0.4.3). A schedule
// whose spawned task fails every firing would otherwise create a new failing
// card each cadence interval forever; this counter lets the scheduler track the
// streak and auto-disable the schedule after repeated consecutive failures.
// Additive (defaulted column) so existing rows migrate cleanly.
function up(db: MigrationDb): void {
  db.exec(`ALTER TABLE schedules ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0`)
}

export const migration007: Migration = {
  version: 7,
  name: 'schedule_failures',
  up
}

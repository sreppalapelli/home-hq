-- Stored size of each photo (full + small), so uploads can stop before R2's 10 GB free allowance.
ALTER TABLE photos ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;

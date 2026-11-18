-- v36 Staff › Training › Supervision: staff can request a booking; HR confirms supervisor + time.
ALTER TABLE supervision_booking
  ALTER COLUMN supervisor_user_id DROP NOT NULL;

ALTER TABLE supervision_booking
  ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES app_user(id);

ALTER TABLE supervision_booking DROP CONSTRAINT IF EXISTS supervision_booking_status_check;
ALTER TABLE supervision_booking
  ADD CONSTRAINT supervision_booking_status_check
  CHECK (status IN ('REQUESTED', 'BOOKED', 'HELD', 'CANCELLED', 'MISSED'));

-- BOOKED and REQUESTED stay open (no closer); others must record who closed them.
ALTER TABLE supervision_booking DROP CONSTRAINT IF EXISTS supervision_booking_check;
-- Recreate the open/closed pairing without the old BOOKED-only rule.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'supervision_booking'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%closed_by%'
  LOOP
    EXECUTE format('ALTER TABLE supervision_booking DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE supervision_booking
  ADD CONSTRAINT supervision_booking_closed_pair
  CHECK ((status IN ('REQUESTED', 'BOOKED')) = (closed_by IS NULL));

ALTER TABLE supervision_booking
  ADD CONSTRAINT supervision_booking_requested_supervisor
  CHECK (status = 'REQUESTED' OR supervisor_user_id IS NOT NULL);

ALTER TABLE supervision_booking
  ADD CONSTRAINT supervision_booking_requested_by
  CHECK (status <> 'REQUESTED' OR requested_by IS NOT NULL);

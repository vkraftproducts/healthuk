-- v36 Onboarding › Evidence review: where the upload came from (staff app, candidate portal, office).
ALTER TABLE evidence_version
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'OFFICE'
    CHECK (channel IN ('STAFF_APP', 'CANDIDATE_PORTAL', 'OFFICE'));

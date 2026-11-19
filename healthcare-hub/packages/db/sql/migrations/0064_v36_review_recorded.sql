-- v36 keeps appraisals and probation reviews as "Done" without an outcome (S.rev: APR-31 has
-- on, by and objectives but no `out`). Moving the saved copy in must keep them: 'RECORDED' (done,
-- no outcome chosen) is allowed for every kind of review, as it already was for 'OTHER'.
ALTER TABLE staff_review DROP CONSTRAINT staff_review_check2;
ALTER TABLE staff_review ADD CONSTRAINT staff_review_check2 CHECK (kind NOT IN ('PROBATION_3M', 'PROBATION_6M')
  OR outcome IS NULL OR outcome IN ('PASSED', 'EXTENDED', 'NOT_PASSED', 'RECORDED'));
ALTER TABLE staff_review DROP CONSTRAINT staff_review_check3;
ALTER TABLE staff_review ADD CONSTRAINT staff_review_check3 CHECK (kind <> 'APPRAISAL'
  OR outcome IS NULL OR outcome IN ('MEETS', 'EXCEEDS', 'NEEDS_SUPPORT', 'RECORDED'));

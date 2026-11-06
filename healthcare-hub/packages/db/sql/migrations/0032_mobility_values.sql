-- E1: own wheelchair (travels in the patient's chair, needs a wheelchair space) and bariatric
-- (needs a vehicle and stretcher rated for the patient's weight).
ALTER TYPE mobility ADD VALUE IF NOT EXISTS 'OWN_WHEELCHAIR';
ALTER TYPE mobility ADD VALUE IF NOT EXISTS 'BARIATRIC';

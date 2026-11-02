-- 0002: let a user see the organisations and roles they hold a membership in, so the API can
-- build the organisation switcher and /me before an organisation has been selected.
-- Read-only; no write access is widened.
CREATE POLICY organisation_member_read ON organisation FOR SELECT
  USING (id IN (SELECT m.organisation_id FROM membership m WHERE m.user_id = app_user_id()));

CREATE POLICY role_member_read ON role FOR SELECT
  USING (id IN (SELECT m.role_id FROM membership m WHERE m.user_id = app_user_id()));

CREATE POLICY role_permission_member_read ON role_permission FOR SELECT
  USING (role_id IN (SELECT m.role_id FROM membership m WHERE m.user_id = app_user_id()));

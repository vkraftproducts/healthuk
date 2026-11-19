-- v36 Support access (S.sg) shows who was given access by their email. A platform support user is
-- not a member of the organisation, so app_user's tenant policy hides their row. This function
-- returns that email for one of the organisation's own grants only (nothing else is readable).
CREATE OR REPLACE FUNCTION support_grant_email(p_grant uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.email
    FROM support_access_grant g JOIN app_user u ON u.id = g.support_user_id AND u.is_platform_support
   WHERE g.id = p_grant AND g.organisation_id = app_org_id()
$$;
REVOKE ALL ON FUNCTION support_grant_email(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION support_grant_email(uuid) TO hub_app;

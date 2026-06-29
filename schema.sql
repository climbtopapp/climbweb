-- Create Profiles Table
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  email text,
  first_name text,
  gender text,
  vote_preference text DEFAULT 'everyone',
  avatar_url text,
  latitude double precision,
  longitude double precision,
  state text,
  elo double precision NOT NULL DEFAULT 1200.0,
  votes_cast integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Enable RLS on Profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Profiles Policies
CREATE POLICY "Public profiles are viewable by everyone" ON public.profiles
  FOR SELECT USING (true);

CREATE POLICY "Users can insert their own profile" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can update their own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

-- Create Votes Table
CREATE TABLE public.votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voter_id uuid REFERENCES auth.users ON DELETE SET NULL,
  winner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  loser_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Enable RLS on Votes
ALTER TABLE public.votes ENABLE ROW LEVEL SECURITY;

-- Votes Policies
CREATE POLICY "Users can view their own votes" ON public.votes
  FOR SELECT USING (auth.uid() = voter_id);

CREATE POLICY "Authenticated users can insert votes" ON public.votes
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Create Leaderboard Snapshot Table for caching
CREATE TABLE public.leaderboard_snapshot (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  email text,
  first_name text,
  gender text,
  avatar_url text,
  state text,
  latitude double precision,
  longitude double precision,
  elo double precision NOT NULL,
  global_rank integer NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Enable RLS on Leaderboard Snapshot
ALTER TABLE public.leaderboard_snapshot ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view the leaderboard snapshot" ON public.leaderboard_snapshot
  FOR SELECT USING (true);

-- Create Leaderboard Status Table
CREATE TABLE public.leaderboard_status (
  id integer PRIMARY KEY CHECK (id = 1),
  last_updated timestamp with time zone NOT NULL
);

-- Enable RLS on Leaderboard Status
ALTER TABLE public.leaderboard_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view leaderboard status" ON public.leaderboard_status
  FOR SELECT USING (true);


-- --- Helper Functions & RPCs ---

-- 1. Geolocation distance calculator (Haversine formula in miles)
CREATE OR REPLACE FUNCTION public.calculate_distance(
  lat1 double precision, 
  lon1 double precision, 
  lat2 double precision, 
  lon2 double precision
) RETURNS double precision LANGUAGE sql IMMUTABLE SET search_path = public, pg_catalog AS $$
  -- 3959 is the Earth's radius in miles.
  -- Safe acos to handle floating point precision boundaries:
  SELECT 3959.0 * acos(
    least(1.0, greatest(-1.0, 
      cos(radians(lat1)) * cos(radians(lat2)) * cos(radians(lon2) - radians(lon1)) + 
      sin(radians(lat1)) * sin(radians(lat2))
    ))
  );
$$;

-- 2. Automatic Profile creation on Auth signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, elo, votes_cast)
  VALUES (
    new.id, 
    new.email, 
    1200.0, 
    0
  );
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- 3. Get two random profiles for comparison (filtered by gender preference, excludes recently seen)
CREATE OR REPLACE FUNCTION public.get_matchup(voter_id uuid, pref text DEFAULT 'everyone')
RETURNS TABLE (
  id uuid,
  avatar_url text,
  elo double precision,
  first_name text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF pref = 'everyone' THEN
    RETURN QUERY
    SELECT p.id, p.avatar_url, p.elo, p.first_name
    FROM public.profiles p
    WHERE p.id != voter_id AND p.avatar_url IS NOT NULL
      AND p.id NOT IN (
        SELECT v.winner_id FROM public.votes v WHERE v.voter_id = get_matchup.voter_id AND v.created_at > now() - interval '15 minutes'
        UNION
        SELECT v.loser_id FROM public.votes v WHERE v.voter_id = get_matchup.voter_id AND v.created_at > now() - interval '15 minutes'
      )
    ORDER BY random()
    LIMIT 2;
  ELSE
    RETURN QUERY
    SELECT p.id, p.avatar_url, p.elo, p.first_name
    FROM public.profiles p
    WHERE p.id != voter_id AND p.avatar_url IS NOT NULL AND p.gender = pref
      AND p.id NOT IN (
        SELECT v.winner_id FROM public.votes v WHERE v.voter_id = get_matchup.voter_id AND v.created_at > now() - interval '15 minutes'
        UNION
        SELECT v.loser_id FROM public.votes v WHERE v.voter_id = get_matchup.voter_id AND v.created_at > now() - interval '15 minutes'
      )
    ORDER BY random()
    LIMIT 2;
  END IF;
END;
$$;


-- 4. Cast a vote and update Chess ELO rating
CREATE OR REPLACE FUNCTION public.cast_vote(winner_id uuid, loser_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  voter_id uuid;
  r_w double precision;
  r_l double precision;
  e_w double precision;
  e_l double precision;
  k constant integer := 32;
BEGIN
  voter_id := auth.uid();
  
  -- Get current ELO ratings
  SELECT elo INTO r_w FROM public.profiles WHERE id = winner_id;
  SELECT elo INTO r_l FROM public.profiles WHERE id = loser_id;
  
  IF r_w IS NULL OR r_l IS NULL THEN
    RAISE EXCEPTION 'Winner or loser profile not found';
  END IF;
  
  -- Expected outcomes
  e_w := 1.0 / (1.0 + power(10.0, (r_l - r_w) / 400.0));
  e_l := 1.0 / (1.0 + power(10.0, (r_w - r_l) / 400.0));
  
  -- Update ELOs in profiles
  UPDATE public.profiles SET elo = elo + k * (1.0 - e_w) WHERE id = winner_id;
  UPDATE public.profiles SET elo = elo + k * (0.0 - e_l) WHERE id = loser_id;
  
  -- Insert vote log
  INSERT INTO public.votes (voter_id, winner_id, loser_id)
  VALUES (voter_id, winner_id, loser_id);
  
  -- Increment voter's vote count if logged in
  IF voter_id IS NOT NULL THEN
    UPDATE public.profiles SET votes_cast = votes_cast + 1 WHERE id = voter_id;
  END IF;
END;
$$;


-- 5. Lazy Leaderboard snapshot refresh (Hourly check)
CREATE OR REPLACE FUNCTION public.refresh_leaderboard_if_needed()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  last_upd timestamp with time zone;
  should_refresh boolean := false;
BEGIN
  SELECT last_updated INTO last_upd FROM public.leaderboard_status WHERE id = 1;
  
  IF last_upd IS NULL OR last_upd < now() - interval '1 hour' THEN
    should_refresh := true;
  END IF;
  
  IF should_refresh THEN
    -- Clear old snapshot
    DELETE FROM public.leaderboard_snapshot;
    
    -- Insert fresh rankings
    INSERT INTO public.leaderboard_snapshot (user_id, email, avatar_url, state, latitude, longitude, elo, global_rank, first_name, gender)
    SELECT 
      p.id, 
      p.email, 
      p.avatar_url, 
      p.state, 
      p.latitude, 
      p.longitude, 
      p.elo,
      row_number() OVER (ORDER BY p.elo DESC)::integer as global_rank,
      p.first_name,
      p.gender
    FROM public.profiles p
    WHERE p.avatar_url IS NOT NULL;
    
    -- Update status
    INSERT INTO public.leaderboard_status (id, last_updated)
    VALUES (1, now())
    ON CONFLICT (id) DO UPDATE SET last_updated = EXCLUDED.last_updated;
  END IF;
END;
$$;


-- 6. Retrieve paginated leaderboards
CREATE OR REPLACE FUNCTION public.get_leaderboard_data(
  viewer_id uuid,
  viewer_lat double precision,
  viewer_lon double precision,
  viewer_state text,
  lb_type text
)
RETURNS TABLE (
  user_id uuid,
  avatar_url text,
  state text,
  elo double precision,
  global_rank integer,
  relative_rank integer,
  first_name text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Perform hourly refresh check
  PERFORM public.refresh_leaderboard_if_needed();
  
  IF lb_type = 'global' THEN
    RETURN QUERY
    SELECT 
      ls.user_id,
      ls.avatar_url,
      ls.state,
      ls.elo,
      ls.global_rank,
      ls.global_rank as relative_rank,
      ls.first_name
    FROM public.leaderboard_snapshot ls
    ORDER BY ls.global_rank ASC
    LIMIT 99;
    
  ELSIF lb_type = 'state' THEN
    RETURN QUERY
    SELECT 
      ls.user_id,
      ls.avatar_url,
      ls.state,
      ls.elo,
      ls.global_rank,
      row_number() OVER (ORDER BY ls.global_rank ASC)::integer as relative_rank,
      ls.first_name
    FROM public.leaderboard_snapshot ls
    WHERE ls.state = viewer_state
    ORDER BY ls.global_rank ASC
    LIMIT 99;
  END IF;
END;
$$;


-- 7. Get user specific rankings across all three categories
CREATE OR REPLACE FUNCTION public.get_user_ranks(
  user_id_param uuid,
  viewer_lat double precision,
  viewer_lon double precision,
  viewer_state text
)
RETURNS TABLE (
  global_rank integer,
  state_rank integer,
  neighborhood_rank integer,
  total_global integer,
  total_state integer,
  total_neighborhood integer
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.refresh_leaderboard_if_needed();
  
  RETURN QUERY
  WITH global_stats AS (
    SELECT 
      ls.global_rank as g_rank,
      (SELECT count(*)::integer FROM public.leaderboard_snapshot) as g_total
    FROM public.leaderboard_snapshot ls
    WHERE ls.user_id = user_id_param
  ),
  state_stats AS (
    SELECT 
      s.sub_rank::integer as s_rank,
      s.sub_total::integer as s_total
    FROM (
      SELECT 
        ls2.user_id,
        row_number() OVER (ORDER BY ls2.global_rank ASC) as sub_rank,
        count(*) OVER () as sub_total
      FROM public.leaderboard_snapshot ls2
      WHERE ls2.state = viewer_state
    ) s
    WHERE s.user_id = user_id_param
  )
  SELECT 
    coalesce((SELECT g_rank FROM global_stats), 0),
    coalesce((SELECT s_rank FROM state_stats), 0),
    0,
    coalesce((SELECT g_total FROM global_stats), 0),
    coalesce((SELECT s_total FROM state_stats), 0),
    0;
END;
$$;

-- 8. Retrieve surrounding leaderboards (9 above, 9 below)
CREATE OR REPLACE FUNCTION public.get_surrounding_leaderboard(
  user_id_param uuid,
  viewer_lat double precision,
  viewer_lon double precision,
  viewer_state text,
  lb_type text
)
RETURNS TABLE (
  user_id uuid,
  avatar_url text,
  state text,
  elo double precision,
  global_rank integer,
  relative_rank integer,
  first_name text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  target_rank integer;
BEGIN
  PERFORM public.refresh_leaderboard_if_needed();

  IF lb_type = 'global' THEN
    SELECT ls.global_rank INTO target_rank FROM public.leaderboard_snapshot ls WHERE ls.user_id = user_id_param;
    
    RETURN QUERY
    SELECT 
      ls.user_id, ls.avatar_url, ls.state, ls.elo, ls.global_rank, ls.global_rank as relative_rank, ls.first_name
    FROM public.leaderboard_snapshot ls
    WHERE ls.global_rank >= target_rank - 9 AND ls.global_rank <= target_rank + 9
    ORDER BY ls.global_rank ASC;

  ELSIF lb_type = 'state' THEN
    SELECT sub_rank INTO target_rank
    FROM (
      SELECT ls2.user_id, row_number() OVER (ORDER BY ls2.global_rank ASC) as sub_rank
      FROM public.leaderboard_snapshot ls2 WHERE ls2.state = viewer_state
    ) s WHERE s.user_id = user_id_param;

    RETURN QUERY
    SELECT * FROM (
      SELECT 
        ls.user_id, ls.avatar_url, ls.state, ls.elo, ls.global_rank, 
        row_number() OVER (ORDER BY ls.global_rank ASC)::integer as relative_rank, ls.first_name
      FROM public.leaderboard_snapshot ls WHERE ls.state = viewer_state
    ) t
    WHERE t.relative_rank >= target_rank - 9 AND t.relative_rank <= target_rank + 9
    ORDER BY t.relative_rank ASC;

  ELSIF lb_type = 'neighborhood' THEN
    SELECT sub_rank INTO target_rank
    FROM (
      SELECT ls3.user_id, row_number() OVER (ORDER BY ls3.global_rank ASC) as sub_rank
      FROM public.leaderboard_snapshot ls3 
      WHERE public.calculate_distance(viewer_lat, viewer_lon, ls3.latitude, ls3.longitude) <= 5.0
    ) s WHERE s.user_id = user_id_param;

    RETURN QUERY
    SELECT * FROM (
      SELECT 
        ls.user_id, ls.avatar_url, ls.state, ls.elo, ls.global_rank, 
        row_number() OVER (ORDER BY ls.global_rank ASC)::integer as relative_rank, ls.first_name
      FROM public.leaderboard_snapshot ls 
      WHERE public.calculate_distance(viewer_lat, viewer_lon, ls.latitude, ls.longitude) <= 5.0
    ) t
    WHERE t.relative_rank >= target_rank - 9 AND t.relative_rank <= target_rank + 9
    ORDER BY t.relative_rank ASC;
  END IF;
END;
$$;


-- =============================================
-- Clubs Feature
-- =============================================

-- Clubs Table
CREATE TABLE public.clubs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text NOT NULL UNIQUE DEFAULT upper(substr(md5(random()::text), 1, 6)),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.clubs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view clubs" ON public.clubs
  FOR SELECT USING (true);

CREATE POLICY "Authenticated users can create clubs" ON public.clubs
  FOR INSERT WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Creators can update their club" ON public.clubs
  FOR UPDATE USING (auth.uid() = created_by);

CREATE POLICY "Creators can delete their club" ON public.clubs
  FOR DELETE USING (auth.uid() = created_by);

-- Club Members Table
CREATE TABLE public.club_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  joined_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  UNIQUE(club_id, user_id)
);

ALTER TABLE public.club_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view club members" ON public.club_members
  FOR SELECT USING (true);

CREATE POLICY "Users can insert themselves" ON public.club_members
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete themselves or creator can delete" ON public.club_members
  FOR DELETE USING (
    auth.uid() = user_id
    OR auth.uid() IN (SELECT c.created_by FROM public.clubs c WHERE c.id = club_id)
  );

-- Create a club (max 1 per user)
CREATE OR REPLACE FUNCTION public.create_club(club_name text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  new_club public.clubs;
  caller_id uuid := auth.uid();
BEGIN
  -- Check if user already created a club
  IF EXISTS (SELECT 1 FROM public.clubs WHERE created_by = caller_id) THEN
    RAISE EXCEPTION 'You have already created a club';
  END IF;

  -- Check if user is already in a club
  IF EXISTS (SELECT 1 FROM public.club_members WHERE user_id = caller_id) THEN
    RAISE EXCEPTION 'You must leave your current club before creating a new one';
  END IF;

  -- Create the club
  INSERT INTO public.clubs (name, created_by)
  VALUES (club_name, caller_id)
  RETURNING * INTO new_club;

  -- Add creator as a member
  INSERT INTO public.club_members (club_id, user_id)
  VALUES (new_club.id, caller_id);

  RETURN json_build_object(
    'id', new_club.id,
    'name', new_club.name,
    'code', new_club.code,
    'created_by', new_club.created_by
  );
END;
$$;

-- Join a club by invite code
CREATE OR REPLACE FUNCTION public.join_club(invite_code text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  target_club public.clubs;
  caller_id uuid := auth.uid();
BEGIN
  -- Check if user is already in a club
  IF EXISTS (SELECT 1 FROM public.club_members WHERE user_id = caller_id) THEN
    RAISE EXCEPTION 'You must leave your current club before joining another';
  END IF;

  -- Find the club
  SELECT * INTO target_club FROM public.clubs WHERE upper(code) = upper(invite_code);
  IF target_club.id IS NULL THEN
    RAISE EXCEPTION 'No club found with that code';
  END IF;

  -- Join the club
  INSERT INTO public.club_members (club_id, user_id)
  VALUES (target_club.id, caller_id);

  RETURN json_build_object(
    'id', target_club.id,
    'name', target_club.name,
    'code', target_club.code
  );
END;
$$;

-- Leave a club (if creator, deletes the club entirely)
CREATE OR REPLACE FUNCTION public.leave_club()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  caller_id uuid := auth.uid();
  member_club_id uuid;
  is_creator boolean;
BEGIN
  -- Find user's club
  SELECT cm.club_id INTO member_club_id
  FROM public.club_members cm WHERE cm.user_id = caller_id;

  IF member_club_id IS NULL THEN
    RAISE EXCEPTION 'You are not in a club';
  END IF;

  -- Check if user is the creator
  SELECT EXISTS (
    SELECT 1 FROM public.clubs WHERE id = member_club_id AND created_by = caller_id
  ) INTO is_creator;

  IF is_creator THEN
    -- Delete the club (cascade deletes all members)
    DELETE FROM public.clubs WHERE id = member_club_id;
  ELSE
    -- Just remove the member
    DELETE FROM public.club_members WHERE club_id = member_club_id AND user_id = caller_id;
  END IF;
END;
$$;

-- Remove a member from a club (creator only)
CREATE OR REPLACE FUNCTION public.remove_club_member(target_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  caller_id uuid := auth.uid();
  caller_club_id uuid;
BEGIN
  -- Verify caller is a club creator
  SELECT id INTO caller_club_id FROM public.clubs WHERE created_by = caller_id;
  IF caller_club_id IS NULL THEN
    RAISE EXCEPTION 'You are not the creator of any club';
  END IF;

  -- Cannot remove yourself (use leave_club instead)
  IF target_user_id = caller_id THEN
    RAISE EXCEPTION 'Use leave_club to leave your own club';
  END IF;

  -- Remove the member
  DELETE FROM public.club_members
  WHERE club_id = caller_club_id AND user_id = target_user_id;
END;
$$;

-- Update club name (creator only)
CREATE OR REPLACE FUNCTION public.update_club_name(new_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  caller_id uuid := auth.uid();
BEGIN
  UPDATE public.clubs SET name = new_name WHERE created_by = caller_id;
END;
$$;

-- Get user's club info + members
CREATE OR REPLACE FUNCTION public.get_my_club()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  caller_id uuid := auth.uid();
  member_club_id uuid;
  club_data json;
  members_data json;
BEGIN
  -- Find user's club
  SELECT cm.club_id INTO member_club_id
  FROM public.club_members cm WHERE cm.user_id = caller_id;

  IF member_club_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Get club info
  SELECT json_build_object(
    'id', c.id,
    'name', c.name,
    'code', c.code,
    'created_by', c.created_by,
    'created_at', c.created_at
  ) INTO club_data FROM public.clubs c WHERE c.id = member_club_id;

  -- Get members with profile info
  SELECT json_agg(
    json_build_object(
      'user_id', p.id,
      'first_name', p.first_name,
      'avatar_url', p.avatar_url,
      'elo', p.elo,
      'state', p.state,
      'joined_at', cm.joined_at
    ) ORDER BY p.elo DESC
  ) INTO members_data
  FROM public.club_members cm
  JOIN public.profiles p ON p.id = cm.user_id
  WHERE cm.club_id = member_club_id;

  RETURN json_build_object(
    'club', club_data,
    'members', COALESCE(members_data, '[]'::json)
  );
END;
$$;

-- Club leaderboard (returns members ranked by ELO, for Summit tab)
CREATE OR REPLACE FUNCTION public.get_club_leaderboard(target_club_id uuid)
RETURNS TABLE (
  user_id uuid,
  first_name text,
  avatar_url text,
  state text,
  elo double precision,
  relative_rank bigint
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id AS user_id,
    p.first_name,
    p.avatar_url,
    p.state,
    p.elo,
    ROW_NUMBER() OVER (ORDER BY p.elo DESC) AS relative_rank
  FROM public.club_members cm
  JOIN public.profiles p ON p.id = cm.user_id
  WHERE cm.club_id = target_club_id
  ORDER BY p.elo DESC;
END;
$$;

-- Get matchup filtered to club members only
CREATE OR REPLACE FUNCTION public.get_matchup_club(voter_id uuid, pref text DEFAULT 'everyone', filter_club_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  avatar_url text,
  elo double precision,
  first_name text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF pref = 'everyone' THEN
    RETURN QUERY
    SELECT p.id, p.avatar_url, p.elo, p.first_name
    FROM public.profiles p
    JOIN public.club_members cm ON cm.user_id = p.id AND cm.club_id = filter_club_id
    WHERE p.id != voter_id AND p.avatar_url IS NOT NULL
      AND p.id NOT IN (
        SELECT v.winner_id FROM public.votes v WHERE v.voter_id = get_matchup_club.voter_id AND v.created_at > now() - interval '15 minutes'
        UNION
        SELECT v.loser_id FROM public.votes v WHERE v.voter_id = get_matchup_club.voter_id AND v.created_at > now() - interval '15 minutes'
      )
    ORDER BY random()
    LIMIT 2;
  ELSE
    RETURN QUERY
    SELECT p.id, p.avatar_url, p.elo, p.first_name
    FROM public.profiles p
    JOIN public.club_members cm ON cm.user_id = p.id AND cm.club_id = filter_club_id
    WHERE p.id != voter_id AND p.avatar_url IS NOT NULL AND p.gender = pref
      AND p.id NOT IN (
        SELECT v.winner_id FROM public.votes v WHERE v.voter_id = get_matchup_club.voter_id AND v.created_at > now() - interval '15 minutes'
        UNION
        SELECT v.loser_id FROM public.votes v WHERE v.voter_id = get_matchup_club.voter_id AND v.created_at > now() - interval '15 minutes'
      )
    ORDER BY random()
    LIMIT 2;
  END IF;
END;
$$;


-- =============================================
-- Revoke execution from PUBLIC and grant to authenticated
-- =============================================

-- Revoke default public execution privileges
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refresh_leaderboard_if_needed() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.get_matchup(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cast_vote(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_leaderboard_data(uuid, double precision, double precision, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_user_ranks(uuid, double precision, double precision, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_surrounding_leaderboard(uuid, double precision, double precision, text, text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.create_club(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.join_club(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.leave_club() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.remove_club_member(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_club_name(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_my_club() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_club_leaderboard(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_matchup_club(uuid, text, uuid) FROM PUBLIC;

-- Grant execution to authenticated & service_role
GRANT EXECUTE ON FUNCTION public.get_matchup(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_matchup(uuid, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.cast_vote(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cast_vote(uuid, uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_leaderboard_data(uuid, double precision, double precision, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_leaderboard_data(uuid, double precision, double precision, text, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_user_ranks(uuid, double precision, double precision, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_ranks(uuid, double precision, double precision, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_surrounding_leaderboard(uuid, double precision, double precision, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_surrounding_leaderboard(uuid, double precision, double precision, text, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.create_club(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_club(text) TO service_role;

GRANT EXECUTE ON FUNCTION public.join_club(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_club(text) TO service_role;

GRANT EXECUTE ON FUNCTION public.leave_club() TO authenticated;
GRANT EXECUTE ON FUNCTION public.leave_club() TO service_role;

GRANT EXECUTE ON FUNCTION public.remove_club_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_club_member(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.update_club_name(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_club_name(text) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_my_club() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_club() TO service_role;

GRANT EXECUTE ON FUNCTION public.get_club_leaderboard(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_club_leaderboard(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_matchup_club(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_matchup_club(uuid, text, uuid) TO service_role;


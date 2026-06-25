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
) RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- 3. Get two random profiles for comparison (filtered by gender preference)
CREATE OR REPLACE FUNCTION public.get_matchup(voter_id uuid, pref text DEFAULT 'everyone')
RETURNS TABLE (
  id uuid,
  avatar_url text,
  elo double precision,
  first_name text
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF pref = 'everyone' THEN
    RETURN QUERY
    SELECT p.id, p.avatar_url, p.elo, p.first_name
    FROM public.profiles p
    WHERE p.id != voter_id AND p.avatar_url IS NOT NULL
    ORDER BY random()
    LIMIT 2;
  ELSE
    RETURN QUERY
    SELECT p.id, p.avatar_url, p.elo, p.first_name
    FROM public.profiles p
    WHERE p.id != voter_id AND p.avatar_url IS NOT NULL AND p.gender = pref
    ORDER BY random()
    LIMIT 2;
  END IF;
END;
$$;


-- 4. Cast a vote and update Chess ELO rating
CREATE OR REPLACE FUNCTION public.cast_vote(winner_id uuid, loser_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
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
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
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
) LANGUAGE plpgsql SECURITY DEFINER AS $$
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
    
  ELSIF lb_type = 'neighborhood' THEN
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
    WHERE public.calculate_distance(viewer_lat, viewer_lon, ls.latitude, ls.longitude) <= 5.0
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
) LANGUAGE plpgsql SECURITY DEFINER AS $$
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
  ),
  neighborhood_stats AS (
    SELECT 
      n.sub_rank::integer as n_rank,
      n.sub_total::integer as n_total
    FROM (
      SELECT 
        ls3.user_id,
        row_number() OVER (ORDER BY ls3.global_rank ASC) as sub_rank,
        count(*) OVER () as sub_total
      FROM public.leaderboard_snapshot ls3
      WHERE public.calculate_distance(viewer_lat, viewer_lon, ls3.latitude, ls3.longitude) <= 5.0
    ) n
    WHERE n.user_id = user_id_param
  )
  SELECT 
    coalesce((SELECT g_rank FROM global_stats), 0),
    coalesce((SELECT s_rank FROM state_stats), 0),
    coalesce((SELECT n_rank FROM neighborhood_stats), 0),
    coalesce((SELECT g_total FROM global_stats), 0),
    coalesce((SELECT s_total FROM state_stats), 0),
    coalesce((SELECT n_total FROM neighborhood_stats), 0);
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
) LANGUAGE plpgsql SECURITY DEFINER AS $$
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

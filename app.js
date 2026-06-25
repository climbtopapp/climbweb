// Supabase Configuration
const SUPABASE_URL = "https://kyeclvdgzigiwqimqdvg.supabase.co";
const SUPABASE_KEY = "sb_publishable_ZN4NvIXuymJ2QvbdQ5qDkg_BVf4q7Wz";

// Initialize Supabase Client
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Application State
const DEFAULT_AVATAR = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='12' r='12' fill='%23e6f0fa'/><circle cx='12' cy='8' r='4' fill='%2363a4ff'/><path d='M12 14c-4 0-6 2-6 3v1h12v-1c0-1-2-3-6-3z' fill='%2363a4ff'/></svg>";

let currentUser = null;
let currentProfile = null;
let currentMatchup = [];
let selectedRegistrationFileBlob = null;
let selectedRegistrationFileType = "image/jpeg";
let userCoordinates = { lat: null, lng: null };
let userState = "";
let userVotePreference = "everyone";
let currentLeaderboardTab = "global";

// DOM Elements
const screens = {
  loader: document.getElementById('screen-loader'),
  auth: document.getElementById('screen-auth'),
  register: document.getElementById('screen-register'),
  mash: document.getElementById('screen-mash'),
  leaderboard: document.getElementById('screen-leaderboard'),
  profile: document.getElementById('screen-profile')
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  initAuthListener();
});

// --- Auth State Listener ---
async function initAuthListener() {
  // Check initial session
  const { data: { session }, error } = await supabaseClient.auth.getSession();
  if (error) {
    console.error('Error fetching session:', error);
  }

  handleAuthStateChange(session?.user || null);

  // Listen for auth state modifications
  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    console.log('Auth state event:', event);
    handleAuthStateChange(session?.user || null);
  });
}

async function handleAuthStateChange(user) {
  currentUser = user;
  if (!user) {
    currentProfile = null;
    showScreen('auth');
    return;
  }

  // User is authenticated, check profile completion
  showScreen('loader');
  await fetchUserProfile();
}

async function fetchUserProfile() {
  if (!currentUser) return;

  try {
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', currentUser.id)
      .single();

    if (error) {
      // If profile doesn't exist yet, wait (it might be created by trigger)
      console.warn('Profile not found, retrying...');
      setTimeout(fetchUserProfile, 1000);
      return;
    }

    currentProfile = data;

    // Check if user has completed profile (photo + name + gender)
    if (!currentProfile.avatar_url || !currentProfile.first_name || !currentProfile.gender) {
      showScreen('register');
      initLocationDetection();
    } else {
      // Save location from profile
      userCoordinates.lat = currentProfile.latitude;
      userCoordinates.lng = currentProfile.longitude;
      userState = currentProfile.state || "Unknown State";
      userVotePreference = currentProfile.vote_preference || "everyone";

      // Go to main Mash screen
      showScreen('mash');
      loadNextMatchup();
    }
  } catch (err) {
    console.error('Error loading profile:', err);
    showToast('Failed to load profile. Please refresh.', 'error');
  }
}

// --- Screen Router ---
function showScreen(screenId) {
  Object.keys(screens).forEach(key => {
    if (key === screenId) {
      screens[key].classList.add('active');
    } else {
      screens[key].classList.remove('active');
    }
  });
}

// --- Event Listeners Setup ---
function setupEventListeners() {
  // Auth Form: Send Login Link (Magic Link)
  document.getElementById('form-email').addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailInput = document.getElementById('input-email').value.trim();
    if (!emailInput) return;

    setButtonLoading('btn-send-otp', true, 'Sending...');

    const { data, error } = await supabaseClient.auth.signInWithOtp({
      email: emailInput,
      options: {
        // Set the redirect URL to current location (which will automatically be parsed by Supabase SDK)
        emailRedirectTo: window.location.origin + window.location.pathname
      }
    });

    setButtonLoading('btn-send-otp', false, 'Send Login Link');

    if (error) {
      showToast(error.message, 'error');
    } else {
      showToast('Magic login link sent to your email!', 'success');
      document.getElementById('auth-step-email').classList.add('hidden');
      document.getElementById('auth-step-success').classList.remove('hidden');
    }
  });

  // Auth: Change email back button
  document.getElementById('btn-back-email').addEventListener('click', () => {
    document.getElementById('auth-step-success').classList.add('hidden');
    document.getElementById('auth-step-email').classList.remove('hidden');
  });

  // Registration Form: File picker preview & compression
  document.getElementById('input-avatar').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const placeholder = document.getElementById('avatar-preview-placeholder');
    const previewImg = document.getElementById('avatar-preview-img');

    try {
      showToast('Processing photo...', 'info');

      let imageBlob = file;
      let isCompressed = false;

      try {
        // Try compressing and cropping to a 500x500 square
        imageBlob = await compressImage(file, 500, 0.75);
        isCompressed = true;
      } catch (compressErr) {
        console.warn('Canvas compression/cropping failed, using raw file:', compressErr);
        imageBlob = file;
      }

      selectedRegistrationFileBlob = imageBlob;
      selectedRegistrationFileType = isCompressed ? 'image/jpeg' : file.type;

      previewImg.src = URL.createObjectURL(imageBlob);
      placeholder.classList.add('hidden');
      previewImg.classList.remove('hidden');

      checkRegistrationSubmittable();
    } catch (err) {
      console.error(err);
      showToast('Failed to process image. Try another one.', 'error');
    }
  });

  // Registration Form: New field change listeners
  document.getElementById('input-first-name').addEventListener('input', () => checkRegistrationSubmittable());
  document.getElementById('select-gender').addEventListener('change', () => checkRegistrationSubmittable());
  document.getElementById('select-vote-pref').addEventListener('change', () => checkRegistrationSubmittable());
  document.getElementById('select-state').addEventListener('change', () => checkRegistrationSubmittable());

  // Registration Form: Retry Location
  document.getElementById('btn-retry-location').addEventListener('click', () => {
    initLocationDetection();
  });

  // Registration Form: Submit Profile Setup
  document.getElementById('form-register').addEventListener('submit', async (e) => {
    e.preventDefault();
    const firstName = document.getElementById('input-first-name').value.trim();
    const gender = document.getElementById('select-gender').value;
    const votePref = document.getElementById('select-vote-pref').value;
    const selectedState = document.getElementById('select-state').value;

    if (!selectedRegistrationFileBlob || !userCoordinates.lat || !currentUser || !firstName || !gender || !votePref || !selectedState) return;

    setButtonLoading('btn-submit-registration', true, 'Uploading details...');

    try {
      // 1. Upload avatar to storage bucket 'avatars' in the user's specific folder
      let fileExt = 'jpg';
      if (selectedRegistrationFileType === 'image/png') {
        fileExt = 'png';
      } else if (selectedRegistrationFileType === 'image/svg+xml') {
        fileExt = 'svg';
      } else if (selectedRegistrationFileType === 'image/gif') {
        fileExt = 'gif';
      } else if (selectedRegistrationFileType === 'image/webp') {
        fileExt = 'webp';
      }

      const fileName = `${Date.now()}.${fileExt}`;
      const filePath = `${currentUser.id}/${fileName}`;

      const { error: uploadError } = await supabaseClient.storage
        .from('avatars')
        .upload(filePath, selectedRegistrationFileBlob, {
          cacheControl: '3600',
          contentType: selectedRegistrationFileType,
          upsert: true
        });

      if (uploadError) throw uploadError;

      // 2. Fetch public url
      const { data: { publicUrl } } = supabaseClient.storage
        .from('avatars')
        .getPublicUrl(filePath);

      // 3. Update profile row with all new fields
      const { error: profileError } = await supabaseClient
        .from('profiles')
        .update({
          avatar_url: publicUrl,
          first_name: firstName,
          gender: gender,
          vote_preference: votePref,
          latitude: userCoordinates.lat,
          longitude: userCoordinates.lng,
          state: selectedState
        })
        .eq('id', currentUser.id);

      if (profileError) throw profileError;

      userState = selectedState;
      userVotePreference = votePref;
      showToast('Profile ready! Welcome to Climb.', 'success');

      // Fetch latest profile state and navigate
      await fetchUserProfile();

    } catch (err) {
      console.error('Registration failed:', err);
      showToast(err.message || 'Failed to complete registration.', 'error');
    } finally {
      setButtonLoading('btn-submit-registration', false, 'Start Climbing');
    }
  });

  // Navigation Items
  document.querySelectorAll('.bottom-nav .nav-item').forEach(button => {
    button.addEventListener('click', (e) => {
      const targetScreen = e.currentTarget.getAttribute('data-screen');
      if (targetScreen) {
        showScreen(targetScreen);
        if (targetScreen === 'mash') {
          // If matchup list is empty, reload
          if (currentMatchup.length === 0) loadNextMatchup();
        } else if (targetScreen === 'leaderboard') {
          loadLeaderboard();
        } else if (targetScreen === 'profile') {
          loadProfileData();
        }
      }
    });
  });

  // Mash voting click triggers
  document.getElementById('card-left').addEventListener('click', () => recordVote('left'));
  document.getElementById('card-right').addEventListener('click', () => recordVote('right'));

  // Leaderboard Tab Toggle Buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      currentLeaderboardTab = e.target.getAttribute('data-tab');
      loadLeaderboard();
    });
  });

  // Profile: Logout Button
  document.getElementById('btn-logout').addEventListener('click', async () => {
    showToast('Signing out...', 'info');
    await supabaseClient.auth.signOut();
  });
}

// --- Image Compression Engine with Square Center-Cropping ---
function compressImage(file, targetSize, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        // Handle natural dimensions, especially for SVGs
        let sWidth = img.naturalWidth || img.width;
        let sHeight = img.naturalHeight || img.height;

        if (!sWidth || !sHeight || sWidth <= 0 || sHeight <= 0) {
          reject(new Error('Invalid image dimensions'));
          return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = targetSize;
        canvas.height = targetSize;
        const ctx = canvas.getContext('2d');

        // Calculate source rectangle for center crop to square
        let sx = 0;
        let sy = 0;
        let sSize = Math.min(sWidth, sHeight);

        if (sWidth > sHeight) {
          sx = (sWidth - sHeight) / 2;
        } else if (sHeight > sWidth) {
          sy = (sHeight - sWidth) / 2;
        }

        ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, targetSize, targetSize);

        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Canvas compression failed'));
          }
        }, 'image/jpeg', quality);
      };
      img.onerror = (err) => reject(err);
    };
    reader.onerror = (err) => reject(err);
  });
}

// --- Geolocation & Reverse Geocoding ---
function initLocationDetection() {
  const locTitle = document.getElementById('location-title');
  const locDetails = document.getElementById('location-details');
  const submitBtn = document.getElementById('btn-submit-registration');

  locTitle.innerText = "Accessing GPS...";
  locDetails.innerText = "Please confirm the location prompt in your browser.";

  if (!navigator.geolocation) {
    locTitle.innerText = "Not Supported";
    locDetails.innerText = "Your browser does not support Geolocation. State/Neighborhood rankings will not function.";
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      userCoordinates.lat = position.coords.latitude;
      userCoordinates.lng = position.coords.longitude;

      locTitle.innerText = "Geocoding location...";
      locDetails.innerText = `Lat: ${userCoordinates.lat.toFixed(4)}, Lng: ${userCoordinates.lng.toFixed(4)}`;

      try {
        // Reverse Geocode state via OpenStreetMap Nominatim API
        const response = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${userCoordinates.lat}&lon=${userCoordinates.lng}&zoom=5`,
          { headers: { 'Accept-Language': 'en' } }
        );
        const data = await response.json();

        userState = data.address?.state || data.address?.region || "Unknown State";

        locTitle.innerText = `Located: ${userState}`;
        locDetails.innerText = `Lat: ${userCoordinates.lat.toFixed(4)}, Lng: ${userCoordinates.lng.toFixed(4)}`;

        checkRegistrationSubmittable();
      } catch (err) {
        console.error('Reverse Geocode error:', err);
        userState = "Unknown State";
        locTitle.innerText = "Location Found (Unnamed State)";
        checkRegistrationSubmittable();
      }
    },
    (err) => {
      console.warn('Geolocation error:', err);
      locTitle.innerText = "Location Denied";
      locDetails.innerText = "Please enable location in your device settings to register.";
      showToast('Location is required to calculate neighborhood ranks.', 'error');
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

function checkRegistrationSubmittable() {
  const submitBtn = document.getElementById('btn-submit-registration');
  const firstName = document.getElementById('input-first-name').value.trim();
  const gender = document.getElementById('select-gender').value;
  const votePref = document.getElementById('select-vote-pref').value;
  const selectedState = document.getElementById('select-state').value;

  if (selectedRegistrationFileBlob && userCoordinates.lat !== null && firstName && gender && votePref && selectedState) {
    submitBtn.removeAttribute('disabled');
  } else {
    submitBtn.setAttribute('disabled', 'true');
  }
}

// --- Mash Arena Game Functions ---
async function loadNextMatchup() {
  if (!currentUser) return;

  // Show loaders
  document.querySelectorAll('.card-loader').forEach(loader => loader.classList.remove('hidden'));

  try {
    const { data, error } = await supabaseClient.rpc('get_matchup', {
      voter_id: currentUser.id,
      pref: userVotePreference || 'everyone'
    });

    if (error) throw error;

    if (!data || data.length < 2) {
      displayNoMatchups();
      return;
    }

    currentMatchup = data;

    // Load left card image and info
    const imgLeft = document.getElementById('img-left');
    const eloLeft = document.getElementById('elo-left');
    imgLeft.src = data[0].avatar_url || DEFAULT_AVATAR;
    eloLeft.innerText = `${Math.round(data[0].elo)} ELO`;

    // Load right card image and info
    const imgRight = document.getElementById('img-right');
    const eloRight = document.getElementById('elo-right');
    imgRight.src = data[1].avatar_url || DEFAULT_AVATAR;
    eloRight.innerText = `${Math.round(data[1].elo)} ELO`;

    // Wait for image loading before hiding spinners
    let loadedCount = 0;
    const hideLoaderIfReady = () => {
      loadedCount++;
      if (loadedCount === 2) {
        document.querySelectorAll('.card-loader').forEach(loader => loader.classList.add('hidden'));
      }
    };

    imgLeft.onload = hideLoaderIfReady;
    imgRight.onload = hideLoaderIfReady;

    // In case images are already cached
    if (imgLeft.complete) hideLoaderIfReady();
    if (imgRight.complete) hideLoaderIfReady();

  } catch (err) {
    console.error('Failed to load matchup:', err);
    showToast('Failed to load matchup. Make sure other users exist.', 'error');
  }
}

function displayNoMatchups() {
  document.querySelectorAll('.card-loader').forEach(loader => loader.classList.add('hidden'));
  const arena = document.querySelector('.mash-arena');
  arena.innerHTML = `
    <div class="card text-center" style="margin: 40px auto; width: 100%;">
      <span style="font-size: 3rem; display: block; margin-bottom: 12px;">🧗</span>
      <h3 style="font-family: var(--font-display); font-weight: 700; margin-bottom: 8px;">No Climb matchups available yet</h3>
      <p style="color: var(--text-muted); font-size: 0.9rem;">To start voting, invite more friends to join Climb and upload their photos!</p>
    </div>
  `;
}

async function recordVote(side) {
  if (currentMatchup.length < 2 || !currentUser) return;

  const leftUser = currentMatchup[0];
  const rightUser = currentMatchup[1];

  let winnerId, loserId;

  if (side === 'left') {
    winnerId = leftUser.id;
    loserId = rightUser.id;
    document.getElementById('card-left').style.borderColor = 'var(--success-color)';
  } else {
    winnerId = rightUser.id;
    loserId = leftUser.id;
    document.getElementById('card-right').style.borderColor = 'var(--success-color)';
  }

  // Temporarily disable clicks
  document.getElementById('card-left').style.pointerEvents = 'none';
  document.getElementById('card-right').style.pointerEvents = 'none';

  try {
    const { error } = await supabaseClient.rpc('cast_vote', {
      winner_id: winnerId,
      loser_id: loserId
    });

    if (error) throw error;

    showToast('Vote registered!', 'success');

  } catch (err) {
    console.error('Failed to submit vote:', err);
    showToast('Could not register vote.', 'error');
  } finally {
    // Reset border color and click state
    setTimeout(() => {
      document.getElementById('card-left').style.borderColor = 'var(--border-color)';
      document.getElementById('card-right').style.borderColor = 'var(--border-color)';
      document.getElementById('card-left').style.pointerEvents = 'auto';
      document.getElementById('card-right').style.pointerEvents = 'auto';

      // Load next comparison
      loadNextMatchup();
    }, 400);
  }
}

// --- Leaderboards Functions ---
async function loadLeaderboard() {
  if (!currentUser) return;

  const listContainer = document.getElementById('leaderboard-list');
  listContainer.innerHTML = '<div class="text-center py-4"><div class="spinner" style="margin: 20px auto;"></div><p style="color: var(--text-muted);">Rebuilding rankings...</p></div>';

  try {
    // 1. Fetch rankings list
    const { data: leaderboardData, error } = await supabaseClient.rpc('get_leaderboard_data', {
      viewer_id: currentUser.id,
      viewer_lat: userCoordinates.lat || 0,
      viewer_lon: userCoordinates.lng || 0,
      viewer_state: userState || 'Unknown State',
      lb_type: currentLeaderboardTab
    });

    if (error) throw error;

    // 2. Populate rankings in UI
    listContainer.innerHTML = '';

    if (!leaderboardData || leaderboardData.length === 0) {
      listContainer.innerHTML = `
        <div class="text-center py-4" style="color: var(--text-muted); font-size: 0.9rem; padding: 40px 0;">
          No ranking records found for this category yet.
        </div>`;
    } else {
      leaderboardData.forEach((row) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'rank-row';
        rowEl.innerHTML = `
          <div class="rank-badge">${row.relative_rank}</div>
          <img class="rank-avatar" src="${row.avatar_url || DEFAULT_AVATAR}" alt="Profile Avatar">
          <div class="rank-info">
            <div class="rank-name">${row.user_id === currentUser.id ? 'You' : (row.first_name || 'Climber')}</div>
            <div class="rank-meta">${row.state || 'Unknown State'}</div>
          </div>
          <div class="rank-elo">${Math.round(row.elo)} ELO</div>
        `;
        listContainer.appendChild(rowEl);
      });
    }

    // 3. Fetch user specific ranks to populate sticky footer
    const { data: rankStats, error: statsError } = await supabaseClient.rpc('get_user_ranks', {
      user_id_param: currentUser.id,
      viewer_lat: userCoordinates.lat || 0,
      viewer_lon: userCoordinates.lng || 0,
      viewer_state: userState || 'Unknown State'
    });

    const stickyRow = document.getElementById('user-sticky-rank');

    if (statsError || !rankStats || rankStats.length === 0) {
      stickyRow.classList.add('hidden');
    } else {
      const stats = rankStats[0];
      let displayRank = '--';
      let displayTotal = '--';

      if (currentLeaderboardTab === 'global' && stats.global_rank > 0) {
        displayRank = stats.global_rank;
        displayTotal = stats.total_global;
      } else if (currentLeaderboardTab === 'state' && stats.state_rank > 0) {
        displayRank = stats.state_rank;
        displayTotal = stats.total_state;
      } else if (currentLeaderboardTab === 'neighborhood' && stats.neighborhood_rank > 0) {
        displayRank = stats.neighborhood_rank;
        displayTotal = stats.total_neighborhood;
      }

      if (displayRank !== '--' && currentProfile) {
        document.getElementById('sticky-user-avatar').src = currentProfile.avatar_url || DEFAULT_AVATAR;
        document.getElementById('sticky-user-location').innerText = `${userState} (Rank #${displayRank} of ${displayTotal})`;
        document.getElementById('sticky-user-elo').innerText = `${Math.round(currentProfile.elo)} ELO`;
        stickyRow.querySelector('.user-rank').innerText = displayRank;
        stickyRow.classList.remove('hidden');
      } else {
        stickyRow.classList.add('hidden');
      }
    }

  } catch (err) {
    console.error('Failed to load leaderboard:', err);
    showToast('Failed to load rankings snapshot.', 'error');
  }
}

// --- Profile Page Functions ---
async function loadProfileData() {
  if (!currentUser) return;

  try {
    // Fetch fresh profile state to get latest ELO
    const { data: profile, error } = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', currentUser.id)
      .single();

    if (error) throw error;
    currentProfile = profile;

    // Display name
    const displayName = profile.first_name || maskEmail(profile.email);

    // Update profile HTML info
    document.getElementById('profile-avatar').src = profile.avatar_url || DEFAULT_AVATAR;
    document.getElementById('profile-email-display').innerText = displayName;
    document.getElementById('profile-location-display').innerText = `Location: ${profile.state || 'Unknown'} (${(profile.latitude || 0).toFixed(3)}, ${(profile.longitude || 0).toFixed(3)})`;

    document.getElementById('stat-elo').innerText = Math.round(profile.elo);
    document.getElementById('stat-votes').innerText = profile.votes_cast;

    // Fetch user ranks for stats list
    const { data: rankStats, error: statsError } = await supabaseClient.rpc('get_user_ranks', {
      user_id_param: currentUser.id,
      viewer_lat: profile.latitude,
      viewer_lon: profile.longitude,
      viewer_state: profile.state || 'Unknown State'
    });

    if (!statsError && rankStats && rankStats.length > 0) {
      const stats = rankStats[0];
      document.getElementById('rank-val-global').innerText = stats.global_rank > 0 ? `#${stats.global_rank} of ${stats.total_global}` : 'Not Ranked';
      document.getElementById('rank-val-state').innerText = stats.state_rank > 0 ? `#${stats.state_rank} in ${profile.state}` : 'Not Ranked';
      document.getElementById('rank-val-neighborhood').innerText = stats.neighborhood_rank > 0 ? `#${stats.neighborhood_rank} within 5mi` : 'Not Ranked';
    }

  } catch (err) {
    console.error('Failed to load profile screen:', err);
    showToast('Failed to load profile information.', 'error');
  }
}

// --- Utilities ---
function maskEmail(email) {
  if (!email) return "Anonymous Climber";
  const parts = email.split('@');
  if (parts.length === 2) {
    const name = parts[0];
    const domain = parts[1];
    if (name.length > 2) {
      return name.slice(0, 2) + "•••@" + domain;
    }
    return "•••@" + domain;
  }
  return "Climber";
}

function setButtonLoading(buttonId, isLoading, text) {
  const btn = document.getElementById(buttonId);
  if (isLoading) {
    btn.setAttribute('disabled', 'true');
    btn.innerText = text;
  } else {
    btn.removeAttribute('disabled');
    btn.innerText = text;
  }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerText = message;
  container.appendChild(toast);

  // Force browser layout reflow to trigger slide-in transition
  toast.offsetHeight;
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
    toast.addEventListener('transitionend', () => toast.remove());
  }, 3000);
}

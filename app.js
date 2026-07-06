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
let currentLeaderboardGender = "everyone";
let currentClubInfo = null;
let currentClubMembers = [];
let isMashClubMode = false;

let currentCroppingContext = "register";
let isSignUp = false;
let userToBlockId = null;
let cropState = {
  imgSrc: null,
  zoom: 1,
  x: 0,
  y: 0,
  isDragging: false,
  startX: 0,
  startY: 0,
  imgWidth: 0,
  imgHeight: 0
};

// DOM Elements
const screens = {
  loader: document.getElementById('screen-loader'),
  landing: document.getElementById('screen-landing'),
  auth: document.getElementById('screen-auth'),
  register: document.getElementById('screen-register'),
  mash: document.getElementById('screen-mash'),
  leaderboard: document.getElementById('screen-leaderboard'),
  challenges: document.getElementById('screen-challenges'),
  clubs: document.getElementById('screen-clubs'),
  profile: document.getElementById('screen-profile')
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  initAuthListener();
  initCityComboboxes();
  applyOnboardingRotations();
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
    if (notificationsSubscription) {
      supabaseClient.removeChannel(notificationsSubscription);
      notificationsSubscription = null;
    }
    showScreen('landing');
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
    updateNavigationLocks();

    // Check if user has completed profile (photo + name + gender)
    if (!currentProfile.avatar_url || !currentProfile.first_name || !currentProfile.gender) {
      showScreen('register');
    } else {
      // Save location from profile
      userCoordinates.lat = currentProfile.latitude;
      userCoordinates.lng = currentProfile.longitude;
      userState = currentProfile.state || "Unknown State";
      userVotePreference = currentProfile.vote_preference || "everyone";

      // Fetch club info
      try {
        const { data: clubData, error: clubError } = await supabaseClient.rpc('get_my_club');
        if (!clubError && clubData) {
          currentClubInfo = clubData.club;
          currentClubMembers = clubData.members || [];
        } else {
          currentClubInfo = null;
          currentClubMembers = [];
        }
      } catch (e) {
        console.error('Error fetching club info', e);
      }

      // Go to main Mash screen
      initNotifications();
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

  if (screenId === 'auth') {
    document.getElementById('auth-step-welcome').classList.remove('hidden');
    document.getElementById('auth-step-email').classList.add('hidden');
    document.getElementById('auth-step-otp').classList.add('hidden');
  }

  const bottomNav = document.querySelector('.bottom-nav');
  if (bottomNav) {
    const noNavScreens = ['loader', 'landing', 'auth', 'register'];
    if (noNavScreens.includes(screenId)) {
      bottomNav.classList.add('hidden');
    } else {
      bottomNav.classList.remove('hidden');
      document.querySelectorAll('.bottom-nav .nav-item').forEach(btn => {
        if (btn.getAttribute('data-screen') === screenId) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });
    }
  }
}

let notificationsList = [];
let notificationsSubscription = null;

async function initNotifications() {
  if (!currentUser) return;
  await fetchNotifications();
  if (notificationsSubscription) {
    supabaseClient.removeChannel(notificationsSubscription);
  }
  notificationsSubscription = supabaseClient
    .channel('public:notifications')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'notifications',
      filter: `user_id=eq.${currentUser.id}`
    }, (payload) => {
      notificationsList.unshift(payload.new);
      updateNotificationsUI();
      showToast(`${stripEmojis(payload.new.title)}: ${stripEmojis(payload.new.message)}`, 'info');
    })
    .subscribe();
}

async function fetchNotifications() {
  if (!currentUser) return;
  try {
    const { data, error } = await supabaseClient
      .from('notifications')
      .select('*')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    notificationsList = data || [];
    updateNotificationsUI();
  } catch (err) {
    console.error('Error fetching notifications:', err);
  }
}

function stripEmojis(str) {
  if (!str) return '';
  return str.replace(/[\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDC00-\uDFFF]/g, '').trim();
}

function updateNotificationsUI() {
  const badge = document.getElementById('notifications-badge');
  const listContainer = document.getElementById('notifications-list');
  if (!badge || !listContainer) return;
  
  const lastOpened = parseInt(localStorage.getItem('climb_last_read_notifications') || '0', 10);
  const newCount = notificationsList.filter(n => new Date(n.created_at).getTime() > lastOpened).length;
  
  if (newCount > 0) {
    badge.innerText = newCount;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
  
  if (notificationsList.length === 0) {
    listContainer.innerHTML = '<div class="input-hint" style="text-align: center; padding: 20px 0;">No notifications yet!</div>';
    return;
  }
  
  listContainer.innerHTML = notificationsList.map(n => {
    const isNew = new Date(n.created_at).getTime() > lastOpened;
    const bgStyle = isNew ? 'var(--primary-light)' : 'var(--bg-secondary)';
    const dateStr = new Date(n.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const cleanTitle = stripEmojis(n.title);
    const cleanMessage = stripEmojis(n.message);
    return `
      <div class="card" style="padding: 12px; border: 2px solid var(--border-color); background-color: ${bgStyle}; text-align: left; display: flex; flex-direction: column; gap: 4px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
          <span style="font-family: var(--font-display); font-weight: bold; font-size: 0.9rem; color: var(--text-main);">${cleanTitle}</span>
          <span style="font-size: 0.7rem; color: var(--text-muted);">${dateStr}</span>
        </div>
        <p style="font-size: 0.8rem; color: var(--text-main); margin: 0; line-height: 1.4;">${cleanMessage}</p>
      </div>
    `;
  }).join('');
}

// --- Event Listeners Setup ---
function setupEventListeners() {
  // Landing Screen: Scroll down indicator
  document.getElementById('btn-scroll-down').addEventListener('click', () => {
    const landing = document.getElementById('screen-landing');
    landing.scrollTo({ top: landing.clientHeight, behavior: 'smooth' });
  });

  // Landing Screen: Parallax scroll listener
  const landingScreen = document.getElementById('screen-landing');
  const parallaxBg = document.querySelector('.parallax-bg');
  if (landingScreen && parallaxBg) {
    landingScreen.addEventListener('scroll', () => {
      const scrollTop = landingScreen.scrollTop;
      parallaxBg.style.transform = `translateY(${scrollTop * 0.3}px)`;
    });
  }

  // Landing Screen: Download iOS placeholder button
  document.getElementById('btn-landing-download').addEventListener('click', () => {
    showToast('iOS App download is coming soon to the App Store!', 'info');
  });

  // Landing Screen: Play on Web Button
  document.getElementById('btn-landing-play-web').addEventListener('click', () => {
    document.getElementById('auth-step-welcome').classList.remove('hidden');
    document.getElementById('auth-step-method').classList.add('hidden');
    document.getElementById('auth-step-email').classList.add('hidden');
    document.getElementById('auth-step-otp').classList.add('hidden');
    showScreen('auth');
  });

  // Welcome Screen: Go Back to Landing Page
  document.getElementById('btn-welcome-back-landing').addEventListener('click', () => {
    showScreen('landing');
  });

  // Safety Info popup triggers (Landing + Mash screen)
  document.querySelectorAll('.safety-btn').forEach(btn => {
    if (btn.id === 'btn-open-notifications') return;
    btn.addEventListener('click', () => {
      document.getElementById('safety-modal').classList.remove('hidden');
    });
  });

  // Safety Modal: Close button
  document.getElementById('btn-close-safety').addEventListener('click', () => {
    document.getElementById('safety-modal').classList.add('hidden');
  });

  // Safety Modal: Click outside content
  document.getElementById('safety-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('safety-modal')) {
      document.getElementById('safety-modal').classList.add('hidden');
    }
  });

  // Notifications Modal: Open button
  const btnOpenNotif = document.getElementById('btn-open-notifications');
  if (btnOpenNotif) {
    btnOpenNotif.addEventListener('click', () => {
      document.getElementById('notifications-modal').classList.remove('hidden');
      localStorage.setItem('climb_last_read_notifications', Date.now().toString());
      fetchNotifications();
    });
  }

  // Notifications Modal: Close button
  const btnCloseNotif = document.getElementById('btn-close-notifications');
  if (btnCloseNotif) {
    btnCloseNotif.addEventListener('click', () => {
      document.getElementById('notifications-modal').classList.add('hidden');
    });
  }

  // Notifications Modal: Click outside
  const notifModal = document.getElementById('notifications-modal');
  if (notifModal) {
    notifModal.addEventListener('click', (e) => {
      if (e.target === notifModal) {
        notifModal.classList.add('hidden');
      }
    });
  }

  // Mash Cards: Block & Report buttons
  document.getElementById('btn-block-left').addEventListener('click', (e) => {
    e.stopPropagation(); // Prevents triggering a vote on card click
    if (currentMatchup.length >= 2) {
      userToBlockId = currentMatchup[0].id;
      document.getElementById('block-modal').classList.remove('hidden');
    }
  });

  document.getElementById('btn-block-right').addEventListener('click', (e) => {
    e.stopPropagation(); // Prevents triggering a vote on card click
    if (currentMatchup.length >= 2) {
      userToBlockId = currentMatchup[1].id;
      document.getElementById('block-modal').classList.remove('hidden');
    }
  });

  // Block Modal: Cancel
  document.getElementById('btn-cancel-block').addEventListener('click', () => {
    document.getElementById('block-modal').classList.add('hidden');
    userToBlockId = null;
  });

  // Block Modal: Click outside content
  document.getElementById('block-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('block-modal')) {
      document.getElementById('block-modal').classList.add('hidden');
      userToBlockId = null;
    }
  });

  // Block Modal: Confirm Block
  document.getElementById('btn-confirm-block').addEventListener('click', async () => {
    if (!userToBlockId || !currentUser) return;

    setButtonLoading('btn-confirm-block', true, 'Blocking...');
    try {
      const { error } = await supabaseClient
        .from('blocks')
        .insert({
          blocker_id: currentUser.id,
          blocked_id: userToBlockId
        });

      if (error && error.code !== '23505') { // Ignore duplicate block error code
        throw error;
      }

      showToast('User blocked and reported.', 'success');
    } catch (err) {
      console.error('Failed to register database block:', err);
      showToast('User blocked.', 'success');
    } finally {
      setButtonLoading('btn-confirm-block', false, 'Block');
      document.getElementById('block-modal').classList.add('hidden');
      userToBlockId = null;
      loadNextMatchup();
    }
  });



  // Welcome Screen: Create Account Button
  document.getElementById('btn-welcome-create').addEventListener('click', () => {
    isSignUp = true;
    document.getElementById('auth-method-title').innerText = 'Sign Up Method';
    document.getElementById('label-auth-apple').innerText = 'Sign Up with Apple';
    document.getElementById('label-auth-email').innerText = 'Sign Up with Email';
    document.getElementById('label-email-title').innerText = 'Create Account Email';
    document.getElementById('btn-send-otp').innerText = 'Send Sign Up Code';
    document.getElementById('auth-step-welcome').classList.add('hidden');
    document.getElementById('auth-step-method').classList.remove('hidden');
  });

  // Welcome Screen: Sign In Button
  document.getElementById('btn-welcome-signin').addEventListener('click', () => {
    isSignUp = false;
    document.getElementById('auth-method-title').innerText = 'Log In Method';
    document.getElementById('label-auth-apple').innerText = 'Log In with Apple';
    document.getElementById('label-auth-email').innerText = 'Log In with Email';
    document.getElementById('label-email-title').innerText = 'Email Address';
    document.getElementById('btn-send-otp').innerText = 'Send Login Code';
    document.getElementById('auth-step-welcome').classList.add('hidden');
    document.getElementById('auth-step-method').classList.remove('hidden');
  });

  // Auth Method Selection: Apple Authentication placeholder
  document.getElementById('btn-auth-apple').addEventListener('click', () => {
    showToast('Sign in with Apple is coming soon!', 'info');
  });

  // Auth Method Selection: Email Authentication redirect
  document.getElementById('btn-auth-email').addEventListener('click', () => {
    document.getElementById('auth-step-method').classList.add('hidden');
    document.getElementById('auth-step-email').classList.remove('hidden');
  });

  // Auth Method Selection: Go Back
  document.getElementById('btn-method-back-welcome').addEventListener('click', () => {
    document.getElementById('auth-step-method').classList.add('hidden');
    document.getElementById('auth-step-welcome').classList.remove('hidden');
  });

  // Email Step: Go Back
  document.getElementById('btn-email-back-method').addEventListener('click', () => {
    document.getElementById('auth-step-email').classList.add('hidden');
    document.getElementById('auth-step-method').classList.remove('hidden');
  });

  // Auth Form: Send OTP Verification Code
  document.getElementById('form-email').addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailInput = document.getElementById('input-email').value.trim();
    if (!emailInput) return;

    setButtonLoading('btn-send-otp', true, 'Sending...');

    const { data, error } = await supabaseClient.auth.signInWithOtp({
      email: emailInput
    });

    setButtonLoading('btn-send-otp', false, isSignUp ? 'Send Sign Up Code' : 'Send Login Code');

    if (error) {
      showToast(error.message, 'error');
    } else {
      showToast('Verification code sent to your email!', 'success');
      document.getElementById('auth-step-email').classList.add('hidden');
      document.getElementById('auth-step-otp').classList.remove('hidden');
      // Autofocus OTP input
      document.getElementById('input-otp').focus();
    }
  });

  // Auth Form: Verify OTP Code
  document.getElementById('form-otp').addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailInput = document.getElementById('input-email').value.trim();
    const otpInput = document.getElementById('input-otp').value.trim();
    if (!emailInput || !otpInput) return;

    setButtonLoading('btn-verify-otp', true, 'Verifying...');

    const { data, error } = await supabaseClient.auth.verifyOtp({
      email: emailInput,
      token: otpInput,
      type: 'email'
    });

    setButtonLoading('btn-verify-otp', false, 'Verify Code');

    if (error) {
      showToast(error.message, 'error');
    } else {
      showToast('Successfully authenticated!', 'success');
      // The onAuthStateChange listener will automatically route the user
    }
  });

  // Auth: Go back from OTP screen
  document.getElementById('btn-back-otp').addEventListener('click', () => {
    document.getElementById('auth-step-otp').classList.add('hidden');
    document.getElementById('auth-step-email').classList.remove('hidden');
  });

  // Registration Form: File picker preview & compression
  document.getElementById('input-avatar').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    openCropModal(file, 'register');
  });

  // Registration Form: New field change listeners
  document.getElementById('input-first-name').addEventListener('input', () => checkRegistrationSubmittable());
  document.getElementById('select-state').addEventListener('change', () => checkRegistrationSubmittable());

  // Gender Selection Boxes
  document.querySelectorAll('.gender-vote-box').forEach(box => {
    box.addEventListener('click', () => {
      document.querySelectorAll('.gender-vote-box').forEach(b => b.classList.remove('selected'));
      box.classList.add('selected');
      document.getElementById('select-gender').value = box.dataset.value;
      document.getElementById('btn-next-step-3').removeAttribute('disabled');
      checkRegistrationSubmittable();
    });
  });

  // Vote Preference Selection Boxes
  document.querySelectorAll('.vote-pref-box').forEach(box => {
    box.addEventListener('click', () => {
      document.querySelectorAll('.vote-pref-box').forEach(b => b.classList.remove('selected'));
      box.classList.add('selected');
      document.getElementById('select-vote-pref').value = box.dataset.value;
      document.getElementById('btn-next-step-4').removeAttribute('disabled');
      checkRegistrationSubmittable();
    });
  });



  // Registration Form: Submit Profile Setup
  document.getElementById('form-register').addEventListener('submit', async (e) => {
    e.preventDefault();
    const firstName = document.getElementById('input-first-name').value.trim();
    const gender = document.getElementById('select-gender').value;
    const votePref = document.getElementById('select-vote-pref').value;
    const selectedState = document.getElementById('select-state').value;

    if (!selectedRegistrationFileBlob || !currentUser || !firstName || !gender || !votePref || !selectedState) return;

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
          cacheControl: '604800',
          contentType: selectedRegistrationFileType,
          upsert: true
        });

      if (uploadError) {
        console.error('STORAGE UPLOAD ERROR:', uploadError);
        throw uploadError;
      }

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

      if (profileError) {
        console.error('PROFILE UPDATE ERROR:', profileError);
        throw profileError;
      }

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

  // Registration Wizard Logic — 5 steps: Name, Region, Gender, Vote Pref, Photo
  document.getElementById('btn-next-step-1').addEventListener('click', () => {
    const fName = document.getElementById('input-first-name').value.trim();
    if (!fName) {
      showToast('Please enter your name.', 'error');
      return;
    }
    document.getElementById('reg-step-1').classList.remove('wizard-active');
    document.getElementById('reg-step-1').classList.add('hidden');
    document.getElementById('reg-step-2').classList.remove('hidden');
    document.getElementById('reg-step-2').classList.add('wizard-active');
    applyOnboardingRotations();
  });

  document.getElementById('btn-prev-step-2').addEventListener('click', () => {
    document.getElementById('reg-step-2').classList.remove('wizard-active');
    document.getElementById('reg-step-2').classList.add('hidden');
    document.getElementById('reg-step-1').classList.remove('hidden');
    document.getElementById('reg-step-1').classList.add('wizard-active');
    applyOnboardingRotations();
  });

  document.getElementById('btn-next-step-2').addEventListener('click', () => {
    const selectedState = document.getElementById('select-state').value;
    if (!selectedState) {
      showToast('Please select your region.', 'error');
      return;
    }
    document.getElementById('reg-step-2').classList.remove('wizard-active');
    document.getElementById('reg-step-2').classList.add('hidden');
    document.getElementById('reg-step-3').classList.remove('hidden');
    document.getElementById('reg-step-3').classList.add('wizard-active');
    applyOnboardingRotations();
  });

  document.getElementById('btn-prev-step-3').addEventListener('click', () => {
    document.getElementById('reg-step-3').classList.remove('wizard-active');
    document.getElementById('reg-step-3').classList.add('hidden');
    document.getElementById('reg-step-2').classList.remove('hidden');
    document.getElementById('reg-step-2').classList.add('wizard-active');
    applyOnboardingRotations();
  });

  document.getElementById('btn-next-step-3').addEventListener('click', () => {
    const gender = document.getElementById('select-gender').value;
    if (!gender) {
      showToast('Please select your gender.', 'error');
      return;
    }
    document.getElementById('reg-step-3').classList.remove('wizard-active');
    document.getElementById('reg-step-3').classList.add('hidden');
    document.getElementById('reg-step-4').classList.remove('hidden');
    document.getElementById('reg-step-4').classList.add('wizard-active');
    applyOnboardingRotations();
  });

  document.getElementById('btn-prev-step-4').addEventListener('click', () => {
    document.getElementById('reg-step-4').classList.remove('wizard-active');
    document.getElementById('reg-step-4').classList.add('hidden');
    document.getElementById('reg-step-3').classList.remove('hidden');
    document.getElementById('reg-step-3').classList.add('wizard-active');
    applyOnboardingRotations();
  });

  document.getElementById('btn-next-step-4').addEventListener('click', () => {
    const votePref = document.getElementById('select-vote-pref').value;
    if (!votePref) {
      showToast('Please select who you want to vote on.', 'error');
      return;
    }
    document.getElementById('reg-step-4').classList.remove('wizard-active');
    document.getElementById('reg-step-4').classList.add('hidden');
    document.getElementById('reg-step-5').classList.remove('hidden');
    document.getElementById('reg-step-5').classList.add('wizard-active');
    applyOnboardingRotations();
  });

  document.getElementById('btn-prev-step-5').addEventListener('click', () => {
    document.getElementById('reg-step-5').classList.remove('wizard-active');
    document.getElementById('reg-step-5').classList.add('hidden');
    document.getElementById('reg-step-4').classList.remove('hidden');
    document.getElementById('reg-step-4').classList.add('wizard-active');
    applyOnboardingRotations();
  });

  // Profile: Edit Photo Update
  const updateAvatarInput = document.getElementById('input-update-avatar');
  if (updateAvatarInput) {
    updateAvatarInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file || !currentUser) return;
      
      openCropModal(file, 'profile');
    });
  }

  // Navigation Items
  document.querySelectorAll('.bottom-nav .nav-item').forEach(button => {
    button.addEventListener('click', (e) => {
      const targetScreen = e.currentTarget.getAttribute('data-screen');
      if (targetScreen) {
        if ((targetScreen === 'leaderboard' || targetScreen === 'clubs') && (!currentProfile || currentProfile.votes_cast < 25)) {
          const votes = currentProfile ? currentProfile.votes_cast : 0;
          const screenName = targetScreen === 'clubs' ? 'Clubs' : 'the Summit';
          showToast(`Cast ${25 - votes} more votes to unlock ${screenName}.`, 'error');
          return;
        }
        showScreen(targetScreen);
        if (targetScreen === 'mash') {
          if (currentMatchup.length === 0) loadNextMatchup();
        } else if (targetScreen === 'leaderboard') {
          loadLeaderboard();
        } else if (targetScreen === 'profile') {
          loadProfileData();
        } else if (targetScreen === 'clubs') {
          loadClubScreen();
        }
      }
    });
  });

  // Settings Modal Controls
  const settingsModal = document.getElementById('settings-modal');
  const btnSettings = document.getElementById('btn-settings');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const formSettings = document.getElementById('form-settings');
  

  
  if (btnSettings) {
    btnSettings.addEventListener('click', () => {
      if (!currentProfile) return;
      
      document.getElementById('input-settings-name').value = currentProfile.first_name || '';
      document.getElementById('input-settings-gender').value = currentProfile.gender ? (currentProfile.gender.charAt(0).toUpperCase() + currentProfile.gender.slice(1)) : '';
      document.getElementById('select-settings-vote-pref').value = currentProfile.vote_preference || 'everyone';
      document.getElementById('select-settings-state').value = currentProfile.state || '';
      document.getElementById('input-settings-state-search').value = currentProfile.state || '';
      document.getElementById('settings-avatar-preview').src = currentProfile.avatar_url || DEFAULT_AVATAR;
      
      settingsModal.classList.remove('hidden');
    });
  }

  const btnShareProfile = document.getElementById('btn-share-profile');
  if (btnShareProfile) {
    btnShareProfile.addEventListener('click', async () => {
      if (!currentProfile) return;
      
      const firstName = currentProfile.first_name || 'A climber';
      const eloGrade = document.getElementById('stat-elo').innerText || '--';
      const globalRank = document.getElementById('rank-val-global').innerText || '--';
      
      const shareTitle = `Climb Profile: ${firstName}`;
      const shareText = `Check out ${firstName}'s profile on Climb! Current Grade: ${eloGrade} (Global Rank: #${globalRank}). Join Climb to step up and make your way to the top!`;
      const shareUrl = 'https://climb.side-eye.xyz';

      const fullMessage = `${shareText}\n${shareUrl}`;

      if (navigator.share) {
        try {
          await navigator.share({
            title: shareTitle,
            text: fullMessage
          });
          showToast('Profile shared successfully!', 'success');
        } catch (err) {
          console.log('Share error or cancelled:', err);
        }
      } else {
        // Fallback: copy to clipboard
        try {
          const fullMessage = `${shareText}\n${shareUrl}`;
          await navigator.clipboard.writeText(fullMessage);
          showToast('Profile link & stats copied to clipboard!', 'success');
        } catch (err) {
          console.error('Failed to copy profile link:', err);
          showToast('Failed to copy link. Please copy URL manually.', 'error');
        }
      }
    });
  }
  
  if (btnCloseSettings) {
    btnCloseSettings.addEventListener('click', () => {
      settingsModal.classList.add('hidden');
    });
  }
  
  if (formSettings) {
    formSettings.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('input-settings-name').value.trim();
      const votePref = document.getElementById('select-settings-vote-pref').value;
      const selectedState = document.getElementById('select-settings-state').value;
      
      // Update coordinates based on selected state (city)
      const cityObj = CITIES.find(c => c.name === selectedState);
      let newLat = currentProfile.latitude;
      let newLng = currentProfile.longitude;
      if (cityObj) {
        newLat = cityObj.lat;
        newLng = cityObj.lng;
      }
      
      setButtonLoading('btn-save-settings', true, 'Saving...');
      try {
        const { error } = await supabaseClient
          .from('profiles')
          .update({
            first_name: name,
            vote_preference: votePref,
            state: selectedState,
            latitude: newLat,
            longitude: newLng
          })
          .eq('id', currentUser.id);
        
        if (error) throw error;
        
        // Update local state
        currentProfile.first_name = name;
        currentProfile.vote_preference = votePref;
        currentProfile.state = selectedState;
        currentProfile.latitude = newLat;
        currentProfile.longitude = newLng;
        userState = selectedState;
        userVotePreference = votePref;
        userCoordinates.lat = newLat;
        userCoordinates.lng = newLng;
        
        await loadProfileData();
        settingsModal.classList.add('hidden');
        showToast('Settings saved successfully!', 'success');
        
        // Reload matchup matching new preferences/coordinates immediately
        loadNextMatchup();
      } catch (err) {
        console.error(err);
        showToast('Failed to save settings.', 'error');
      } finally {
        setButtonLoading('btn-save-settings', false, 'Save Changes');
      }
    });
  }

  // Crop Viewport Dragging & Zooming Controls
  const cropViewport = document.getElementById('modal-crop-viewport');
  const cropZoomInput = document.getElementById('modal-crop-zoom');
  
  if (cropViewport) {
    const startDrag = (clientX, clientY) => {
      if (!cropState.imgSrc) return;
      cropState.isDragging = true;
      cropState.startX = clientX - cropState.x;
      cropState.startY = clientY - cropState.y;
      cropViewport.style.cursor = 'grabbing';
    };
    
    const moveDrag = (clientX, clientY) => {
      if (!cropState.isDragging) return;
      cropState.x = clientX - cropState.startX;
      cropState.y = clientY - cropState.startY;
      applyCropStateStyles();
    };
    
    const stopDrag = () => {
      cropState.isDragging = false;
      cropViewport.style.cursor = 'move';
    };
    
    cropViewport.addEventListener('mousedown', (e) => startDrag(e.clientX, e.clientY));
    window.addEventListener('mousemove', (e) => moveDrag(e.clientX, e.clientY));
    window.addEventListener('mouseup', stopDrag);
    
    cropViewport.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        startDrag(e.touches[0].clientX, e.touches[0].clientY);
      }
    });
    window.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1) {
        moveDrag(e.touches[0].clientX, e.touches[0].clientY);
      }
    });
    window.addEventListener('touchend', stopDrag);
  }
  
  if (cropZoomInput) {
    cropZoomInput.addEventListener('input', (e) => {
      cropState.zoom = parseFloat(e.target.value);
      applyCropStateStyles();
    });
  }
  
  document.getElementById('btn-cancel-crop').addEventListener('click', () => {
    document.getElementById('crop-modal').classList.add('hidden');
    document.getElementById('input-avatar').value = '';
    document.getElementById('input-update-avatar').value = '';
  });
  
  document.getElementById('btn-apply-crop').addEventListener('click', async () => {
    document.getElementById('crop-modal').classList.add('hidden');
    showToast('Cropping and saving...', 'info');
    
    try {
      const croppedBlob = await getCroppedImageBlob(300);
      
      if (currentCroppingContext === 'register') {
        selectedRegistrationFileBlob = croppedBlob;
        selectedRegistrationFileType = 'image/jpeg';
        
        const previewImg = document.getElementById('avatar-preview-img');
        const placeholder = document.getElementById('avatar-preview-placeholder');
        
        previewImg.src = URL.createObjectURL(croppedBlob);
        placeholder.classList.add('hidden');
        previewImg.classList.remove('hidden');
        
        checkRegistrationSubmittable();
      } else if (currentCroppingContext === 'profile') {
        const label = document.querySelector('.edit-photo-btn');
        label.innerText = 'Uploading...';
        
        try {
          const filePath = `${currentUser.id}/${Date.now()}.jpg`;
          
          const { error: uploadError } = await supabaseClient.storage
            .from('avatars')
            .upload(filePath, croppedBlob, {
              cacheControl: '604800',
              contentType: 'image/jpeg'
            });
            
          if (uploadError) throw uploadError;
          
          const { data: publicUrlData } = supabaseClient.storage.from('avatars').getPublicUrl(filePath);
          const newAvatarUrl = publicUrlData.publicUrl;
          
          const { error: updateError } = await supabaseClient
            .from('profiles')
            .update({ avatar_url: newAvatarUrl })
            .eq('id', currentUser.id);
            
          if (updateError) throw updateError;
          
          if (currentProfile) currentProfile.avatar_url = newAvatarUrl;
          document.getElementById('profile-avatar').src = newAvatarUrl;
          document.getElementById('settings-avatar-preview').src = newAvatarUrl;
          showToast('Profile photo updated!', 'success');
        } catch (err) {
          console.error(err);
          showToast('Failed to update photo.', 'error');
        } finally {
          label.innerText = 'Change Photo';
        }
      }
    } catch (err) {
      console.error(err);
      showToast('Cropping failed.', 'error');
    }
  });

  // Mash voting click triggers
  document.getElementById('card-left').addEventListener('click', () => recordVote('left'));
  document.getElementById('card-right').addEventListener('click', () => recordVote('right'));

  // Leaderboard Tab Toggle Buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      // Don't affect climb tabs
      if (e.target.id === 'btn-climb-global' || e.target.id === 'btn-climb-club') return;
      
      const tabsDiv = e.target.closest('.tabs');
      tabsDiv.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      currentLeaderboardTab = e.target.getAttribute('data-tab');
      loadLeaderboard();
    });
  });

  // Leaderboard Gender Filter Buttons
  document.querySelectorAll('.gender-filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const container = e.target.closest('.gender-filter-container');
      container.querySelectorAll('.gender-filter-btn').forEach(b => {
        b.classList.remove('active');
        b.style.backgroundColor = 'var(--bg-primary)';
        b.style.color = 'var(--text-muted)';
      });

      e.target.classList.add('active');
      e.target.style.backgroundColor = 'var(--bg-secondary)';
      e.target.style.color = 'var(--text-main)';

      currentLeaderboardGender = e.target.getAttribute('data-gender');
      loadLeaderboard();
    });
  });

  // Climb Tab Toggle Buttons
  const btnClimbGlobal = document.getElementById('btn-climb-global');
  const btnClimbClub = document.getElementById('btn-climb-club');
  
  if (btnClimbGlobal && btnClimbClub) {
    btnClimbGlobal.addEventListener('click', () => {
      btnClimbGlobal.classList.add('active');
      btnClimbClub.classList.remove('active');
      isMashClubMode = false;
      loadNextMatchup();
    });
    
    btnClimbClub.addEventListener('click', () => {
      const votes = currentProfile ? currentProfile.votes_cast : 0;
      if (votes < 25) {
        showToast(`Cast ${25 - votes} more votes to unlock Clubs.`, 'error');
        return;
      }
      
      if (!currentClubInfo) {
        showToast('You must join a club first to climb against members.', 'error');
        showScreen('clubs');
        loadClubScreen();
        return;
      }
      
      btnClimbClub.classList.add('active');
      btnClimbGlobal.classList.remove('active');
      isMashClubMode = true;
      loadNextMatchup();
    });
  }

  // Club Screen Listeners
  const btnCreateClub = document.getElementById('btn-create-club');
  if (btnCreateClub) btnCreateClub.addEventListener('click', createClub);

  const btnJoinClub = document.getElementById('btn-join-club');
  if (btnJoinClub) btnJoinClub.addEventListener('click', joinClub);

  const btnLeaveClub = document.getElementById('btn-leave-club');
  if (btnLeaveClub) btnLeaveClub.addEventListener('click', leaveClub);

  const btnShareClub = document.getElementById('btn-share-club');
  if (btnShareClub) btnShareClub.addEventListener('click', shareClubCode);

  const btnEditClubName = document.getElementById('btn-edit-club-name');
  if (btnEditClubName) {
    btnEditClubName.addEventListener('click', () => {
      document.getElementById('club-name-display').classList.add('hidden');
      document.getElementById('club-name-edit').classList.remove('hidden');
      document.getElementById('input-edit-club-name').value = currentClubInfo?.name || '';
      document.getElementById('input-edit-club-name').focus();
    });
  }

  const btnSaveClubName = document.getElementById('btn-save-club-name');
  if (btnSaveClubName) btnSaveClubName.addEventListener('click', saveClubName);

  // Profile: Logout Button
  document.getElementById('btn-logout').addEventListener('click', async () => {
    const confirmLogout = window.confirm("Are you sure you want to sign out?");
    if (!confirmLogout) return;

    showToast('Signing out...', 'info');
    await supabaseClient.auth.signOut();
  });

  // Profile: Delete Account Button
  const btnDeleteAccount = document.getElementById('btn-delete-account');
  if (btnDeleteAccount) {
    btnDeleteAccount.addEventListener('click', async () => {
      const confirmDelete = window.confirm(
        'Are you sure you want to permanently delete your account? This cannot be undone. All your data, votes, photos, and club memberships will be erased.'
      );
      if (!confirmDelete) return;

      const doubleConfirm = window.confirm(
        'This is your last chance. Type-confirm not supported in this browser — click OK to permanently delete your account.'
      );
      if (!doubleConfirm) return;

      setButtonLoading('btn-delete-account', true, 'Deleting...');
      try {
        const { error } = await supabaseClient.rpc('delete_own_account');
        if (error) throw error;

        showToast('Account deleted. Goodbye.', 'success');
        await supabaseClient.auth.signOut();
      } catch (err) {
        console.error('Failed to delete account:', err);
        showToast(err.message || 'Failed to delete account.', 'error');
        setButtonLoading('btn-delete-account', false, 'Delete Account');
      }
    });
  }
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

// --- Geolocation (removed — no longer used) ---

function checkRegistrationSubmittable() {
  const submitBtn = document.getElementById('btn-submit-registration');
  const firstName = document.getElementById('input-first-name').value.trim();
  const gender = document.getElementById('select-gender').value;
  const votePref = document.getElementById('select-vote-pref').value;
  const selectedState = document.getElementById('select-state').value;

  if (selectedRegistrationFileBlob && firstName && gender && votePref && selectedState) {
    submitBtn.removeAttribute('disabled');
  } else {
    submitBtn.setAttribute('disabled', 'true');
  }
}

// --- Mash Arena Game Functions ---
async function loadNextMatchup() {
  if (!currentUser) return;

  const cardLeft = document.getElementById('card-left');
  const cardRight = document.getElementById('card-right');
  if (cardLeft) cardLeft.classList.add('fade-out');
  if (cardRight) cardRight.classList.add('fade-out');

  // Ensure arena is visible and no matchups message is hidden
  const arenaEl = document.querySelector('#screen-mash .mash-arena');
  if (arenaEl) arenaEl.classList.remove('hidden');
  const noMatchupsView = document.getElementById('view-no-matchups');
  if (noMatchupsView) noMatchupsView.classList.add('hidden');

  // Show loaders
  document.querySelectorAll('.card-loader').forEach(loader => loader.classList.remove('hidden'));

  try {
    let rpcName = 'get_matchup';
    let rpcArgs = {
      voter_id: currentUser.id,
      pref: userVotePreference || 'everyone'
    };

    if (isMashClubMode && currentClubInfo) {
      rpcName = 'get_matchup_club';
      rpcArgs = {
        voter_id: currentUser.id,
        pref: userVotePreference || 'everyone',
        filter_club_id: currentClubInfo.id
      };
    }

    const { data, error } = await supabaseClient.rpc(rpcName, rpcArgs);

    if (error) throw error;

    if (!data || data.length < 2) {
      displayNoMatchups();
      return;
    }

    currentMatchup = data;

    // Load left card image
    const imgLeft = document.getElementById('img-left');
    imgLeft.src = data[0].avatar_url || DEFAULT_AVATAR;

    // Load right card image
    const imgRight = document.getElementById('img-right');
    imgRight.src = data[1].avatar_url || DEFAULT_AVATAR;

    // Reset error states
    document.querySelectorAll('.card-error').forEach(err => err.classList.add('hidden'));

    // Wait for image loading before hiding spinners
    let loadedCount = 0;
    const hideLoaderIfReady = () => {
      loadedCount++;
      if (loadedCount === 2) {
        document.querySelectorAll('.card-loader').forEach(loader => loader.classList.add('hidden'));
        const cardLeft = document.getElementById('card-left');
        const cardRight = document.getElementById('card-right');
        cardLeft.classList.remove('fade-out');
        cardRight.classList.remove('fade-out');
        cardLeft.style.pointerEvents = 'auto';
        cardRight.style.pointerEvents = 'auto';
      }
    };

    imgLeft.onload = hideLoaderIfReady;
    imgRight.onload = hideLoaderIfReady;

    // Image error handlers
    imgLeft.onerror = () => {
      document.querySelector('#card-left .card-loader').classList.add('hidden');
      document.querySelector('#card-left .card-error').classList.remove('hidden');
      hideLoaderIfReady();
    };
    imgRight.onerror = () => {
      document.querySelector('#card-right .card-loader').classList.add('hidden');
      document.querySelector('#card-right .card-error').classList.remove('hidden');
      hideLoaderIfReady();
    };

    // Apply slight random rotation to cards for a playful feel
    const rotLeft = (Math.random() * 4 - 2).toFixed(1); // -2 to 2 degrees
    const rotRight = (Math.random() * 4 - 2).toFixed(1);
    document.getElementById('card-left').style.transform = `rotate(${rotLeft}deg)`;
    document.getElementById('card-right').style.transform = `rotate(${rotRight}deg)`;

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
  const arena = document.querySelector('#screen-mash .mash-arena');
  if (arena) arena.classList.add('hidden');
  const noMatchupsView = document.getElementById('view-no-matchups');
  if (noMatchupsView) {
    const titleEl = noMatchupsView.querySelector('h3');
    const descEl = noMatchupsView.querySelector('p');
    if (isMashClubMode) {
      if (titleEl) titleEl.innerText = 'Not Enough Members';
      if (descEl) descEl.innerText = 'There are not enough active members in this club with photos to vote on. Invite more club members to join!';
    } else {
      if (titleEl) titleEl.innerText = 'No Matchups Yet';
      if (descEl) descEl.innerText = 'To start voting, invite more friends to join Climb and upload their photos!';
    }
    noMatchupsView.classList.remove('hidden');
  }
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

    // Haptic feedback on successful vote
    if (navigator.vibrate) {
      navigator.vibrate(15);
    }

    if (currentProfile) {
      currentProfile.votes_cast = (currentProfile.votes_cast || 0) + 1;
      updateNavigationLocks();
    }

    showToast('Vote registered!', 'success');

  } catch (err) {
    console.error('Failed to submit vote:', err);
    showToast('Could not register vote.', 'error');
  } finally {
    // Reset border color and click state immediately
    document.getElementById('card-left').style.borderColor = 'var(--border-color)';
    document.getElementById('card-right').style.borderColor = 'var(--border-color)';
    
    document.getElementById('card-left').classList.add('fade-out');
    document.getElementById('card-right').classList.add('fade-out');

    loadNextMatchup();
  }
}

// --- Leaderboards Functions ---
async function loadLeaderboard() {
  if (!currentUser) return;

  const listContainer = document.getElementById('leaderboard-list');

  listContainer.innerHTML = '<div class="text-center py-4"><div class="spinner" style="margin: 20px auto;"></div><p style="color: var(--text-muted);">Rebuilding rankings...</p></div>';

  try {
    // 1. Fetch rankings list
    let leaderboardData = [];
    
    if (currentLeaderboardTab === 'club') {
      if (!currentClubInfo) {
        listContainer.innerHTML = `
          <div class="text-center py-4" style="color: var(--text-muted); font-size: 0.9rem; padding: 40px 0;">
            You must join a club to view its leaderboard.
          </div>`;
        return;
      }
      const { data, error } = await supabaseClient.rpc('get_club_leaderboard', {
        target_club_id: currentClubInfo.id,
        gender_filter: currentLeaderboardGender
      });
      if (error) throw error;
      leaderboardData = data;
    } else {
      const { data, error } = await supabaseClient.rpc('get_leaderboard_data', {
        viewer_id: currentUser.id,
        viewer_lat: userCoordinates.lat || 0,
        viewer_lon: userCoordinates.lng || 0,
        viewer_state: userState || 'Unknown State',
        lb_type: currentLeaderboardTab,
        gender_filter: currentLeaderboardGender
      });
      if (error) throw error;
      leaderboardData = data;
    }

    // 2. Populate rankings in UI
    listContainer.innerHTML = '';

    if (!leaderboardData || leaderboardData.length === 0) {
      listContainer.innerHTML = `
        <div class="text-center py-4" style="color: var(--text-muted); font-size: 0.9rem; padding: 40px 0;">
          No ranking records found for this category yet.
        </div>`;
    } else {
      leaderboardData.forEach((row, index) => {
        const isSelf = row.user_id === currentUser.id;
        const votes = (currentProfile && currentProfile.votes_cast) || 0;
        
        let displayRank = currentLeaderboardTab === 'club' ? (index + 1) : row.relative_rank;
        let displayElo = '';
        
        if (isSelf) {
          let rankThreshold = 500;

          if (votes < rankThreshold) {
            displayRank = '--';
          }
        }

        const rowEl = document.createElement('div');
        rowEl.className = 'rank-row';
        rowEl.innerHTML = `
          <div class="rank-badge">${displayRank}</div>
          <img class="rank-avatar" src="${row.avatar_url || DEFAULT_AVATAR}" alt="Profile Avatar">
          <div class="rank-info">
            <div class="rank-name">${isSelf ? 'You' : (row.first_name || 'Climber')}</div>
            <div class="rank-meta">${row.state || 'Unknown State'}</div>
          </div>
          <div class="rank-elo">${displayElo}</div>
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

    const stats = (!statsError && rankStats && rankStats.length > 0) ? rankStats[0] : null;
    let displayRank = '--';
    let displayTotal = '--';
    let scopeLabel = '';

    // Check if self is in the loaded list
    const myIndexInList = leaderboardData.findIndex(row => row.user_id === currentUser.id);

    if (currentLeaderboardTab === 'global') {
      scopeLabel = 'Global';
      if (myIndexInList !== -1) {
        displayRank = leaderboardData[myIndexInList].relative_rank || (myIndexInList + 1);
        displayTotal = leaderboardData.length;
      } else if (stats && stats.global_rank > 0) {
        displayRank = stats.global_rank;
        displayTotal = stats.total_global;
      }
    } else if (currentLeaderboardTab === 'state') {
      scopeLabel = userState || 'Regional';
      if (myIndexInList !== -1) {
        displayRank = leaderboardData[myIndexInList].relative_rank || (myIndexInList + 1);
        displayTotal = leaderboardData.length;
      } else if (stats && stats.state_rank > 0) {
        displayRank = stats.state_rank;
        displayTotal = stats.total_state;
      }
    } else if (currentLeaderboardTab === 'club' && currentClubInfo) {
      scopeLabel = currentClubInfo.name || 'Club';
      if (myIndexInList !== -1) {
        displayRank = myIndexInList + 1;
        displayTotal = leaderboardData.length;
      }
    }

    if (displayRank !== '--' && currentProfile) {
      const votes = currentProfile.votes_cast || 0;
      document.getElementById('sticky-user-avatar').src = currentProfile.avatar_url || DEFAULT_AVATAR;
      
      const threshold = 500;
      if (votes < threshold) {
        document.getElementById('sticky-user-location').innerText = `${scopeLabel} (${threshold - votes} more votes needed)`;
        stickyRow.querySelector('.user-rank').innerText = '--';
      } else {
        document.getElementById('sticky-user-location').innerText = `${scopeLabel} (Rank #${displayRank} of ${displayTotal})`;
        stickyRow.querySelector('.user-rank').innerText = displayRank;
      }

      const stickyEloEl = document.getElementById('sticky-user-elo');
      if (stickyEloEl) stickyEloEl.classList.add('hidden');
      stickyRow.classList.remove('hidden');
    } else {
      stickyRow.classList.add('hidden');
    }

  } catch (err) {
    console.error('Failed to load leaderboard:', err);
    showToast(`Failed to load rankings snapshot: ${err.message || err}`, 'error');
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
    document.getElementById('profile-location-display').innerText = `Region: ${profile.state || 'Unknown'}`;

    const votes = profile.votes_cast || 0;
    document.getElementById('stat-votes').innerText = votes;

    if (votes < 500) {
      document.getElementById('rank-val-global').innerText = `${500 - votes} more votes needed`;
    } else {
      document.getElementById('rank-val-global').innerText = '--';
    }

    if (votes < 500) {
      document.getElementById('rank-val-state').innerText = `${500 - votes} more votes needed`;
    } else {
      document.getElementById('rank-val-state').innerText = '--';
    }

    if (votes < 250) {
      document.getElementById('stat-elo').innerText = `${250 - votes} more votes needed`;
    } else {
      document.getElementById('stat-elo').innerText = eloToGrade(profile.elo);
    }

    if (votes < 500) {
      document.getElementById('rank-val-club').innerText = `${500 - votes} more votes needed`;
    } else if (!currentClubInfo) {
      document.getElementById('rank-val-club').innerText = 'No Club';
    } else {
      let myClubRank = '--';
      if (currentClubMembers && currentClubMembers.length > 0) {
        const myIndex = currentClubMembers.findIndex(m => m.user_id === currentUser.id);
        if (myIndex !== -1) myClubRank = `${myIndex + 1} / ${currentClubMembers.length}`;
      }
      document.getElementById('rank-val-club').innerText = myClubRank;
    }



    // Fetch user ranks for stats list
    const { data: rankStats, error: statsError } = await supabaseClient.rpc('get_user_ranks', {
      user_id_param: currentUser.id,
      viewer_lat: profile.latitude,
      viewer_lon: profile.longitude,
      viewer_state: profile.state || 'Unknown State'
    });

    if (!statsError && rankStats && rankStats.length > 0) {
      if (votes >= 500) {
        document.getElementById('rank-val-global').innerText = rankStats[0].total_global > 0 ? `${rankStats[0].global_rank} / ${rankStats[0].total_global}` : '--';
      }
      if (votes >= 500) {
        document.getElementById('rank-val-state').innerText = rankStats[0].total_state > 0 ? `${rankStats[0].state_rank} / ${rankStats[0].total_state}` : '--';
      }
    }

  } catch (err) {
    console.error('Failed to load profile information:', err);
    showToast(`Failed to load profile information: ${err.message || err}`, 'error');
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

function eloToGrade(elo) {
  if (elo === null || elo === undefined) return '--';
  const val = Math.round(elo);
  if (val >= 1600) return 'A+';
  if (val >= 1500) return 'A';
  if (val >= 1400) return 'A-';
  if (val >= 1300) return 'B+';
  if (val >= 1200) return 'B';
  if (val >= 1100) return 'B-';
  if (val >= 1000) return 'C+';
  if (val >= 900) return 'C';
  if (val >= 800) return 'C-';
  if (val >= 700) return 'D';
  return 'F';
}

function updateNavigationLocks() {
  const votes = (currentProfile && currentProfile.votes_cast) || 0;
  const isLocked = votes < 25;
  
  document.querySelectorAll('.bottom-nav .nav-item[data-screen="leaderboard"]').forEach(btn => {
    if (isLocked) {
      btn.classList.add('locked-nav');
      btn.querySelector('.nav-label').innerText = `${25 - votes} Votes`;
    } else {
      btn.classList.remove('locked-nav');
      btn.querySelector('.nav-label').innerText = 'Summit';
    }
  });

  document.querySelectorAll('.bottom-nav .nav-item[data-screen="clubs"]').forEach(btn => {
    if (isLocked) {
      btn.classList.add('locked-nav');
      btn.querySelector('.nav-label').innerText = `${25 - votes} Votes`;
    } else {
      btn.classList.remove('locked-nav');
      btn.querySelector('.nav-label').innerText = 'Clubs';
    }
  });
}

function openCropModal(file, context) {
  currentCroppingContext = context;
  const reader = new FileReader();
  reader.readAsDataURL(file);
  reader.onload = (e) => {
    cropState.imgSrc = e.target.result;
    
    const modalImg = document.getElementById('modal-crop-image');
    modalImg.src = e.target.result;
    modalImg.style.display = 'block';
    
    document.getElementById('crop-modal').classList.remove('hidden');
    
    modalImg.onload = () => {
      const viewportSize = 250;
      const naturalWidth = modalImg.naturalWidth;
      const naturalHeight = modalImg.naturalHeight;
      
      if (naturalWidth > naturalHeight) {
        cropState.imgHeight = viewportSize;
        cropState.imgWidth = (naturalWidth / naturalHeight) * viewportSize;
      } else {
        cropState.imgWidth = viewportSize;
        cropState.imgHeight = (naturalHeight / naturalWidth) * viewportSize;
      }
      
      cropState.x = (viewportSize - cropState.imgWidth) / 2;
      cropState.y = (viewportSize - cropState.imgHeight) / 2;
      cropState.zoom = 1;
      
      const zoomSlider = document.getElementById('modal-crop-zoom');
      zoomSlider.value = 1;
      
      applyCropStateStyles();
    };
  };
}

function applyCropStateStyles() {
  const modalImg = document.getElementById('modal-crop-image');
  const viewportSize = 250;
  
  const width = cropState.imgWidth * cropState.zoom;
  const height = cropState.imgHeight * cropState.zoom;
  
  cropState.x = Math.max(viewportSize - width, Math.min(0, cropState.x));
  cropState.y = Math.max(viewportSize - height, Math.min(0, cropState.y));
  
  modalImg.style.width = width + 'px';
  modalImg.style.height = height + 'px';
  modalImg.style.left = cropState.x + 'px';
  modalImg.style.top = cropState.y + 'px';
}

function getCroppedImageBlob(targetSize = 500) {
  return new Promise((resolve, reject) => {
    if (!cropState.imgSrc) {
      reject(new Error("No image loaded"));
      return;
    }
    const img = new Image();
    img.src = cropState.imgSrc;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = targetSize;
      canvas.height = targetSize;
      const ctx = canvas.getContext('2d');

      const viewportSize = 250;
      const currentWidth = cropState.imgWidth * cropState.zoom;
      const currentHeight = cropState.imgHeight * cropState.zoom;

      const ratioX = img.naturalWidth / currentWidth;
      const ratioY = img.naturalHeight / currentHeight;

      const sx = -cropState.x * ratioX;
      const sy = -cropState.y * ratioY;
      const sWidth = viewportSize * ratioX;
      const sHeight = viewportSize * ratioY;

      ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, targetSize, targetSize);

      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Failed to crop image"));
        }
      }, 'image/jpeg', 0.85);
    };
    img.onerror = (err) => reject(err);
  });
}



// =============================================
// Clubs Feature Logic
// =============================================

function loadClubScreen() {
  const viewNoClub = document.getElementById('view-no-club');
  const viewHasClub = document.getElementById('view-has-club');

  if (!currentClubInfo) {
    viewNoClub.style.display = 'flex';
    viewHasClub.style.display = 'none';
  } else {
    viewNoClub.style.display = 'none';
    viewHasClub.style.display = 'flex';

    document.getElementById('text-club-name').innerText = currentClubInfo.name;
    document.getElementById('text-club-code').innerText = currentClubInfo.code;
    document.getElementById('text-club-member-count').innerText = currentClubMembers.length;
    
    // Edit features for creator
    if (currentClubInfo.created_by === currentUser.id) {
      document.getElementById('btn-edit-club-name').classList.remove('hidden');
      document.getElementById('text-leave-club-warning').classList.remove('hidden');
    } else {
      document.getElementById('btn-edit-club-name').classList.add('hidden');
      document.getElementById('text-leave-club-warning').classList.add('hidden');
    }

    // Render Members List
    const membersListContainer = document.getElementById('club-members-list');
    membersListContainer.innerHTML = '';
    
    const sortedMembers = [...currentClubMembers].sort((a, b) => {
      if (a.user_id === currentClubInfo.created_by) return -1;
      if (b.user_id === currentClubInfo.created_by) return 1;
      return (a.first_name || '').localeCompare(b.first_name || '');
    });

    sortedMembers.forEach((member) => {
      const isSelf = member.user_id === currentUser.id;
      const isCreator = currentClubInfo.created_by === currentUser.id;
      
      const rowEl = document.createElement('div');
      rowEl.className = 'rank-row';
      
      let removeBtnHtml = '';
      if (isCreator && !isSelf) {
        removeBtnHtml = `<button class="btn btn-sm" onclick="removeClubMember('${member.user_id}')" style="background:transparent; color:#ff4d4d; border:none; padding:4px;">✕</button>`;
      }

      rowEl.innerHTML = `
        <img class="rank-avatar" src="${member.avatar_url || DEFAULT_AVATAR}" alt="Avatar">
        <div class="rank-info" style="flex-grow: 1;">
          <div class="rank-name">${isSelf ? 'You' : member.first_name} ${member.user_id === currentClubInfo.created_by ? '(Creator)' : ''}</div>
          <div class="rank-meta">${member.state || 'Unknown'}</div>
        </div>
        ${removeBtnHtml}
      `;
      membersListContainer.appendChild(rowEl);
    });
  }
}

async function createClub() {
  const nameInput = document.getElementById('input-create-club-name');
  const name = nameInput.value.trim();
  if (!name) return;

  setButtonLoading('btn-create-club', true, 'Creating...');
  try {
    const { data, error } = await supabaseClient.rpc('create_club', { club_name: name });
    if (error) throw error;
    
    showToast('Club created!', 'success');
    nameInput.value = '';
    
    // Refresh club state
    const { data: clubData, error: clubError } = await supabaseClient.rpc('get_my_club');
    if (!clubError && clubData) {
      currentClubInfo = clubData.club;
      currentClubMembers = clubData.members || [];
      loadClubScreen();
    }
  } catch (err) {
    showToast(err.message || 'Failed to create club', 'error');
  } finally {
    setButtonLoading('btn-create-club', false, 'Create Club');
  }
}

async function joinClub() {
  const codeInput = document.getElementById('input-join-club-code');
  const code = codeInput.value.trim().toUpperCase();
  if (!code || code.length !== 6) {
    showToast('Please enter a valid 6-character code', 'error');
    return;
  }

  setButtonLoading('btn-join-club', true, 'Joining...');
  try {
    const { data, error } = await supabaseClient.rpc('join_club', { invite_code: code });
    if (error) throw error;
    
    showToast('Joined club successfully!', 'success');
    codeInput.value = '';
    
    // Refresh club state
    const { data: clubData, error: clubError } = await supabaseClient.rpc('get_my_club');
    if (!clubError && clubData) {
      currentClubInfo = clubData.club;
      currentClubMembers = clubData.members || [];
      loadClubScreen();
    }
  } catch (err) {
    showToast(err.message || 'Failed to join club', 'error');
  } finally {
    setButtonLoading('btn-join-club', false, 'Join Club');
  }
}

async function leaveClub() {
  const isCreator = currentClubInfo && currentClubInfo.created_by === currentUser.id;
  const msg = isCreator ? "Are you sure? Since you are the creator, this will permanently delete the club and remove all members." : "Are you sure you want to leave this club?";
  if (!confirm(msg)) return;

  try {
    const { error } = await supabaseClient.rpc('leave_club');
    if (error) throw error;
    
    showToast(isCreator ? 'Club deleted.' : 'You have left the club.', 'success');
    
    // Clear state
    currentClubInfo = null;
    currentClubMembers = [];
    isMashClubMode = false;
    document.getElementById('btn-climb-global')?.click(); // Reset mash screen toggle
    loadClubScreen();
  } catch (err) {
    showToast(err.message || 'Failed to leave club', 'error');
  }
}

async function saveClubName() {
  const nameInput = document.getElementById('input-edit-club-name');
  const newName = nameInput.value.trim();
  if (!newName || newName === currentClubInfo.name) {
    document.getElementById('club-name-display').classList.remove('hidden');
    document.getElementById('club-name-edit').classList.add('hidden');
    return;
  }

  setButtonLoading('btn-save-club-name', true, 'Saving...');
  try {
    const { error } = await supabaseClient.rpc('update_club_name', { new_name: newName });
    if (error) throw error;
    
    showToast('Club name updated', 'success');
    currentClubInfo.name = newName;
    document.getElementById('text-club-name').innerText = newName;
  } catch (err) {
    showToast(err.message || 'Failed to update club name', 'error');
  } finally {
    setButtonLoading('btn-save-club-name', false, 'Save');
    document.getElementById('club-name-display').classList.remove('hidden');
    document.getElementById('club-name-edit').classList.add('hidden');
  }
}

window.removeClubMember = async function(userId) {
  if (!confirm('Are you sure you want to remove this member?')) return;
  
  try {
    const { error } = await supabaseClient.rpc('remove_club_member', { target_user_id: userId });
    if (error) throw error;
    
    showToast('Member removed', 'success');
    
    // Refresh club state
    const { data: clubData, error: clubError } = await supabaseClient.rpc('get_my_club');
    if (!clubError && clubData) {
      currentClubMembers = clubData.members || [];
      loadClubScreen();
    }
  } catch (err) {
    showToast(err.message || 'Failed to remove member', 'error');
  }
};

function shareClubCode() {
  if (!currentClubInfo) return;
  const shareText = `Join my Climb club: ${currentClubInfo.name}! Invite Code: ${currentClubInfo.code}\n\nJoin here: https://climb.side-eye.xyz`;
  
  if (navigator.share) {
    navigator.share({
      title: 'Join my Club on Climb',
      text: shareText
    }).catch(console.error);
  } else {
    navigator.clipboard.writeText(shareText).then(() => {
      showToast('Invite code copied to clipboard!', 'success');
    });
  }
}

// --- Major Cities Dataset ---
const CITIES = [
  { name: "Washington, D.C.", lat: 38.9072, lng: -77.0369 },
  { name: "New York City, NY", lat: 40.7128, lng: -74.0060 },
  { name: "Los Angeles, CA", lat: 34.0522, lng: -118.2437 },
  { name: "Chicago, IL", lat: 41.8781, lng: -87.6298 },
  { name: "Houston, TX", lat: 29.7604, lng: -95.3698 },
  { name: "Phoenix, AZ", lat: 33.4484, lng: -112.0740 },
  { name: "Philadelphia, PA", lat: 39.9526, lng: -75.1652 },
  { name: "San Antonio, TX", lat: 29.4241, lng: -98.4936 },
  { name: "San Diego, CA", lat: 32.7157, lng: -117.1611 },
  { name: "Dallas, TX", lat: 32.7767, lng: -96.7970 },
  { name: "San Jose, CA", lat: 37.3382, lng: -121.8863 },
  { name: "Austin, TX", lat: 30.2672, lng: -97.7431 },
  { name: "Jacksonville, FL", lat: 30.3322, lng: -81.6557 },
  { name: "San Francisco, CA", lat: 37.7749, lng: -122.4194 },
  { name: "Indianapolis, IN", lat: 39.7684, lng: -86.1581 },
  { name: "Seattle, WA", lat: 47.6062, lng: -122.3321 },
  { name: "Denver, CO", lat: 39.7392, lng: -104.9903 },
  { name: "Boston, MA", lat: 42.3601, lng: -71.0589 },
  { name: "Nashville, TN", lat: 36.1627, lng: -86.7816 },
  { name: "Detroit, MI", lat: 42.3314, lng: -83.0458 },
  { name: "Portland, OR", lat: 45.5152, lng: -122.6784 },
  { name: "Las Vegas, NV", lat: 36.1716, lng: -115.1398 },
  { name: "Miami, FL", lat: 25.7617, lng: -80.1918 },
  { name: "Atlanta, GA", lat: 33.7490, lng: -84.3880 },
  { name: "Charlotte, NC", lat: 35.2271, lng: -80.8431 },
  { name: "Columbus, OH", lat: 39.9612, lng: -82.9988 },
  { name: "El Paso, TX", lat: 31.7619, lng: -106.4850 },
  { name: "Memphis, TN", lat: 35.1495, lng: -90.0490 },
  { name: "Baltimore, MD", lat: 39.2904, lng: -76.6122 },
  { name: "Milwaukee, WI", lat: 43.0389, lng: -87.9065 },
  { name: "Albuquerque, NM", lat: 35.0844, lng: -106.6504 },
  { name: "Kansas City, MO", lat: 39.0997, lng: -94.5786 },
  { name: "Minneapolis, MN", lat: 44.9778, lng: -93.2650 },
  { name: "Cleveland, OH", lat: 41.4993, lng: -81.6944 },
  { name: "Pittsburgh, PA", lat: 40.4406, lng: -79.9959 },
  { name: "Orlando, FL", lat: 28.5383, lng: -81.3792 },
  { name: "Tampa, FL", lat: 27.9506, lng: -82.4572 },
  { name: "St. Louis, MO", lat: 38.6270, lng: -90.1994 },
  { name: "Salt Lake City, UT", lat: 40.7608, lng: -111.8910 },
  { name: "Honolulu, HI", lat: 21.3069, lng: -157.8583 },
  { name: "New Orleans, LA", lat: 29.9511, lng: -90.0715 },
  { name: "Toronto, ON", lat: 43.6532, lng: -79.3832 },
  { name: "Montreal, QC", lat: 45.5017, lng: -73.5673 },
  { name: "Vancouver, BC", lat: 49.2827, lng: -123.1207 },
  { name: "Calgary, AB", lat: 51.0447, lng: -114.0719 },
  { name: "Edmonton, AB", lat: 53.5461, lng: -113.4938 },
  { name: "Ottawa, ON", lat: 45.4215, lng: -75.6972 },
  { name: "Winnipeg, MB", lat: 49.8951, lng: -97.1384 },
  { name: "Quebec City, QC", lat: 46.8139, lng: -71.2082 },
  { name: "Halifax, NS", lat: 44.6488, lng: -63.5752 },
  { name: "Victoria, BC", lat: 48.4284, lng: -123.3656 },
  { name: "Portland, ME", lat: 43.6591, lng: -70.2568 },
  { name: "Anchorage, AK", lat: 61.2181, lng: -149.9003 },
  { name: "Sacramento, CA", lat: 38.5816, lng: -121.4944 },
  { name: "Cincinnati, OH", lat: 39.1031, lng: -84.5120 },
  { name: "St. John's, NL", lat: 47.5615, lng: -52.7126 }
];

// --- Searchable Combobox logic ---
function initCityComboboxes() {
  setupCityCombobox("combobox-reg-region", "input-state-search", "select-state", "options-reg-region");
  setupCityCombobox("combobox-settings-region", "input-settings-state-search", "select-settings-state", "options-settings-region");
}

function setupCityCombobox(containerId, inputId, hiddenId, optionsId) {
  const container = document.getElementById(containerId);
  const inputEl = document.getElementById(inputId);
  const hiddenEl = document.getElementById(hiddenId);
  const optionsEl = document.getElementById(optionsId);
  
  if (!container || !inputEl || !hiddenEl || !optionsEl) return;

  const dropdown = container.querySelector(".combobox-dropdown");

  function renderOptions(filterText = "") {
    optionsEl.innerHTML = "";
    const filtered = CITIES.filter(c => 
      c.name.toLowerCase().includes(filterText.toLowerCase())
    );
    
    if (filtered.length === 0) {
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "combobox-option";
      emptyDiv.style.color = "var(--text-muted)";
      emptyDiv.style.cursor = "default";
      emptyDiv.innerText = "No cities found";
      optionsEl.appendChild(emptyDiv);
      return;
    }
    
    filtered.forEach(city => {
      const option = document.createElement("div");
      option.className = "combobox-option";
      if (hiddenEl.value === city.name) {
        option.classList.add("selected");
      }
      option.innerText = city.name;
      
      option.addEventListener("click", () => {
        hiddenEl.value = city.name;
        inputEl.value = city.name;
        
        // Update user state and coordinates if this is registration
        if (hiddenEl.id === "select-state") {
          userState = city.name;
          userCoordinates.lat = city.lat;
          userCoordinates.lng = city.lng;
          checkRegistrationSubmittable();
        }
        
        dropdown.classList.add("hidden");
      });
      optionsEl.appendChild(option);
    });
  }

  // Open dropdown on focus/click
  inputEl.addEventListener("focus", () => {
    renderOptions(inputEl.value);
    dropdown.classList.remove("hidden");
  });
  
  inputEl.addEventListener("click", () => {
    renderOptions(inputEl.value);
    dropdown.classList.remove("hidden");
  });

  // Filter on type
  inputEl.addEventListener("input", () => {
    renderOptions(inputEl.value);
    dropdown.classList.remove("hidden");
    
    const matchesExact = CITIES.some(c => c.name.toLowerCase() === inputEl.value.trim().toLowerCase());
    if (!matchesExact) {
      hiddenEl.value = "";
      if (hiddenEl.id === "select-state") {
        checkRegistrationSubmittable();
      }
    } else {
      const matchedCity = CITIES.find(c => c.name.toLowerCase() === inputEl.value.trim().toLowerCase());
      hiddenEl.value = matchedCity.name;
      if (hiddenEl.id === "select-state") {
        userState = matchedCity.name;
        userCoordinates.lat = matchedCity.lat;
        userCoordinates.lng = matchedCity.lng;
        checkRegistrationSubmittable();
      }
    }
  });

  // Close dropdown on click outside
  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) {
      dropdown.classList.add("hidden");
      
      const exactMatch = CITIES.find(c => c.name.toLowerCase() === inputEl.value.trim().toLowerCase());
      if (exactMatch) {
        inputEl.value = exactMatch.name;
        hiddenEl.value = exactMatch.name;
        if (hiddenEl.id === "select-state") {
          userState = exactMatch.name;
          userCoordinates.lat = exactMatch.lat;
          userCoordinates.lng = exactMatch.lng;
          checkRegistrationSubmittable();
        }
      } else if (hiddenEl.value) {
        inputEl.value = hiddenEl.value;
      } else {
        inputEl.value = "";
        hiddenEl.value = "";
        if (hiddenEl.id === "select-state") {
          checkRegistrationSubmittable();
        }
      }
    }
  });
}

// --- Onboarding Card Random Rotations ---
function applyOnboardingRotations() {
  document.querySelectorAll('#screen-auth .mash-card, #screen-register .mash-card').forEach(card => {
    const rot = (Math.random() * 4 - 2).toFixed(1); // Random angle between -2 and 2 degrees
    card.style.transform = `rotate(${rot}deg)`;
  });
}

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

let currentCroppingContext = "register";
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
    updateNavigationLocks();

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
    openCropModal(file, 'register');
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

  // Registration Wizard Logic
  document.getElementById('btn-next-step-1').addEventListener('click', () => {
    const fName = document.getElementById('input-first-name').value.trim();
    const gender = document.getElementById('select-gender').value;
    const pref = document.getElementById('select-vote-pref').value;
    if (!fName || !gender || !pref) {
      showToast('Please fill out all fields.', 'error');
      return;
    }
    document.getElementById('reg-step-1').classList.remove('wizard-active');
    document.getElementById('reg-step-1').classList.add('hidden');
    document.getElementById('reg-step-2').classList.remove('hidden');
    document.getElementById('reg-step-2').classList.add('wizard-active');
  });

  document.getElementById('btn-prev-step-2').addEventListener('click', () => {
    document.getElementById('reg-step-2').classList.remove('wizard-active');
    document.getElementById('reg-step-2').classList.add('hidden');
    document.getElementById('reg-step-1').classList.remove('hidden');
    document.getElementById('reg-step-1').classList.add('wizard-active');
  });

  document.getElementById('btn-next-step-2').addEventListener('click', () => {
    if (!selectedRegistrationFileBlob) {
      showToast('Please upload a photo.', 'error');
      return;
    }
    document.getElementById('reg-step-2').classList.remove('wizard-active');
    document.getElementById('reg-step-2').classList.add('hidden');
    document.getElementById('reg-step-3').classList.remove('hidden');
    document.getElementById('reg-step-3').classList.add('wizard-active');
  });

  document.getElementById('btn-prev-step-3').addEventListener('click', () => {
    document.getElementById('reg-step-3').classList.remove('wizard-active');
    document.getElementById('reg-step-3').classList.add('hidden');
    document.getElementById('reg-step-2').classList.remove('hidden');
    document.getElementById('reg-step-2').classList.add('wizard-active');
  });

  // Profile: Edit Photo Update
  const updateAvatarInput = document.getElementById('input-update-avatar');
  if (updateAvatarInput) {
    updateAvatarInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file || !currentUser) return;
      
      const label = document.querySelector('.edit-photo-btn');
      label.innerText = 'Uploading...';
      
      try {
        const compressedFile = await compressImage(file, 600, 600, 0.7);
        let fileExt = file.name.split('.').pop();
        if (compressedFile.type === 'image/jpeg') fileExt = 'jpg';
        if (compressedFile.type === 'image/png') fileExt = 'png';
        const filePath = `${currentUser.id}/${Date.now()}.${fileExt}`;
        
        const { error: uploadError } = await supabaseClient.storage
          .from('avatars')
          .upload(filePath, compressedFile);
          
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
        showToast('Profile photo updated!', 'success');
      openCropModal(file, 'profile');
    });
  }

  // Navigation Items
  document.querySelectorAll('.bottom-nav .nav-item').forEach(button => {
    button.addEventListener('click', (e) => {
      const targetScreen = e.currentTarget.getAttribute('data-screen');
      if (targetScreen) {
        if (targetScreen === 'leaderboard' && (!currentProfile || currentProfile.votes_cast < 100)) {
          const votes = currentProfile ? currentProfile.votes_cast : 0;
          showToast(`You need more votes. Cast ${100 - votes} more votes to unlock the Leaderboards.`, 'error');
          return;
        }
        showScreen(targetScreen);
        if (targetScreen === 'mash') {
          if (currentMatchup.length === 0) loadNextMatchup();
        } else if (targetScreen === 'leaderboard') {
          loadLeaderboard();
        } else if (targetScreen === 'profile') {
          loadProfileData();
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
      
      settingsModal.classList.remove('hidden');
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
      
      setButtonLoading('btn-save-settings', true, 'Saving...');
      try {
        const { error } = await supabaseClient
          .from('profiles')
          .update({
            first_name: name,
            vote_preference: votePref,
            state: selectedState
          })
          .eq('id', currentUser.id);
        
        if (error) throw error;
        
        // Update local state
        currentProfile.first_name = name;
        currentProfile.vote_preference = votePref;
        currentProfile.state = selectedState;
        userState = selectedState;
        userVotePreference = votePref;
        
        await loadProfileData();
        settingsModal.classList.add('hidden');
        showToast('Settings saved successfully!', 'success');
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
      const croppedBlob = await getCroppedImageBlob(500);
      
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
              cacheControl: '3600',
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
          showToast('Profile photo updated!', 'success');
        } catch (err) {
          console.error(err);
          showToast('Failed to update photo.', 'error');
        } finally {
          label.innerText = 'Edit Photo';
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
    eloLeft.innerText = `Grade ${eloToGrade(data[0].elo)}`;

    // Load right card image and info
    const imgRight = document.getElementById('img-right');
    const eloRight = document.getElementById('elo-right');
    imgRight.src = data[1].avatar_url || DEFAULT_AVATAR;
    eloRight.innerText = `Grade ${eloToGrade(data[1].elo)}`;

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

    if (currentProfile) {
      currentProfile.votes_cast = (currentProfile.votes_cast || 0) + 1;
      updateNavigationLocks();
    }

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
        const isSelf = row.user_id === currentUser.id;
        const votes = (currentProfile && currentProfile.votes_cast) || 0;
        
        let displayRank = row.relative_rank;
        let displayElo = `Grade ${eloToGrade(row.elo)}`;
        
        if (isSelf) {
          if (votes < 1000) {
            displayRank = '--';
          }
          if (votes < 250) {
            displayElo = `${250 - votes} more votes needed`;
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
        const votes = currentProfile.votes_cast || 0;
        document.getElementById('sticky-user-avatar').src = currentProfile.avatar_url || DEFAULT_AVATAR;
        
        if (votes < 1000) {
          document.getElementById('sticky-user-location').innerText = `${userState} (${1000 - votes} more votes needed)`;
          stickyRow.querySelector('.user-rank').innerText = '--';
        } else {
          document.getElementById('sticky-user-location').innerText = `${userState} (Rank #${displayRank} of ${displayTotal})`;
          stickyRow.querySelector('.user-rank').innerText = displayRank;
        }

        if (votes < 250) {
          document.getElementById('sticky-user-elo').innerText = `${250 - votes} more votes needed`;
        } else {
          document.getElementById('sticky-user-elo').innerText = `Grade ${eloToGrade(currentProfile.elo)}`;
        }
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
    document.getElementById('profile-location-display').innerText = `State: ${profile.state || 'Unknown'}`;

    const votes = profile.votes_cast || 0;
    document.getElementById('stat-votes').innerText = votes;

    if (votes < 250) {
      document.getElementById('stat-elo').innerText = `${250 - votes} more votes needed`;
    } else {
      document.getElementById('stat-elo').innerText = eloToGrade(profile.elo);
    }

    // Fetch user ranks for stats list
    const { data: rankStats, error: statsError } = await supabaseClient.rpc('get_user_ranks', {
      user_id_param: currentUser.id,
      viewer_lat: profile.latitude,
      viewer_lon: profile.longitude,
      viewer_state: profile.state || 'Unknown State'
    });

    if (votes < 1000) {
      document.getElementById('rank-val-global').innerText = `${1000 - votes} more votes needed`;
      document.getElementById('rank-val-state').innerText = `${1000 - votes} more votes needed`;
      document.getElementById('rank-val-neighborhood').innerText = `${1000 - votes} more votes needed`;
    } else if (!statsError && rankStats && rankStats.length > 0) {
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
  const isLocked = votes < 100;
  
  document.querySelectorAll('.bottom-nav .nav-item[data-screen="leaderboard"]').forEach(btn => {
    if (isLocked) {
      btn.classList.add('locked-nav');
      btn.querySelector('.nav-label').innerText = 'Leaderboard 🔒';
    } else {
      btn.classList.remove('locked-nav');
      btn.querySelector('.nav-label').innerText = 'Leaderboard';
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

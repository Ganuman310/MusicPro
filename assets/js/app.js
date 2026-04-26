// ── APP STATE ──
let currentUser = null;
let tracks = [], queue = [], qPos = -1, nowTrack = null;
let playing = false, shuffle = false, repeat = 0, muted = false;
let speeds = [0.5, 0.75, 1, 1.1, 1.25, 1.5, 1.75, 2], spIdx = 2;
let playlists = [], activePl = null, durations = {};
let sleepSecs = 0, sleepTick = null, selMin = null;
let ctxTrk = null, dragSrc = null, favs = new Set();
let libQ = '', cachedFiles = new Set(), _dlAllRunning = false;

const audio = document.getElementById('audio');
const prog  = document.getElementById('prog');
const volBar = document.getElementById('volBar');
const CACHE_NAME = 'musicpro-audio-v1';

// ── INIT ──
document.addEventListener('DOMContentLoaded', async () => {
  // Check for existing session
  const session = await getSession();
  if (session) {
    currentUser = session.user;
    showApp();
    await loadUserData();
  } else {
    showAuth();
  }

  // Listen for auth state changes
  _supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session) {
      currentUser = session.user;
      showApp();
      await loadUserData();
    } else if (event === 'SIGNED_OUT') {
      currentUser = null;
      resetAppState();
      showAuth();
    }
  });
});

// ── AUTH FLOW ──
function showAuth() {
  document.getElementById('authScreen').style.display = 'flex';
  document.getElementById('appScreen').style.display = 'none';
}

function showApp() {
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('appScreen').style.display = 'grid';
  // Update user display
  const name = currentUser?.user_metadata?.full_name || currentUser?.email?.split('@')[0] || 'Friend';
  const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  document.querySelectorAll('.user-name-display').forEach(el => el.textContent = name);
  document.querySelectorAll('.user-avatar').forEach(el => el.textContent = initials);
  document.querySelectorAll('.user-greeting').forEach(el => {
    const h = new Date().getHours();
    const tod = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
    el.textContent = `Good ${tod}, ${name.split(' ')[0]}`;
  });
}

function resetAppState() {
  tracks = []; queue = []; qPos = -1; nowTrack = null;
  playlists = []; activePl = null; favs = new Set();
  audio.pause(); audio.src = '';
  renderLibrary(); renderSidebar();
}

async function loadUserData() {
  if (!currentUser) return;
  try {
    // Load preferences
    const prefs = await dbGetPreferences(currentUser.id);
    if (prefs) {
      spIdx = prefs.speed_index ?? 2;
      const v = prefs.volume ?? 1;
      audio.volume = v; volBar.value = v; setRangeStyle(volBar, v * 100);
      shuffle = prefs.shuffle ?? false;
      repeat  = prefs.repeat  ?? 0;
      document.getElementById('btnShuffle')?.classList.toggle('on', shuffle);
      applyRepeatUI();
    }
    document.getElementById('speedPill').textContent = speeds[spIdx] + '×';

    // Load favourites
    const favList = await dbGetFavourites(currentUser.id);
    favs = new Set(favList);

    // Load playlists
    const pls = await dbGetPlaylists(currentUser.id);
    playlists = pls.map(pl => ({
      id: pl.id,
      name: pl.name,
      emoji: pl.emoji || '📚',
      tracks: (pl.playlist_tracks || [])
        .sort((a, b) => a.position - b.position)
        .map(t => t.filename)
    }));
    renderSidebar();

    // Load GitHub library config
    const ghUser = prefs?.gh_user || '';
    const ghRepo = prefs?.gh_repo || '';
    if (document.getElementById('ghUser')) document.getElementById('ghUser').value = ghUser;
    if (document.getElementById('ghRepo')) document.getElementById('ghRepo').value = ghRepo;
    if (ghUser && ghRepo) setTimeout(() => scanDatabase(true), 600);
    else {
      try {
        const cached = JSON.parse(localStorage.getItem('mp_tracks_' + currentUser.id) || '[]');
        if (cached.length) buildTracksFromList(cached);
      } catch {}
    }

    // Load encryption password silently from Supabase
    await _loadEncPass();

    // Refresh cached files
    await refreshCachedFiles();
    renderLibrary(); updateDlAllBtn();
    initEmojiGrid();
    setRangeStyle(prog, 0);
    updateCacheStatus();

  } catch (e) {
    console.error('loadUserData error', e);
    toast('⚠️ Could not load your data');
  }
}

// ── AUTH EVENT HANDLERS ──
window.handleGoogleLogin = async () => {
  try {
    setAuthLoading(true);
    await signInWithGoogle();
    // Page will redirect and come back — onAuthStateChange handles the rest
  } catch (e) {
    setAuthLoading(false);
    showAuthError(e.message);
  }
};

window.handleEmailAuth = async (isSignup) => {
  const email = document.getElementById('authEmail')?.value.trim();
  const password = document.getElementById('authPassword')?.value;
  const name = document.getElementById('authName')?.value.trim();

  if (!email || !password) { showAuthError('Enter email and password'); return; }
  if (isSignup && !name) { showAuthError('Enter your name'); return; }

  try {
    setAuthLoading(true);
    if (isSignup) {
      await signUpWithEmail(email, password, name);
      showAuthMessage('✅ Account created! Check your email to confirm.');
    } else {
      await signInWithEmail(email, password);
      // onAuthStateChange handles the rest
    }
  } catch (e) {
    setAuthLoading(false);
    showAuthError(e.message);
  }
};

window.handleSignOut = async () => {
  try { await signOut(); } catch (e) { toast('❌ Sign out failed'); }
};

function setAuthLoading(on) {
  document.querySelectorAll('.auth-btn').forEach(b => {
    b.disabled = on;
    if (on) b.dataset.orig = b.textContent;
    else b.textContent = b.dataset.orig || b.textContent;
  });
  if (on) document.querySelector('.google-btn')?.setAttribute('disabled', 'true');
  else document.querySelector('.google-btn')?.removeAttribute('disabled');
}

function showAuthError(msg) {
  const el = document.getElementById('authError');
  if (el) { el.textContent = '❌ ' + msg; el.style.display = 'block'; }
  setAuthLoading(false);
}

function showAuthMessage(msg) {
  const el = document.getElementById('authError');
  if (el) { el.textContent = msg; el.style.color = '#1db954'; el.style.display = 'block'; }
  setAuthLoading(false);
}

window.toggleAuthMode = () => {
  const signup = document.getElementById('signupFields');
  const isNowSignup = signup.style.display !== 'none';
  signup.style.display = isNowSignup ? 'none' : 'block';
  document.getElementById('authSubmitBtn').textContent = isNowSignup ? 'Sign In' : 'Create Account';
  document.getElementById('authToggleText').innerHTML = isNowSignup
    ? 'No account? <span onclick="toggleAuthMode()">Sign up free</span>'
    : 'Already have an account? <span onclick="toggleAuthMode()">Sign in</span>';
  document.getElementById('authError').style.display = 'none';
};

// ── LIBRARY ──
function buildTracksFromList(filenames) {
  tracks = filenames.map(fn => {
    const bare = fn.replace(/^Database\//i, '').replace(/^MusicPro\/Database\//i, '');
    const title = bare.replace(/\.ganuman$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return { file: 'Database/' + bare, name: bare, title };
  });
  tracks.sort((a, b) => a.title.localeCompare(b.title));
  document.getElementById('libBadge').textContent = tracks.length + ' track' + (tracks.length !== 1 ? 's' : '');
  renderLibrary(); updateDlAllBtn();
}

async function scanDatabase(silent) {
  const user = (document.getElementById('ghUser')?.value || '').trim();
  const repo = (document.getElementById('ghRepo')?.value || '').trim();
  if (!user || !repo) { toast('❌ Enter GitHub username and repo name'); return; }
  setScanStatus('', 'Scanning…');
  if (!silent) toast('🔍 Scanning Database folder…');
  try {
    const files = await scanGitHubDatabase(user, repo);
    if (!files.length) { setScanStatus('err', 'No .ganuman files found'); return; }
    localStorage.setItem('mp_tracks_' + currentUser.id, JSON.stringify(files));
    buildTracksFromList(files);
    setScanStatus('ok', '✅ ' + files.length + ' tracks loaded');
    if (!silent) toast('✅ ' + files.length + ' tracks loaded!');
    // Save to prefs
    if (currentUser) dbSavePreferences(currentUser.id, { gh_user: user, gh_repo: repo });
  } catch (e) {
    setScanStatus('err', e.message);
    toast('❌ Scan failed: ' + e.message);
  }
}

function setScanStatus(state, msg) {
  const dot = document.getElementById('scanDot');
  const el  = document.getElementById('scanMsg');
  if (!dot || !el) return;
  dot.className = 'sdot' + (state === 'ok' ? ' ok' : state === 'err' ? ' err' : '');
  el.textContent = msg;
}

function renderLibrary() {
  const el = document.getElementById('libRows');
  const q  = libQ.toLowerCase();
  const list = q ? tracks.filter(t => t.title.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)) : tracks;
  if (!list.length) {
    el.innerHTML = `<div class="empty"><div class="ico">🎧</div><p>${
      tracks.length === 0
        ? 'Open <strong>Settings</strong> and add your GitHub username &amp; repo.'
        : 'No results.'
    }</p></div>`;
    return;
  }
  el.innerHTML = list.map((t, i) => {
    const gi = tracks.indexOf(t);
    const isNow = nowTrack && nowTrack.file === t.file;
    const dur = durations[t.file] ? fmt(durations[t.file]) : '—';
    const isCached = cachedFiles.has(t.file);
    return `<div class="track-row${isNow ? ' playing' : ''}" onclick="playLib(${gi})" oncontextmenu="openCtx(event,${gi})">
      <div class="trk-idx"><span class="num">${i + 1}</span>
        <div class="eq-wrap"><div class="eq-bar${playing ? '' : ' p'}" style="height:60%"></div><div class="eq-bar${playing ? '' : ' p'}" style="height:100%"></div><div class="eq-bar${playing ? '' : ' p'}" style="height:45%"></div></div>
      </div>
      <div class="trk-info"><div class="trk-name">${t.title}</div><div class="trk-meta">${t.name.replace(/\.ganuman$/i, '')}</div></div>
      <div class="trk-dur" id="ld-${gi}">${dur}</div>
      <button class="dl-btn ${isCached ? 'cached' : 'uncached'}" id="dlb-${gi}" title="${isCached ? 'Downloaded' : 'Download'}" onclick="event.stopPropagation();dlTrack(${gi})">
        ${isCached
          ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`
          : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`}
      </button>
      <button class="trk-btn" title="Add to playlist" onclick="event.stopPropagation();openCtxBtn(event,${gi})">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>`;
  }).join('');
  prefetch(list);
}

function prefetch(list) {
  list.forEach(t => {
    if (durations[t.file]) return;
    const a = new Audio();
    a.preload = 'metadata'; a.src = t.file;
    a.addEventListener('loadedmetadata', () => {
      durations[t.file] = a.duration;
      const gi = tracks.indexOf(t);
      const e1 = document.getElementById('ld-' + gi);
      const e2 = document.getElementById('pd-' + gi);
      if (e1) e1.textContent = fmt(a.duration);
      if (e2) e2.textContent = fmt(a.duration);
    });
  });
}

document.getElementById('libSearch')?.addEventListener('input', e => { libQ = e.target.value; renderLibrary(); });

// ── LIKED SONGS VIEW ──
function renderLiked() {
  const el = document.getElementById('likedRows');
  if (!el) return;
  const liked = tracks.filter(t => favs.has(t.name));
  document.getElementById('likedBadge').textContent = liked.length + ' tracks';
  if (!liked.length) {
    el.innerHTML = `<div class="empty"><div class="ico">♡</div><p>No liked tracks yet.<br>Tap the heart on any track while playing.</p></div>`;
    return;
  }
  el.innerHTML = liked.map((t, i) => {
    const gi = tracks.indexOf(t);
    const isNow = nowTrack && nowTrack.file === t.file;
    const dur = durations[t.file] ? fmt(durations[t.file]) : '—';
    const isCached = cachedFiles.has(t.file);
    return `<div class="track-row${isNow ? ' playing' : ''}" onclick="playLib(${gi})" oncontextmenu="openCtx(event,${gi})">
      <div class="trk-idx"><span class="num">${i + 1}</span>
        <div class="eq-wrap"><div class="eq-bar${playing ? '' : ' p'}" style="height:60%"></div><div class="eq-bar${playing ? '' : ' p'}" style="height:100%"></div><div class="eq-bar${playing ? '' : ' p'}" style="height:45%"></div></div>
      </div>
      <div class="trk-info"><div class="trk-name">${t.title}</div><div class="trk-meta">${t.name.replace(/\.ganuman$/i, '')}</div></div>
      <div class="trk-dur">${dur}</div>
      <button class="dl-btn ${isCached ? 'cached' : 'uncached'}" title="${isCached ? 'Downloaded' : 'Download'}" onclick="event.stopPropagation();dlTrack(${gi})">
        ${isCached
          ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`
          : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`}
      </button>
      <button class="trk-btn" title="Unlike" onclick="event.stopPropagation();toggleHeart('${t.name}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" style="color:#ff4d6d"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
      </button>
    </div>`;
  }).join('');
}

// ── PLAYLISTS ──
function renderSidebar() {
  const el = document.getElementById('plList');
  if (!playlists.length) {
    el.innerHTML = `<div style="padding:8px 10px;font-size:.75rem;color:var(--text3)">No playlists yet</div>`;
    return;
  }
  el.innerHTML = playlists.map(pl =>
    `<div class="pl-item${pl.id === activePl ? ' active' : ''}" onclick="openPl('${pl.id}')">
      <div class="pl-dot">${pl.emoji || '📚'}</div>
      <div class="pl-name">${pl.name}</div>
      <span class="pl-count">${pl.tracks.length}</span>
      <button class="pl-del" title="Delete" onclick="event.stopPropagation();deletePl('${pl.id}')">✕</button>
    </div>`
  ).join('');
}

function openPl(id) {
  activePl = id;
  const pl = playlists.find(p => p.id === id);
  if (!pl) return;
  document.getElementById('plCover').textContent = pl.emoji || '📚';
  document.getElementById('plName').textContent = pl.name;
  renderPlTracks();
  gotoView('playlist');
  renderSidebar();
}

function renderPlTracks() {
  const pl = playlists.find(p => p.id === activePl);
  const el = document.getElementById('plRows');
  if (!pl) return;
  document.getElementById('plMeta').textContent = pl.tracks.length + ' tracks';
  if (!pl.tracks.length) {
    el.innerHTML = `<div class="empty"><div class="ico">🎵</div><p>Playlist is empty.<br>Right-click any track in Library → Add to playlist.</p></div>`;
    return;
  }
  el.innerHTML = pl.tracks.map((fn, i) => {
    const gi = tracks.findIndex(t => t.name === fn);
    const t = gi >= 0 ? tracks[gi] : { title: fn, name: fn, file: 'Database/' + fn };
    const isNow = nowTrack && nowTrack.name === fn;
    const dur = durations[t.file] ? fmt(durations[t.file]) : '—';
    const isCached = cachedFiles.has(t.file);
    return `<div class="track-row pl-row${isNow ? ' playing' : ''}" data-pi="${i}" draggable="true"
        ondragstart="dStart(event,${i})" ondragover="dOver(event,${i})" ondrop="dDrop(event,${i})" ondragend="dEnd()"
        onclick="playPlAt(${i})">
      <div class="drag-handle"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="18" x2="16" y2="18"/></svg></div>
      <div class="trk-idx"><span class="num">${i + 1}</span>
        <div class="eq-wrap"><div class="eq-bar${playing ? '' : ' p'}" style="height:60%"></div><div class="eq-bar${playing ? '' : ' p'}" style="height:100%"></div><div class="eq-bar${playing ? '' : ' p'}" style="height:45%"></div></div>
      </div>
      <div class="trk-info"><div class="trk-name">${t.title}</div><div class="trk-meta">${fn.replace(/\.ganuman$/i, '')}</div></div>
      <div class="trk-dur" id="pd-${gi >= 0 ? gi : 'x' + i}">${dur}</div>
      <button class="dl-btn ${isCached ? 'cached' : 'uncached'}" onclick="event.stopPropagation();dlTrackByFile('${t.file}')">
        ${isCached
          ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`
          : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`}
      </button>
      <button class="trk-btn" title="Remove" onclick="event.stopPropagation();rmFromPl('${activePl}','${fn}')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
  }).join('');
  prefetch(pl.tracks.map(n => tracks.find(t => t.name === n)).filter(Boolean));
}

function playPlAt(pi) {
  const pl = playlists.find(p => p.id === activePl);
  if (!pl) return;
  const idxs = pl.tracks.map(n => tracks.findIndex(t => t.name === n)).filter(i => i >= 0);
  if (idxs[pi] === undefined) return;
  queue = idxs; qPos = pi; start(queue[qPos]);
}

async function addToPl(plId, fname) {
  const pl = playlists.find(p => p.id === plId);
  if (!pl) return;
  if (pl.tracks.includes(fname)) { toast('Already in playlist'); return; }
  pl.tracks.push(fname);
  try {
    await dbAddTrackToPlaylist(plId, fname, pl.tracks.length - 1);
    toast(`✅ Added to "${pl.name}"`);
    renderSidebar();
    if (activePl === plId) renderPlTracks();
  } catch { toast('❌ Could not save'); pl.tracks.pop(); }
}

async function rmFromPl(plId, fname) {
  const pl = playlists.find(p => p.id === plId);
  if (!pl) return;
  pl.tracks = pl.tracks.filter(f => f !== fname);
  try {
    await dbRemoveTrackFromPlaylist(plId, fname);
    renderPlTracks(); renderSidebar();
  } catch { toast('❌ Could not remove'); }
}

async function deletePl(id) {
  if (!confirm('Delete this playlist?')) return;
  playlists = playlists.filter(p => p.id !== id);
  if (activePl === id) { activePl = null; gotoView('library'); }
  try {
    await dbDeletePlaylist(id);
    renderSidebar();
  } catch { toast('❌ Delete failed'); }
}

function playPlaylist() {
  const pl = playlists.find(p => p.id === activePl);
  if (!pl || !pl.tracks.length) { toast('Playlist is empty'); return; }
  const idxs = pl.tracks.map(n => tracks.findIndex(t => t.name === n)).filter(i => i >= 0);
  if (!idxs.length) { toast('⚠️ Tracks not found in library'); return; }
  queue = idxs; qPos = 0;
  if (shuffle) shuffleQ(idxs[0]);
  start(queue[0]);
}

async function editPlName() {
  const el = document.getElementById('plName');
  const editing = el.contentEditable === 'true';
  if (editing) {
    el.contentEditable = 'false';
    const pl = playlists.find(p => p.id === activePl);
    if (pl) {
      pl.name = el.textContent.trim() || pl.name;
      try { await dbUpdatePlaylist(activePl, { name: pl.name }); renderSidebar(); }
      catch { toast('❌ Could not rename'); }
    }
  } else {
    el.contentEditable = 'true'; el.focus();
    const r = document.createRange(); r.selectNodeContents(el);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
  }
}

// ── NEW PLAYLIST MODAL ──
let selEmoji = '📚';
const EMOJIS = ['📚','📖','🎓','🧬','⚗️','⚡','🔬','🧠','📐','🌍','💡','🎯','🏆','📝','🔭','🧪','🌱','🎵'];
function initEmojiGrid() {
  const el = document.getElementById('emojiGrid');
  if (!el) return;
  el.innerHTML = EMOJIS.map(e => `<button class="em-opt${e === selEmoji ? ' on' : ''}" onclick="pickEmoji('${e}')">${e}</button>`).join('');
}
function pickEmoji(e) {
  selEmoji = e;
  document.querySelectorAll('.em-opt').forEach(b => b.classList.toggle('on', b.textContent === e));
}
function openNewPl() {
  document.getElementById('newPlName').value = '';
  document.getElementById('newPlOverlay').classList.add('open');
}
document.getElementById('cancelPl')?.addEventListener('click', () => document.getElementById('newPlOverlay').classList.remove('open'));
document.getElementById('doCreatePl')?.addEventListener('click', async () => {
  const n = document.getElementById('newPlName').value.trim();
  if (!n) { toast('Enter a name'); return; }
  try {
    const pl = await dbCreatePlaylist(currentUser.id, n, selEmoji);
    const newPl = { id: pl.id, name: pl.name, emoji: pl.emoji || selEmoji, tracks: [] };
    playlists.push(newPl);
    document.getElementById('newPlOverlay').classList.remove('open');
    openPl(pl.id);
    toast(`✨ "${n}" created`);
  } catch { toast('❌ Could not create playlist'); }
});

// ── DRAG & DROP ──
function dStart(e, i) { dragSrc = i; e.currentTarget.classList.add('dragging'); }
function dOver(e, i) { e.preventDefault(); document.querySelectorAll('.pl-row')[i]?.classList.add('drag-over'); }
async function dDrop(e, i) {
  e.preventDefault();
  if (dragSrc === null || dragSrc === i) return;
  const pl = playlists.find(p => p.id === activePl);
  if (!pl) return;
  const a = [...pl.tracks];
  const [m] = a.splice(dragSrc, 1); a.splice(i, 0, m);
  pl.tracks = a;
  try { await dbReorderPlaylistTracks(activePl, a); renderPlTracks(); }
  catch { toast('❌ Reorder failed'); }
}
function dEnd() {
  dragSrc = null;
  document.querySelectorAll('.pl-row').forEach(r => r.classList.remove('dragging', 'drag-over'));
}

// ── CONTEXT MENU ──
const ctxMenu = document.getElementById('ctxMenu');
function openCtx(e, gi) { e.preventDefault(); ctxTrk = tracks[gi]; buildCtxPls(); posCtx(e.clientX, e.clientY); }
function openCtxBtn(e, gi) { ctxTrk = tracks[gi]; buildCtxPls(); const r = e.currentTarget.getBoundingClientRect(); posCtx(r.right, r.bottom); }
function posCtx(x, y) { ctxMenu.classList.add('open'); ctxMenu.style.left = Math.min(x, window.innerWidth - 200) + 'px'; ctxMenu.style.top = Math.min(y, window.innerHeight - 180) + 'px'; }
function buildCtxPls() {
  const el = document.getElementById('ctxPls');
  el.innerHTML = playlists.length
    ? playlists.map(pl => `<div class="ctx-item" onclick="addToPl('${pl.id}','${ctxTrk?.name}');ctxMenu.classList.remove('open')">${pl.emoji} Add to "${pl.name}"</div>`).join('')
    : `<div class="ctx-item" style="opacity:.5">No playlists — create one first</div>`;
}
document.addEventListener('click', () => ctxMenu.classList.remove('open'));
document.getElementById('ctxPlay')?.addEventListener('click', () => { if (ctxTrk) playLib(tracks.indexOf(ctxTrk)); });
document.getElementById('ctxNext')?.addEventListener('click', () => {
  if (!ctxTrk) return;
  const i = tracks.indexOf(ctxTrk);
  if (qPos >= 0) queue.splice(qPos + 1, 0, i); else { queue = [i]; qPos = 0; }
  toast('Playing next: ' + ctxTrk.title);
});

// ── SLEEP TIMER ──
function openSleepModal() {
  selMin = null;
  document.querySelectorAll('.timer-opt').forEach(b => b.classList.remove('on'));
  document.getElementById('customMin').value = '';
  document.getElementById('sleepOverlay').classList.add('open');
}
document.querySelectorAll('.timer-opt').forEach(b => {
  b.onclick = () => {
    selMin = parseInt(b.dataset.m);
    document.querySelectorAll('.timer-opt').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    document.getElementById('customMin').value = '';
  };
});
document.getElementById('customMin')?.addEventListener('input', e => {
  selMin = parseInt(e.target.value) || null;
  document.querySelectorAll('.timer-opt').forEach(b => b.classList.remove('on'));
});
document.getElementById('startSleep')?.addEventListener('click', () => {
  if (!selMin) { toast('Pick a duration'); return; }
  document.getElementById('sleepOverlay').classList.remove('open');
  startSleep(selMin * 60);
});
document.getElementById('stopSleep')?.addEventListener('click', () => { clearSleep(); document.getElementById('sleepOverlay').classList.remove('open'); toast('Sleep timer stopped'); });
document.getElementById('closeSleep')?.addEventListener('click', () => document.getElementById('sleepOverlay').classList.remove('open'));
function startSleep(secs) {
  clearSleep(); sleepSecs = secs;
  const badge = document.getElementById('sleepBadge'); badge.classList.add('show');
  updateSleepBadge();
  const baseVol = audio.volume;
  sleepTick = setInterval(() => {
    sleepSecs--;
    updateSleepBadge();
    if (sleepSecs <= 30) audio.volume = Math.max(0, (sleepSecs / 30) * baseVol);
    if (sleepSecs <= 0) { audio.pause(); setPlay(false); clearSleep(); toast('😴 Sleep timer ended'); }
  }, 1000);
  toast(`😴 Sleep timer: ${Math.floor(secs / 60)} min`);
}
function clearSleep() { clearInterval(sleepTick); sleepSecs = 0; document.getElementById('sleepBadge').classList.remove('show'); audio.volume = parseFloat(volBar.value); }
function updateSleepBadge() { document.getElementById('sleepCount').textContent = fmt(sleepSecs); }

// ── CACHE / DOWNLOAD ──
async function refreshCachedFiles() {
  cachedFiles.clear();
  try {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    keys.forEach(r => cachedFiles.add(new URL(r.url).pathname.replace(/^\//, '')));
  } catch {}
}

async function getCachedUrl(url) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const match = await cache.match(url);
    if (match) { const blob = await match.blob(); return URL.createObjectURL(blob); }
  } catch {}
  return null;
}

async function fetchFullBuffer(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = await resp.arrayBuffer();
      if (buf.byteLength === 0) throw new Error('Empty');
      return { buf, ct: resp.headers.get('Content-Type') || 'application/octet-stream' };
    } catch (e) { lastErr = e; if (i < tries - 1) await new Promise(r => setTimeout(r, i * 800)); }
  }
  throw lastErr;
}

async function cacheUrl(url) {
  try {
    const cache = await caches.open(CACHE_NAME);
    if (await cache.match(url)) return true;
    const { buf, ct } = await fetchFullBuffer(url);
    await cache.put(url, new Response(buf, { status: 200, headers: { 'Content-Type': ct, 'Content-Length': String(buf.byteLength) } }));
    return true;
  } catch { return false; }
}

async function dlTrack(gi) {
  const t = tracks[gi]; if (!t) return;
  const btn = document.getElementById('dlb-' + gi);
  if (btn) { btn.className = 'dl-btn downloading'; btn.title = 'Downloading…'; }
  const ok = await cacheUrl(t.file);
  if (ok) { cachedFiles.add(t.file); toast(`✅ "${t.title}" saved offline`); }
  else toast('❌ Download failed');
  renderLibrary(); if (activePl) renderPlTracks(); updateCacheStatus(); updateDlAllBtn();
}

async function dlTrackByFile(filePath) {
  const gi = tracks.findIndex(t => t.file === filePath);
  if (gi >= 0) { await dlTrack(gi); return; }
  const ok = await cacheUrl(filePath);
  if (ok) { cachedFiles.add(filePath); toast('✅ Saved offline'); }
  else toast('❌ Download failed');
  if (activePl) renderPlTracks(); updateCacheStatus(); updateDlAllBtn();
}

async function downloadAllLibrary() {
  if (_dlAllRunning) return;
  if (!tracks.length) { toast('No tracks yet'); return; }
  const pending = tracks.filter(t => !cachedFiles.has(t.file));
  if (!pending.length) { toast('✅ All tracks already downloaded!'); return; }
  _dlAllRunning = true;
  const btn = document.getElementById('dlAllLibBtn');
  btn?.classList.add('busy');
  let done = 0, failed = 0;
  for (const t of pending) {
    const ok = await cacheUrl(t.file);
    if (ok) { cachedFiles.add(t.file); done++; } else failed++;
    if (btn) btn.textContent = `⬇ ${done} / ${pending.length}`;
  }
  _dlAllRunning = false;
  btn?.classList.remove('busy');
  if (failed === 0) { btn?.classList.add('done'); toast(`✅ All ${done} tracks saved!`); }
  else toast(`⚠️ ${done} ok · ${failed} failed`);
  renderLibrary(); updateCacheStatus(); updateDlAllBtn();
}

async function downloadPlaylist() {
  const pl = playlists.find(p => p.id === activePl);
  if (!pl || !pl.tracks.length) { toast('Playlist is empty'); return; }
  toast(`⬇️ Downloading ${pl.tracks.length} tracks…`);
  let done = 0;
  for (const fn of pl.tracks) {
    const t = tracks.find(t => t.name === fn) || { file: 'Database/' + fn };
    const ok = await cacheUrl(t.file);
    if (ok) cachedFiles.add(t.file);
    done++;
  }
  toast(`✅ ${done} tracks saved offline`);
  renderPlTracks(); updateCacheStatus(); updateDlAllBtn();
}

function updateDlAllBtn() {
  const btn = document.getElementById('dlAllLibBtn');
  if (!btn || _dlAllRunning) return;
  const allDone = tracks.length > 0 && tracks.every(t => cachedFiles.has(t.file));
  btn.classList.toggle('done', allDone);
  btn.classList.remove('busy');
  btn.innerHTML = allDone
    ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> All Downloaded`
    : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download All`;
}

async function updateCacheStatus() {
  const dot = document.getElementById('cacheDot'), msg = document.getElementById('cacheMsg');
  if (!dot || !msg) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    if (!keys.length) { dot.className = 'sdot'; msg.textContent = 'No tracks downloaded yet.'; return; }
    let bytes = 0;
    for (const req of keys) { const resp = await cache.match(req); if (resp) bytes += (await resp.arrayBuffer()).byteLength; }
    dot.className = 'sdot ok';
    msg.textContent = `${keys.length} track${keys.length !== 1 ? 's' : ''} · ${(bytes / 1024 / 1024).toFixed(1)} MB`;
  } catch { dot.className = 'sdot err'; msg.textContent = 'Cache not available'; }
}

async function clearAudioCache() {
  if (!confirm('Delete all downloaded tracks?')) return;
  try {
    await caches.delete(CACHE_NAME);
    cachedFiles.clear();
    toast('🗑️ All downloads cleared');
    renderLibrary(); if (activePl) renderPlTracks();
    updateCacheStatus(); updateDlAllBtn();
  } catch { toast('❌ Could not clear'); }
}

document.querySelectorAll('[data-v="settings"]').forEach(btn => btn.addEventListener('click', () => setTimeout(updateCacheStatus, 100)));

// ── ENCRYPTION ──
const _GM_MAGIC = new Uint8Array([0x47, 0x41, 0x4E, 0x55, 0x4D, 0x41, 0x4E, 0x21]);

async function _gmKey(salt, pass) {
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' }, raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function _gmDecrypt(arrayBuffer, pass) {
  const d = new Uint8Array(arrayBuffer);
  for (let i = 0; i < _GM_MAGIC.length; i++) { if (d[i] !== _GM_MAGIC[i]) return null; }
  let off = _GM_MAGIC.length;
  const salt = d.slice(off, off + 16); off += 16;
  const iv   = d.slice(off, off + 12); off += 12;
  const cipher = d.slice(off);
  const key = await _gmKey(salt, pass);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return URL.createObjectURL(new Blob([plain], { type: 'audio/mpeg' }));
}

// ── ENCRYPTION PASSWORD — in-memory only ──
// Fetched silently from Supabase on login. Never written to DOM or localStorage.
// Only lives in this JS variable for the duration of the browser session.
let _encPass = '';

function getEncPass() { return _encPass; }

async function _loadEncPass() {
  if (!currentUser) return;
  try {
    const pass = await dbGetEncPassword(currentUser.id);
    if (pass) {
      _encPass = pass;
      _updateEncUI(true);
    } else {
      _encPass = '';
      _updateEncUI(false);
    }
  } catch (e) {
    console.error('Could not load enc password', e);
    _encPass = '';
    _updateEncUI(false);
  }
}

function _updateEncUI(isSet) {
  const savedState = document.getElementById('encSavedState');
  const setupState = document.getElementById('encSetupState');
  if (!savedState || !setupState) return;
  savedState.style.display = isSet ? 'flex' : 'none';
  setupState.style.display = isSet ? 'none' : 'block';
}

window.saveEncPassword = async () => {
  const inp = document.getElementById('encNewPassword');
  const val = inp?.value?.trim();
  if (!val) { toast('Enter a password'); return; }
  if (val.length < 6) { toast('Password must be at least 6 characters'); return; }
  try {
    await dbSaveEncPassword(currentUser.id, val);
    _encPass = val;
    inp.value = '';
    _updateEncUI(true);
    toast('🔐 Encryption password saved');
  } catch { toast('❌ Could not save password'); }
};

window.changeEncPassword = () => {
  _updateEncUI(false);
  document.getElementById('encNewPassword')?.focus();
};

window.removeEncPassword = async () => {
  if (!confirm('Remove saved encryption password? You will need to set it again to play files.')) return;
  try {
    await dbSaveEncPassword(currentUser.id, '');
    _encPass = '';
    _updateEncUI(false);
    toast('🗑️ Password removed');
  } catch { toast('❌ Could not remove'); }
};

window._blobUrls = {};
async function startWithDecrypt(gi) {
  const t = tracks[gi]; if (!t) return;
  unloadAudio();
  if (t.file.toLowerCase().endsWith('.ganuman')) {
    try {
      Object.keys(window._blobUrls).forEach(k => { if (Number(k) !== gi) { URL.revokeObjectURL(window._blobUrls[k]); delete window._blobUrls[k]; } });
      let buf;
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(t.file);
      if (cached) { buf = await cached.clone().arrayBuffer(); }
      else {
        const { buf: fetched, ct } = await fetchFullBuffer(t.file);
        buf = fetched;
        cache.put(t.file, new Response(buf.slice(0), { status: 200, headers: { 'Content-Type': ct, 'Content-Length': String(buf.byteLength) } }));
        cachedFiles.add(t.file);
      }
      const pass = getEncPass();
      if (!pass) { toast('⚠️ Enter encryption password in Settings'); return; }
      const burl = await _gmDecrypt(buf, pass);
      if (!burl) { toast('❌ Wrong password or invalid file'); return; }
      window._blobUrls[gi] = burl;
      nowTrack = t;
      document.getElementById('nowArt').textContent = '🎓';
      document.getElementById('nowTitle').textContent = t.title;
      document.getElementById('nowSub').textContent = t.name.replace(/\.ganuman$/i, '');
      updateMS(t); renderLibrary(); if (activePl) renderPlTracks(); updateHeart();
      _playSrc(burl); return;
    } catch (e) { console.error(e); toast('❌ Could not decrypt file'); return; }
  }
  (async () => {
    const t2 = tracks[gi]; if (!t2) return;
    nowTrack = t2;
    let src = t2.file;
    const cachedSrc = await getCachedUrl(t2.file);
    if (cachedSrc) { src = cachedSrc; }
    else { cacheUrl(t2.file).then(ok => { if (ok) { cachedFiles.add(t2.file); renderLibrary(); if (activePl) renderPlTracks(); updateDlAllBtn(); } }); }
    document.getElementById('nowArt').textContent = '🎓';
    document.getElementById('nowTitle').textContent = t2.title;
    document.getElementById('nowSub').textContent = t2.name.replace(/\.ganuman$/i, '');
    updateMS(t2); renderLibrary(); if (activePl) renderPlTracks(); updateHeart();
    _playSrc(src);
  })();
}
window.start = startWithDecrypt;
function playLib(gi) { queue = tracks.map((_, i) => i); qPos = gi; if (shuffle) shuffleQ(gi); startWithDecrypt(gi); }

// ── PLAYBACK ──
function unloadAudio() { audio.pause(); audio.src = ''; audio.load(); }
function _playSrc(src) {
  audio.src = src; audio.playbackRate = speeds[spIdx]; audio.load();
  audio.play().then(() => setPlay(true)).catch(() => { toast('⚠️ Cannot play — check path or password'); setPlay(false); });
}
function start(gi) { startWithDecrypt(gi); }
function togglePlay() { if (!nowTrack && tracks.length) { playLib(0); return; } if (audio.paused) { audio.play(); setPlay(true); } else { audio.pause(); setPlay(false); } }
function setPlay(p) {
  playing = p;
  document.getElementById('iPlay').style.display  = p ? 'none' : 'inline';
  document.getElementById('iPause').style.display = p ? 'inline' : 'none';
  document.getElementById('nowArt').classList.toggle('spin', p);
  document.querySelectorAll('.eq-bar').forEach(b => b.classList.toggle('p', !p));
}
function prevTrack() { if (qPos < 0) return; if (audio.currentTime > 3) { audio.currentTime = 0; return; } qPos = (qPos - 1 + queue.length) % queue.length; start(queue[qPos]); }
function nextTrack() {
  if (repeat === 2) { audio.currentTime = 0; audio.play(); return; }
  if (qPos < 0) return;
  let n = qPos + 1;
  if (n >= queue.length) { if (repeat === 1) n = 0; else { setPlay(false); return; } }
  qPos = n; start(queue[qPos]);
}
function shuffleQ(pivot) {
  for (let i = queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [queue[i], queue[j]] = [queue[j], queue[i]]; }
  if (pivot !== undefined) { const p = queue.indexOf(pivot); if (p >= 0) { [queue[0], queue[p]] = [queue[p], queue[0]]; qPos = 0; } }
}
function toggleShuffle() { shuffle = !shuffle; document.getElementById('btnShuffle').classList.toggle('on', shuffle); toast(shuffle ? '🔀 Shuffle on' : 'Shuffle off'); savePrefs(); }
function cycleRepeat() {
  repeat = (repeat + 1) % 3;
  const btn = document.getElementById('btnRepeat');
  const one = document.getElementById('repeatOne');
  btn.classList.toggle('on', repeat > 0);
  if (one) one.style.display = repeat === 2 ? 'inline' : 'none';
  btn.title = ['No Repeat', 'Repeat All', 'Repeat Once'][repeat];
  toast(['Repeat off', '🔁 Repeat all', '🔂 Repeat once'][repeat]);
  savePrefs();
}
function applyRepeatUI() {
  const btn = document.getElementById('btnRepeat');
  const one = document.getElementById('repeatOne');
  if (btn) btn.classList.toggle('on', repeat > 0);
  if (one) one.style.display = repeat === 2 ? 'inline' : 'none';
}
function changeSpeed(dir) {
  spIdx = Math.max(0, Math.min(speeds.length - 1, spIdx + dir));
  audio.playbackRate = speeds[spIdx];
  document.getElementById('speedPill').textContent = speeds[spIdx] + '×';
  document.getElementById('speedSlower').style.opacity = spIdx === 0 ? '0.3' : '1';
  document.getElementById('speedFaster').style.opacity = spIdx === speeds.length - 1 ? '0.3' : '1';
  savePrefs(); toast('Speed: ' + speeds[spIdx] + '×');
}
function toggleMute() {
  muted = !muted; audio.muted = muted;
  document.getElementById('iVol').style.display  = muted ? 'none' : 'inline';
  document.getElementById('iMute').style.display = muted ? 'inline' : 'none';
}
async function toggleHeart(nameOverride) {
  const name = nameOverride || nowTrack?.name;
  if (!name || !currentUser) return;
  if (favs.has(name)) {
    favs.delete(name);
    try { await dbRemoveFavourite(currentUser.id, name); } catch {}
  } else {
    favs.add(name);
    try { await dbAddFavourite(currentUser.id, name); } catch {}
  }
  updateHeart();
  const likedView = document.getElementById('view-liked');
  if (likedView?.classList.contains('active')) renderLiked();
}
function updateHeart() {
  const liked = nowTrack && favs.has(nowTrack.name);
  const btn = document.getElementById('heartBtn');
  if (!btn) return;
  btn.classList.toggle('on', liked);
  btn.querySelector('svg').setAttribute('fill', liked ? 'currentColor' : 'none');
}

async function savePrefs() {
  if (!currentUser) return;
  try {
    await dbSavePreferences(currentUser.id, {
      volume: audio.volume,
      speed_index: spIdx,
      shuffle, repeat
    });
  } catch {}
}

audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  const p = (audio.currentTime / audio.duration) * 100;
  prog.value = p; setRangeStyle(prog, p);
  document.getElementById('elapsed').textContent = fmt(audio.currentTime);
  if ('mediaSession' in navigator && !isNaN(audio.duration)) {
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: audio.currentTime }); } catch {}
  }
});
audio.addEventListener('loadedmetadata', () => {
  document.getElementById('durEl').textContent = fmt(audio.duration);
  if (nowTrack) durations[nowTrack.file] = audio.duration;
});
audio.addEventListener('ended', nextTrack);
audio.addEventListener('play',  () => setPlay(true));
audio.addEventListener('pause', () => setPlay(false));
prog.addEventListener('input', () => { if (audio.duration) audio.currentTime = (prog.value / 100) * audio.duration; });
volBar.addEventListener('input', e => {
  audio.volume = e.target.value;
  setRangeStyle(e.target, e.target.value * 100);
  savePrefs();
});
document.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA', '[contenteditable]'].includes(e.target.tagName) || e.target.contentEditable === 'true') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.code === 'ArrowRight') audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10);
  if (e.code === 'ArrowLeft')  audio.currentTime = Math.max(0, audio.currentTime - 10);
});

function updateMS(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: 'MusicPro', album: 'Lecture Library', artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }] });
  navigator.mediaSession.setActionHandler('play',          () => { audio.play(); setPlay(true); });
  navigator.mediaSession.setActionHandler('pause',         () => { audio.pause(); setPlay(false); });
  navigator.mediaSession.setActionHandler('previoustrack', prevTrack);
  navigator.mediaSession.setActionHandler('nexttrack',     nextTrack);
  navigator.mediaSession.setActionHandler('seekbackward',  () => audio.currentTime = Math.max(0, audio.currentTime - 10));
  navigator.mediaSession.setActionHandler('seekforward',   () => audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10));
}

// ── VIEWS ──
function gotoView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('view-' + name)?.classList.add('active');
  document.querySelector(`[data-v="${name}"]`)?.classList.add('active');
  if (name === 'liked') renderLiked();
  if (name === 'settings') setTimeout(updateCacheStatus, 100);
}

// ── UTILS ──
function fmt(s) { if (!s || isNaN(s)) return '0:00'; return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }
function setRangeStyle(el, pct) { el.style.background = `linear-gradient(to right,var(--accent) ${pct}%,var(--border) ${pct}%)`; }
let toastTmr;
function toast(msg) {
  const el = document.getElementById('toastEl');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTmr); toastTmr = setTimeout(() => el.classList.remove('show'), 2400);
}

// PWA service worker registration
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

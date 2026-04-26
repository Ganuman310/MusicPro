// ── SUPABASE CONFIG ──
// Replace these with your actual Supabase project values
const SUPABASE_URL = 'https://dbkmfkfomfkjqojykmph.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRia21ma2ZvbWZranFvanlrbXBoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxODQ3ODMsImV4cCI6MjA5Mjc2MDc4M30.J3BudQ7X-mUdjGsKEdXzs9y4F75NwONjJ3mzFm92N5A';

// Initialize Supabase client (loaded via CDN in HTML)
const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,        // keeps user logged in across browser restarts
    autoRefreshToken: true,      // silently refreshes token before expiry
    detectSessionInUrl: true,    // handles OAuth redirect automatically
    flowType: 'pkce'             // uses code flow — no tokens exposed in URL hash
  }
});

// ── AUTH HELPERS ──

async function signInWithGoogle() {
  const { error } = await _supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + window.location.pathname.replace(//[^/]*$/, '/index.html')
    }
  });
  if (error) throw error;
}

async function signInWithEmail(email, password) {
  const { data, error } = await _supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function signUpWithEmail(email, password, fullName) {
  const { data, error } = await _supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } }
  });
  if (error) throw error;
  return data;
}

async function signOut() {
  const { error } = await _supabase.auth.signOut();
  if (error) throw error;
}

async function getSession() {
  const { data } = await _supabase.auth.getSession();
  return data.session;
}

async function getUser() {
  const { data } = await _supabase.auth.getUser();
  return data.user;
}

// ── PLAYLIST DB HELPERS ──

async function dbGetPlaylists(userId) {
  const { data, error } = await _supabase
    .from('playlists')
    .select('*, playlist_tracks(*)')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function dbCreatePlaylist(userId, name, emoji) {
  const { data, error } = await _supabase
    .from('playlists')
    .insert({ user_id: userId, name, emoji })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function dbUpdatePlaylist(id, updates) {
  const { error } = await _supabase
    .from('playlists')
    .update(updates)
    .eq('id', id);
  if (error) throw error;
}

async function dbDeletePlaylist(id) {
  const { error } = await _supabase
    .from('playlists')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

async function dbAddTrackToPlaylist(playlistId, filename, position) {
  const { error } = await _supabase
    .from('playlist_tracks')
    .insert({ playlist_id: playlistId, filename, position });
  if (error) throw error;
}

async function dbRemoveTrackFromPlaylist(playlistId, filename) {
  const { error } = await _supabase
    .from('playlist_tracks')
    .delete()
    .eq('playlist_id', playlistId)
    .eq('filename', filename);
  if (error) throw error;
}

async function dbReorderPlaylistTracks(playlistId, filenames) {
  // Delete all then re-insert with new positions
  await _supabase.from('playlist_tracks').delete().eq('playlist_id', playlistId);
  const rows = filenames.map((fn, i) => ({ playlist_id: playlistId, filename: fn, position: i }));
  const { error } = await _supabase.from('playlist_tracks').insert(rows);
  if (error) throw error;
}

// ── FAVOURITES DB HELPERS ──

async function dbGetFavourites(userId) {
  const { data, error } = await _supabase
    .from('favourites')
    .select('filename')
    .eq('user_id', userId);
  if (error) throw error;
  return (data || []).map(r => r.filename);
}

async function dbAddFavourite(userId, filename) {
  const { error } = await _supabase
    .from('favourites')
    .upsert({ user_id: userId, filename });
  if (error) throw error;
}

async function dbRemoveFavourite(userId, filename) {
  const { error } = await _supabase
    .from('favourites')
    .delete()
    .eq('user_id', userId)
    .eq('filename', filename);
  if (error) throw error;
}

// ── PREFERENCES DB HELPERS ──

async function dbGetPreferences(userId) {
  const { data } = await _supabase
    .from('preferences')
    .select('*')
    .eq('user_id', userId)
    .single();
  return data;
}

async function dbSavePreferences(userId, prefs) {
  const { error } = await _supabase
    .from('preferences')
    .upsert({ user_id: userId, ...prefs });
  if (error) throw error;
}

// ── ENCRYPTION PASSWORD HELPERS ──
// Password is stored in Supabase preferences table (enc_password column).
// It is fetched once on login into a JS memory variable — never written
// to the DOM, localStorage, or any log. RLS ensures only the owner can read it.

async function dbGetEncPassword(userId) {
  const { data, error } = await _supabase
    .from('preferences')
    .select('enc_password')
    .eq('user_id', userId)
    .single();
  if (error) return null;
  return data?.enc_password || null;
}

async function dbSaveEncPassword(userId, password) {
  const { error } = await _supabase
    .from('preferences')
    .upsert({ user_id: userId, enc_password: password });
  if (error) throw error;
}

// ── GITHUB LIBRARY HELPERS ──

async function scanGitHubDatabase(user, repo, token = '') {
  const headers = { Accept: 'application/vnd.github.v3+json' };
  if (token) headers.Authorization = 'token ' + token;
  const r = await fetch(`https://api.github.com/repos/${user}/${repo}/contents/Database`, { headers });
  if (!r.ok) throw new Error(r.status === 404 ? 'Database folder not found' : 'GitHub API error ' + r.status);
  const items = await r.json();
  return items
    .filter(f => f.type === 'file' && /\.ganuman$/i.test(f.name))
    .map(f => f.name);
}

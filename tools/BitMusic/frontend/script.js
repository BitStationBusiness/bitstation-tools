'use strict';

const STEMS = ['drums','bass','other','vocals'];
const FFT_SIZE = 1024;
const SMOOTH = 0.3;
const PEAK_TH = 0.6;
const PEAK_DK = 0.95;

// ═══ State ════════════════════════════════════════════════════
let ctx = null, masterGain = null;
const gains = {}, analysers = {}, sources = {}, analyserData = {};
let buffers = {};
const stemSt = {};
STEMS.forEach(s => { gains[s]=null; analysers[s]=null; sources[s]=null; analyserData[s]=null;
  stemSt[s]={rms:0,low:0,mid:0,high:0,peakDecay:0,peakValue:0,lowEnd:0,midEnd:0}; });

let library = [];
let curAlbumIdx = -1;
let curTrackIdx = 0;
let playlist = [], plPos = 0;
let isPlaying = false, startOff = 0, startT = 0, dur = 0, animId = null;
let preloadBufs = null, preloadKey = null;
let shuffleOn = false, repeatMode = 'none';
let lyrics = [], lastLyIdx = -2;
let vol = 0.7;
let activeTab = 'biblioteca';
let albumDetailIdx = -1;
let karaokeOn = false;
let karaokeInline = false;

let favorites = {};
let playCounts = {};
let songsFilter = 'all';
let savedDirPath = '';

// WebGL — overlay
let gl=null, prog=null, qBuf=null, pLoc=-1;
const uL={};
let vizT0=0;
// WebGL — inline
let glI=null, progI=null, qBufI=null, pLocI=-1;
const uLI={};

const $=id=>document.getElementById(id);

// ═══ IndexedDB ════════════════════════════════════════════════
function openDB(){return new Promise((r,j)=>{const q=indexedDB.open('BitMusicDB',2);q.onupgradeneeded=e=>{const db=e.target.result;if(!db.objectStoreNames.contains('kv'))db.createObjectStore('kv')};q.onsuccess=e=>r(e.target.result);q.onerror=e=>j(e.target.error)})}
async function dbPut(k,v){try{const d=await openDB();return new Promise((r,j)=>{const t=d.transaction('kv','readwrite');t.objectStore('kv').put(v,k);t.oncomplete=r;t.onerror=e=>j(e.target.error)})}catch(e){}}
async function dbGet(k){try{const d=await openDB();return new Promise((r,j)=>{const q=d.transaction('kv').objectStore('kv').get(k);q.onsuccess=e=>r(e.target.result);q.onerror=e=>j(e.target.error)})}catch(e){return null}}

async function loadPersistedData(){
  try{
    const dir=await dbGet('bm-dir-path');
    if(dir) savedDirPath=dir;
    const favs=await dbGet('bm-favorites');
    if(favs) favorites=favs;
    const counts=await dbGet('bm-play-counts');
    if(counts) playCounts=counts;
  }catch(e){}
}
function saveFavorites(){dbPut('bm-favorites',favorites).catch(()=>{})}
function savePlayCounts(){dbPut('bm-play-counts',playCounts).catch(()=>{})}
function saveDirPath(){dbPut('bm-dir-path',savedDirPath).catch(()=>{})}

function trackKey(ai,ti){return `${library[ai]?.fileName||ai}::${ti}`}

// ═══ Audio Engine ═════════════════════════════════════════════
async function initAudio(){
  if(!ctx){
    ctx=new(window.AudioContext||window.webkitAudioContext)();
    masterGain=ctx.createGain(); masterGain.connect(ctx.destination); masterGain.gain.value=vol;
    const bs=ctx.sampleRate/FFT_SIZE, le=Math.floor(250/bs), me=Math.floor(2000/bs);
    STEMS.forEach(s=>{
      gains[s]=ctx.createGain(); gains[s].gain.value=parseFloat($(`vol-${s}`)?.value??0.8); gains[s].connect(masterGain);
      analysers[s]=ctx.createAnalyser(); analysers[s].fftSize=FFT_SIZE; analysers[s].smoothingTimeConstant=0.4;
      analyserData[s]=new Uint8Array(analysers[s].frequencyBinCount);
      stemSt[s].lowEnd=le; stemSt[s].midEnd=me;
    });
  }
  if(ctx.state==='suspended') await ctx.resume();
}

function getFeatures(s){
  const a=analysers[s],d=analyserData[s],st=stemSt[s];
  if(!a||!d) return{rms:0,low:0,mid:0,high:0,peak:false,peakValue:0};
  a.getByteFrequencyData(d);
  let sum=0,ls=0,ms=0,hs=0,lc=0,mc=0,hc=0;
  for(let i=0;i<d.length;i++){const v=d[i]/255;sum+=v*v;if(i<st.lowEnd){ls+=v;lc++}else if(i<st.midEnd){ms+=v;mc++}else{hs+=v;hc++}}
  const rms=Math.sqrt(sum/d.length),low=lc?ls/lc:0,mid=mc?ms/mc:0,high=hc?hs/hc:0;
  st.rms=st.rms*(1-SMOOTH)+rms*SMOOTH; st.low=st.low*(1-SMOOTH)+low*SMOOTH;
  st.mid=st.mid*(1-SMOOTH)+mid*SMOOTH; st.high=st.high*(1-SMOOTH)+high*SMOOTH;
  st.peakDecay*=PEAK_DK;
  const pk=rms>st.peakDecay&&rms>PEAK_TH; if(pk){st.peakDecay=rms;st.peakValue=rms}
  return{rms:st.rms,low:st.low,mid:st.mid,high:st.high,peak:pk,peakValue:st.peakValue};
}

// ═══ File Loading ═════════════════════════════════════════════
async function addFiles(){
  const inShell = typeof ToolBridge!=='undefined' && ToolBridge.isShellMode();
  if(inShell){
    try{
      const res = await ToolBridge.pickFiles({extensions:['bm'],multiple:true});
      const paths = res.files || res.paths || [];
      if(!paths.length) return;
      showLoading('Cargando albumes...');
      for(const p of paths){
        try{
          const urlRes = await ToolBridge.getFileUrl(p);
          if(!urlRes?.ok||!urlRes.url) continue;
          const resp = await fetch(urlRes.url);
          const ab = await resp.arrayBuffer();
          const album = await parseBm(ab, p.split(/[/\\]/).pop());
          if(album && !library.some(a=>a.fileName===album.fileName)) library.push(album);
        }catch(e){console.warn('Load error:',p,e)}
      }
      onLibraryChanged();
    }catch(e){if(e.message!=='User cancelled') console.error('pickFiles:',e)}
  } else {
    $('file-input').click();
  }
}

async function pickDirectory(){
  const inShell = typeof ToolBridge!=='undefined' && ToolBridge.isShellMode();
  if(inShell){
    try{
      const res = await ToolBridge.pickFiles({extensions:['bm'],multiple:true,directory:true});
      const paths = res.files || res.paths || [];
      if(!paths.length) return;
      const dir = paths[0].replace(/[/\\][^/\\]+$/,'');
      savedDirPath=dir;
      saveDirPath();
      await loadFromDirectory(paths);
    }catch(e){if(e.message!=='User cancelled') console.error('pickDir:',e)}
  } else {
    $('file-input').click();
  }
}

async function loadFromDirectory(paths){
  if(!paths||!paths.length) return;
  showLoading('Cargando albumes...');
  for(const p of paths){
    try{
      const inShell = typeof ToolBridge!=='undefined' && ToolBridge.isShellMode();
      if(inShell){
        const urlRes = await ToolBridge.getFileUrl(p);
        if(!urlRes?.ok||!urlRes.url) continue;
        const resp = await fetch(urlRes.url);
        const ab = await resp.arrayBuffer();
        const album = await parseBm(ab, p.split(/[/\\]/).pop());
        if(album && !library.some(a=>a.fileName===album.fileName)) library.push(album);
      }
    }catch(e){console.warn('Load error:',p,e)}
  }
  onLibraryChanged();
}

async function reloadSavedDirectory(){
  if(!savedDirPath) return;
  const inShell = typeof ToolBridge!=='undefined' && ToolBridge.isShellMode();
  if(!inShell) return;
  try{
    const res = await ToolBridge.pickFiles({extensions:['bm'],multiple:true,initialDir:savedDirPath,autoSelect:true});
    const paths = res.files || res.paths || [];
    if(paths.length) await loadFromDirectory(paths);
    else renderTab();
  }catch(e){renderTab()}
}

async function handleFileInput(e){
  const files = Array.from(e.target.files).filter(f=>f.name.toLowerCase().endsWith('.bm'));
  if(!files.length) return;
  showLoading('Cargando albumes...');
  for(const f of files){
    try{
      const ab = await f.arrayBuffer();
      const album = await parseBm(ab, f.name);
      if(album && !library.some(a=>a.fileName===album.fileName)) library.push(album);
    }catch(e){console.warn('Parse error:',f.name,e)}
  }
  e.target.value='';
  onLibraryChanged();
}

async function parseBm(arrayBuffer, fileName){
  const zip = await JSZip.loadAsync(arrayBuffer);
  const mf = zip.file('bm.json');
  if(!mf) throw new Error('missing bm.json');
  const meta = JSON.parse(await mf.async('string'));
  let coverUrl = null;
  if(meta.cover){ const cf=zip.file(meta.cover); if(cf) coverUrl=URL.createObjectURL(await cf.async('blob')); }
  return {
    title: meta.title || fileName.replace(/\.bm$/i,''),
    artist: meta.album_artist || meta.artist || 'Artista desconocido',
    year: meta.year||'', genre: meta.genre||'',
    tracks: meta.tracks||[], coverUrl, zipRef: zip, fileName
  };
}

function onLibraryChanged(){
  library.sort((a,b)=>a.title.localeCompare(b.title));
  saveLibraryMeta();
  renderTab();
}

function saveLibraryMeta(){
  try{ localStorage.setItem('bm-lib-names', JSON.stringify(library.map(a=>a.fileName))); }catch(e){}
}

function showLoading(msg){
  $('content').innerHTML=`<div class="loading"><i class="ph ph-spinner spin"></i>${msg||'Cargando...'}</div>`;
}

// ═══ Tab Rendering ════════════════════════════════════════════
function switchTab(tab){
  activeTab=tab;
  albumDetailIdx=-1;
  document.querySelectorAll('.bnav-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===tab));

  const ki=$('karaoke-inline');
  if(tab==='karaoke'){
    $('content').style.display='none';
    ki.style.display='block';
    karaokeInline=true;
    resizeInlineCanvas();
    if(!isPlaying) $('ki-no-track').style.display='flex';
    else $('ki-no-track').style.display='none';
  }else{
    $('content').style.display='';
    ki.style.display='none';
    karaokeInline=false;
    renderTab();
  }
}

function renderTab(){
  const c=$('content');
  switch(activeTab){
    case 'biblioteca': renderBiblioteca(); break;
    case 'albums':
      if(!library.length){renderEmptyLibrary(c);return}
      albumDetailIdx>=0 ? renderAlbumDetail(albumDetailIdx) : renderAlbums();
      break;
    case 'songs':
      if(!library.length){renderEmptyLibrary(c);return}
      renderSongs();
      break;
    case 'download': renderDownload(); break;
    default: renderBiblioteca();
  }
}

function renderEmptyLibrary(c){
  c.innerHTML=`<div class="empty-state"><i class="ph ph-music-notes-plus"></i><p>Agrega archivos <strong>.bm</strong> para comenzar</p><button class="btn-accent" id="btn-add-empty"><i class="ph ph-plus"></i> Agregar albumes</button></div>`;
  $('btn-add-empty')?.addEventListener('click',addFiles);
}

// ─── Biblioteca ──────────────────────────────────────────────
function renderBiblioteca(){
  const c=$('content');
  const totalTracks=library.reduce((s,a)=>s+a.tracks.length,0);
  const dirDisplay=savedDirPath||null;

  let html=`<div class="bib-section">`;
  html+=`<div class="lib-header"><span class="lib-title">Biblioteca</span></div>`;

  html+=`<div class="bib-dir">
    <i class="ph ph-folder-open bib-dir-icon"></i>
    <div class="bib-dir-info">
      <div class="bib-dir-label">Directorio</div>
      <div class="bib-dir-path ${dirDisplay?'':'none'}">${dirDisplay?esc(dirDisplay):'Sin directorio seleccionado'}</div>
    </div>
  </div>`;

  html+=`<div class="bib-actions">
    <button class="btn-accent" id="btn-pick-dir"><i class="ph ph-folder-open"></i> ${savedDirPath?'Cambiar directorio':'Elegir directorio'}</button>
    <button class="btn-accent" id="btn-add-files"><i class="ph ph-plus"></i> Agregar archivos</button>
  </div>`;

  if(library.length){
    html+=`<div class="bib-stats">
      <div class="bib-stat"><div class="bib-stat-val">${library.length}</div><div class="bib-stat-label">Albumes</div></div>
      <div class="bib-stat"><div class="bib-stat-val">${totalTracks}</div><div class="bib-stat-label">Pistas</div></div>
    </div>`;

    html+=`<div class="bib-album-list">`;
    library.forEach((a,i)=>{
      html+=`<div class="bib-album" data-i="${i}">
        <img class="bib-album-art" src="${a.coverUrl||placeholder()}" alt="" loading="lazy">
        <div class="bib-album-info">
          <div class="bib-album-name">${esc(a.title)}</div>
          <div class="bib-album-meta">${esc(a.artist)} · ${a.tracks.length} pistas</div>
        </div>
      </div>`;
    });
    html+=`</div>`;
  }else{
    html+=`<div class="empty-state" style="min-height:30vh"><i class="ph ph-music-notes-plus"></i><p>Selecciona un directorio con archivos <strong>.bm</strong></p></div>`;
  }
  html+=`</div>`;
  c.innerHTML=html;

  $('btn-pick-dir')?.addEventListener('click',pickDirectory);
  $('btn-add-files')?.addEventListener('click',addFiles);
  c.querySelectorAll('.bib-album').forEach(el=>el.addEventListener('click',()=>{
    albumDetailIdx=+el.dataset.i;
    activeTab='albums';
    document.querySelectorAll('.bnav-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab==='albums'));
    renderAlbumDetail(albumDetailIdx);
  }));
}

// ─── Albums ──────────────────────────────────────────────────
function renderAlbums(){
  const c=$('content');
  let html=`<div class="lib-header"><span class="lib-title">Albumes</span><span class="lib-count">${library.length}</span></div>`;
  html+='<div class="albums-grid">';
  html+=library.map((a,i)=>`
    <div class="album-card" data-i="${i}">
      <img class="album-cover" src="${a.coverUrl||placeholder()}" alt="" loading="lazy">
      <div class="album-name">${esc(a.title)}</div>
      <div class="album-artist">${esc(a.artist)}</div>
    </div>`).join('');
  html+='</div>';
  c.innerHTML=html;
  c.querySelectorAll('.album-card').forEach(el=>el.addEventListener('click',()=>{
    albumDetailIdx=+el.dataset.i;
    renderAlbumDetail(albumDetailIdx);
  }));
}

function renderAlbumDetail(idx){
  const a=library[idx]; if(!a) return;
  const c=$('content');
  const info=[a.artist,a.year,a.genre,`${a.tracks.length} pistas`].filter(Boolean).join(' · ');
  let html=`<button class="btn-back-album" id="btn-back-albums"><i class="ph ph-caret-left"></i> Albumes</button>`;
  html+=`<div class="ad-hero">
    <img class="ad-cover" src="${a.coverUrl||placeholder()}" alt="">
    <div class="ad-meta"><div class="ad-title">${esc(a.title)}</div><div class="ad-artist">${esc(a.artist)}</div><div class="ad-info">${esc(info)}</div>
      <div class="ad-actions"><button class="btn-play-all" id="btn-play-album"><i class="ph-fill ph-play"></i> Reproducir</button></div>
    </div></div>`;
  html+=a.tracks.map((t,ti)=>trackRow(t,ti,idx,ti,true)).join('');
  c.innerHTML=html;
  $('btn-back-albums')?.addEventListener('click',()=>{albumDetailIdx=-1;renderAlbums()});
  $('btn-play-album')?.addEventListener('click',()=>{curAlbumIdx=idx;buildPlaylist(idx,0);playTrack(idx,0)});
  bindTrackClicks(c);
  bindFavClicks(c);
}

// ─── Songs (Canciones) ──────────────────────────────────────
function renderSongs(){
  const c=$('content');
  const allTracks=[];
  library.forEach((a,ai)=>a.tracks.forEach((t,ti)=>allTracks.push({...t,_ai:ai,_ti:ti,_album:a})));

  let sorted=[...allTracks];
  if(songsFilter==='favorites'){
    sorted=sorted.filter(t=>favorites[trackKey(t._ai,t._ti)]);
  }else if(songsFilter==='az'){
    sorted.sort((a,b)=>(a.title||'').localeCompare(b.title||''));
  }else if(songsFilter==='top'){
    sorted.sort((a,b)=>(playCounts[trackKey(b._ai,b._ti)]||0)-(playCounts[trackKey(a._ai,a._ti)]||0));
  }

  let html=`<div class="filter-bar">
    <button class="filter-chip ${songsFilter==='all'?'active':''}" data-f="all"><i class="ph ph-list"></i> Todas</button>
    <button class="filter-chip ${songsFilter==='favorites'?'active':''}" data-f="favorites"><i class="ph ph-heart"></i> Favoritos</button>
    <button class="filter-chip ${songsFilter==='az'?'active':''}" data-f="az"><i class="ph ph-sort-ascending"></i> A-Z</button>
    <button class="filter-chip ${songsFilter==='top'?'active':''}" data-f="top"><i class="ph ph-fire"></i> Top</button>
  </div>`;

  html+=`<div class="lib-header"><span class="lib-title">Canciones</span><span class="lib-count">${sorted.length} pistas</span></div>`;

  if(!sorted.length){
    html+=`<div class="no-results">${songsFilter==='favorites'?'Sin favoritos aun':'Sin pistas'}</div>`;
  }else{
    html+=sorted.map((t,i)=>trackRow(t,i,t._ai,t._ti,false,true)).join('');
  }
  c.innerHTML=html;

  c.querySelectorAll('.filter-chip').forEach(el=>el.addEventListener('click',()=>{
    songsFilter=el.dataset.f;
    renderSongs();
  }));
  bindTrackClicks(c);
  bindFavClicks(c);
}

// ─── Download ────────────────────────────────────────────────
function renderDownload(){
  $('content').innerHTML=`<div class="dl-empty">
    <i class="ph ph-download-simple"></i>
    <div class="dl-title">Proximamente</div>
    <div class="dl-sub">Esta funcion estara disponible pronto</div>
  </div>`;
}

// ─── Track Row ──────────────────────────────────────────────
function trackRow(t,i,ai,ti,inAlbumDetail=false,showFav=false){
  const ms=t.duration_ms||0, m=Math.floor(ms/60000), s=Math.floor((ms%60000)/1000).toString().padStart(2,'0');
  const album=library[ai];
  const playing=ai===curAlbumIdx&&ti===curTrackIdx&&isPlaying;
  const isFav=favorites[trackKey(ai,ti)];
  const count=playCounts[trackKey(ai,ti)]||0;

  let favBtn='';
  if(showFav){
    favBtn=`<button class="t-fav ${isFav?'on':''}" data-ai="${ai}" data-ti="${ti}"><i class="ph${isFav?'-fill':''} ph-heart"></i></button>`;
  }

  return `<div class="track ${playing?'playing':''}" data-ai="${ai}" data-ti="${ti}">
    <span class="t-num">${playing?'<i class="ph-fill ph-equalizer"></i>':(i+1)}</span>
    <img class="t-art" src="${album?.coverUrl||placeholder()}" alt="" loading="lazy">
    <div class="t-info"><div class="t-name">${esc(t.title||'Sin titulo')}</div><div class="t-sub">${esc(t.artist||album?.artist||'')}${!inAlbumDetail&&album?' · '+esc(album.title):''}</div></div>
    ${favBtn}
    <span class="t-dur">${m}:${s}</span></div>`;
}

function bindTrackClicks(container){
  container.querySelectorAll('.track').forEach(el=>el.addEventListener('click',e=>{
    if(e.target.closest('.t-fav')) return;
    const ai=+el.dataset.ai, ti=+el.dataset.ti;
    curAlbumIdx=ai; curTrackIdx=ti;
    buildPlaylist(ai,ti);
    playTrack(ai,ti);
  }));
}

function bindFavClicks(container){
  container.querySelectorAll('.t-fav').forEach(el=>el.addEventListener('click',e=>{
    e.stopPropagation();
    const ai=+el.dataset.ai, ti=+el.dataset.ti;
    const key=trackKey(ai,ti);
    if(favorites[key]) delete favorites[key];
    else favorites[key]=true;
    saveFavorites();
    const icon=el.querySelector('i');
    el.classList.toggle('on');
    icon.className=favorites[key]?'ph-fill ph-heart':'ph ph-heart';
  }));
}

// ═══ Playlist ═════════════════════════════════════════════════
function buildPlaylist(ai,startTi=0){
  const a=library[ai]; if(!a) return;
  playlist=a.tracks.map((_,ti)=>({ai,ti}));
  if(shuffleOn&&playlist.length>1){
    const first=playlist.splice(startTi,1)[0];
    for(let i=playlist.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[playlist[i],playlist[j]]=[playlist[j],playlist[i]]}
    playlist.unshift(first); plPos=0;
  } else plPos=startTi;
}

function nextPos(){if(repeatMode==='one') return plPos; const n=plPos+1; return n>=playlist.length?(repeatMode==='all'?0:-1):n}
function prevPos(){const p=plPos-1; return p<0?(repeatMode==='all'?playlist.length-1:0):p}

function advance(){const n=nextPos();if(n<0){stopPlayback();return}plPos=n;const{ai,ti}=playlist[n];curAlbumIdx=ai;curTrackIdx=ti;playTrack(ai,ti)}
function goPrev(){
  const pos=isPlaying?startOff+(ctx.currentTime-startT):startOff;
  if(pos>3){seek(0);return}
  const p=prevPos();plPos=p;const{ai,ti}=playlist[p];curAlbumIdx=ai;curTrackIdx=ti;playTrack(ai,ti);
}

// ═══ Playback ═════════════════════════════════════════════════
async function playTrack(ai,ti,auto=true){
  stopSources(); cancelAnimationFrame(animId);
  curAlbumIdx=ai; curTrackIdx=ti;
  const album=library[ai], track=album.tracks[ti];

  $('np-title').textContent=track.title||'Sin titulo';
  $('np-artist').textContent=track.artist||album.artist||'—';
  $('np-img').src=album.coverUrl||'';
  document.title=`${track.title||'BitMusic'} · BitMusic`;
  highlightPlaying();

  const key=trackKey(ai,ti);
  playCounts[key]=(playCounts[key]||0)+1;
  savePlayCounts();

  if(karaokeInline) $('ki-no-track').style.display='none';

  await initAudio();
  lyrics=[]; lastLyIdx=-2;
  if(track.lrc_path){const lf=album.zipRef.file(track.lrc_path);if(lf) parseLrc(await lf.async('string'))}
  updateLyrics(-1);

  dur=0;
  const bKey=`${ai}:${ti}`;
  if(preloadKey===bKey&&preloadBufs){buffers=preloadBufs;preloadBufs=null;preloadKey=null;STEMS.forEach(s=>{if(buffers[s])dur=Math.max(dur,buffers[s].duration)})}
  else{
    buffers={};
    if(track.stems) await Promise.all(STEMS.map(async s=>{
      const p=track.stems[s];if(!p) return;const f=album.zipRef.file(p);if(!f) return;
      buffers[s]=await ctx.decodeAudioData(await f.async('arraybuffer'));dur=Math.max(dur,buffers[s].duration);
    }));
  }
  startOff=0;
  updateMediaSession(track,album);
  preloadNext();
  if(auto) startPlayback(0);
}

async function preloadNext(){
  const n=nextPos();if(n<0||repeatMode==='one') return;
  const{ai,ti}=playlist[n];const key=`${ai}:${ti}`;if(preloadKey===key) return;
  const album=library[ai],track=album?.tracks[ti];if(!track?.stems) return;
  await initAudio();
  const nb={};
  await Promise.all(STEMS.map(async s=>{const p=track.stems[s];if(!p)return;const f=album.zipRef.file(p);if(!f)return;nb[s]=await ctx.decodeAudioData(await f.async('arraybuffer'))}));
  preloadBufs=nb;preloadKey=key;
}

function startPlayback(off){
  if(!ctx) return; stopSources();
  STEMS.forEach(s=>{if(!buffers[s])return;sources[s]=ctx.createBufferSource();sources[s].buffer=buffers[s];sources[s].connect(analysers[s]);analysers[s].connect(gains[s]);sources[s].start(0,off)});
  isPlaying=true;startOff=off;startT=ctx.currentTime;
  setPlayIcon(true);
  if(navigator.mediaSession) navigator.mediaSession.playbackState='playing';
  highlightPlaying(); updateLoop();
}

function pausePlayback(){if(!isPlaying)return;stopSources();isPlaying=false;startOff+=ctx.currentTime-startT;cancelAnimationFrame(animId);setPlayIcon(false);if(navigator.mediaSession)navigator.mediaSession.playbackState='paused';highlightPlaying()}
function stopPlayback(){stopSources();isPlaying=false;startOff=0;dur=0;cancelAnimationFrame(animId);$('p-progress-fill').style.width='0';setPlayIcon(false);if(navigator.mediaSession)navigator.mediaSession.playbackState='none';document.title='BitMusic';highlightPlaying()}
function stopSources(){STEMS.forEach(s=>{if(!sources[s])return;try{sources[s].stop()}catch(e){}sources[s].disconnect();sources[s]=null})}
function togglePlay(){if(!library.length)return;if(isPlaying)pausePlayback();else startPlayback(startOff)}
async function seek(t){if(!dur)return;const w=isPlaying;if(w)pausePlayback();startOff=Math.max(0,Math.min(t,dur));updateUI(startOff);if(w){await initAudio();startPlayback(startOff)}}
function setPlayIcon(p){const i=$('btn-play')?.querySelector('i');if(i)i.className=p?'ph-fill ph-pause-circle':'ph-fill ph-play-circle'}
function highlightPlaying(){document.querySelectorAll('.track').forEach(el=>{el.classList.toggle('playing',+el.dataset.ai===curAlbumIdx&&+el.dataset.ti===curTrackIdx&&isPlaying)})}

// ═══ Update Loop ══════════════════════════════════════════════
function updateLoop(){if(!isPlaying)return;const p=startOff+(ctx.currentTime-startT);if(p>=dur&&dur>0){advance();return}updateUI(p);drawViz();drawVizInline();animId=requestAnimationFrame(updateLoop)}
function updateUI(p){
  $('p-progress-fill').style.width=`${dur>0?(p/dur)*100:0}%`;
  if(lyrics.length){
    let ai=-1;for(let i=0;i<lyrics.length;i++){if(p>=lyrics[i].time)ai=i;else break}
    updateLyrics(ai);
  }
}

// ═══ Lyrics ═══════════════════════════════════════════════════
function parseLrc(txt){lyrics=[];const re=/\[(\d{2}):(\d{2})\.(\d{2,3})\]/;txt.split('\n').forEach(l=>{const m=re.exec(l);if(!m)return;const t=+m[1]*60+ +m[2]+parseInt(m[3].length===2?m[3]+'0':m[3])/1000;const tx=l.replace(re,'').trim();if(tx)lyrics.push({time:t,text:tx})})}
function updateLyrics(idx){
  if(idx===lastLyIdx)return;
  const p=idx>0?lyrics[idx-1]?.text||'':'', cu=idx>=0?lyrics[idx]?.text||'':'', n=lyrics[idx+1]?.text||'', n2=lyrics[idx+2]?.text||'';

  // Overlay lyrics
  const lP=$('ly-prev'),lC=$('ly-cur'),lN=$('ly-next'),lN2=$('ly-next2');
  if(lP)lP.textContent=p;
  if(lC){lC.textContent=cu;if(lastLyIdx>=0&&idx>lastLyIdx){lC.classList.add('pop');setTimeout(()=>lC.classList.remove('pop'),300)}}
  if(lN)lN.textContent=n; if(lN2)lN2.textContent=n2;

  // Inline lyrics
  const lPi=$('ly-prev-i'),lCi=$('ly-cur-i'),lNi=$('ly-next-i'),lN2i=$('ly-next2-i');
  if(lPi)lPi.textContent=p;
  if(lCi){lCi.textContent=cu;if(lastLyIdx>=0&&idx>lastLyIdx){lCi.classList.add('pop');setTimeout(()=>lCi.classList.remove('pop'),300)}}
  if(lNi)lNi.textContent=n; if(lN2i)lN2i.textContent=n2;

  lastLyIdx=idx;
}

// ═══ Karaoke ══════════════════════════════════════════════════
function toggleKaraoke(show){
  karaokeOn=show!==undefined?!!show:!karaokeOn;
  $('karaoke').style.display=karaokeOn?'flex':'none';
  if(karaokeOn) resizeCanvas();
}

// ═══ MediaSession ═════════════════════════════════════════════
function setupMediaSession(){
  if(!('mediaSession' in navigator))return;const ms=navigator.mediaSession;
  ms.setActionHandler('play',()=>{if(!isPlaying)startPlayback(startOff)});
  ms.setActionHandler('pause',()=>{if(isPlaying)pausePlayback()});
  ms.setActionHandler('nexttrack',()=>advance());
  ms.setActionHandler('previoustrack',()=>goPrev());
  ms.setActionHandler('seekto',d=>seek(d.seekTime));
}
function updateMediaSession(t,a){
  if(!('mediaSession' in navigator))return;
  navigator.mediaSession.metadata=new MediaMetadata({title:t.title||'',artist:t.artist||a.artist||'',album:a.title||'',artwork:a.coverUrl?[{src:a.coverUrl}]:[]});
}

// ═══ Shuffle / Repeat ═════════════════════════════════════════
function toggleShuffle(){shuffleOn=!shuffleOn;$('btn-shuffle')?.classList.toggle('on',shuffleOn);if(curAlbumIdx>=0)buildPlaylist(curAlbumIdx,curTrackIdx)}
function toggleRepeat(){const m=['none','all','one'];repeatMode=m[(m.indexOf(repeatMode)+1)%m.length];const b=$('btn-repeat');if(!b)return;b.classList.toggle('on',repeatMode!=='none');b.querySelector('i').className=repeatMode==='one'?'ph ph-repeat-once':'ph ph-repeat'}

// ═══ Utilities ════════════════════════════════════════════════
function fmt(s){return`${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`}
function esc(s){const d=document.createElement('div');d.textContent=s||'';return d.innerHTML}
function placeholder(){return"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3Crect fill='%23181820' width='1' height='1'/%3E%3C/svg%3E"}

// ═══ Events ═══════════════════════════════════════════════════
function setup(){
  $('btn-back')?.addEventListener('click',async()=>{
    if(typeof ToolBridge!=='undefined'&&ToolBridge.isShellMode()){try{await ToolBridge.closeFrontend();return}catch(e){}}
    try{history.back()}catch(e){try{window.close()}catch(e2){}}
  });

  $('btn-add')?.addEventListener('click',addFiles);
  $('file-input')?.addEventListener('change',handleFileInput);

  document.querySelectorAll('.bnav-tab').forEach(t=>t.addEventListener('click',()=>switchTab(t.dataset.tab)));

  $('btn-play')?.addEventListener('click',togglePlay);
  $('btn-next')?.addEventListener('click',advance);
  $('btn-prev')?.addEventListener('click',goPrev);

  const pb=$('p-progress-bar');
  if(pb){
    const doSeek=x=>{if(!dur)return;const r=pb.getBoundingClientRect();seek(Math.max(0,Math.min(1,(x-r.left)/r.width))*dur)};
    pb.addEventListener('mousedown',e=>{doSeek(e.clientX);const mv=e=>doSeek(e.clientX),up=()=>{document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up)};document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up)});
    pb.addEventListener('touchstart',e=>doSeek(e.touches[0].clientX),{passive:true});
  }

  // Karaoke overlay (from player bar button)
  $('btn-karaoke')?.addEventListener('click',()=>toggleKaraoke(true));
  $('btn-exit-k')?.addEventListener('click',()=>toggleKaraoke(false));
  $('btn-mixer-k')?.addEventListener('click',()=>$('mixer')?.classList.toggle('open'));
  $('btn-mixer-inline')?.addEventListener('click',()=>$('mixer')?.classList.toggle('open'));
  $('btn-close-mixer')?.addEventListener('click',()=>$('mixer')?.classList.remove('open'));

  // Mixer sliders
  ['master','drums','bass','other','vocals'].forEach(k=>{
    const sl=$(`vol-${k}`);if(!sl)return;
    sl.addEventListener('input',e=>{
      const v=parseFloat(e.target.value);if(!ctx)return;
      if(k==='master'){vol=v;if(masterGain)masterGain.gain.setTargetAtTime(v,ctx.currentTime,0.01)}
      else if(gains[k])gains[k].gain.setTargetAtTime(v,ctx.currentTime,0.05);
    });
  });

  // Keyboard
  document.addEventListener('keydown',e=>{
    if(e.target.tagName==='INPUT')return;
    switch(e.code){
      case'Space':e.preventDefault();togglePlay();break;
      case'ArrowRight':seek((isPlaying?startOff+(ctx.currentTime-startT):startOff)+10);break;
      case'ArrowLeft':seek(Math.max(0,(isPlaying?startOff+(ctx.currentTime-startT):startOff)-10));break;
      case'KeyK':toggleKaraoke();break;
    }
  });

  window.addEventListener('resize',()=>{resizeCanvas();resizeInlineCanvas()});
}

// ═══ WebGL Visualizer ═════════════════════════════════════════
const VS=`#version 300 es
precision highp float;in vec2 a_position;out vec2 v_uv;void main(){v_uv=a_position*.5+.5;gl_Position=vec4(a_position,0,1);}`;
const FS=`#version 300 es
precision highp float;in vec2 v_uv;out vec4 fc;
uniform float u_time;uniform vec2 u_res;uniform float u_mi;
uniform vec4 u_d,u_b,u_o,u_v;uniform float u_dp,u_bp;
vec3 mod289(vec3 x){return x-floor(x/289.)*289.;}vec2 mod289(vec2 x){return x-floor(x/289.)*289.;}
vec3 perm(vec3 x){return mod289(((x*34.)+1.)*x);}
float sn(vec2 v){const vec4 C=vec4(.2113,.3660,-.5774,.0244);vec2 i=floor(v+dot(v,C.yy));vec2 x0=v-i+dot(i,C.xx);vec2 i1=x0.x>x0.y?vec2(1,0):vec2(0,1);vec4 x12=x0.xyxy+C.xxzz;x12.xy-=i1;i=mod289(i);vec3 p=perm(perm(i.y+vec3(0,i1.y,1))+i.x+vec3(0,i1.x,1));vec3 m=max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.);m=m*m*m*m;vec3 x=2.*fract(p*C.www)-1.;vec3 h=abs(x)-.5;vec3 ox=floor(x+.5);vec3 a0=x-ox;m*=1.7928-.8537*(a0*a0+h*h);vec3 g;g.x=a0.x*x0.x+h.x*x0.y;g.yz=a0.yz*x12.xz+h.yz*x12.yw;return 130.*dot(m,g);}
float bl(vec2 u,vec2 c,float r){float d=length(u-c);return exp(-d*d/(r*r));}
vec2 bp(float t,float s,float sp,float rn){return vec2(sn(vec2(t*sp+s,s*2.))*rn,sn(vec2(s*3.,t*sp+s))*rn);}
void main(){vec2 uv=v_uv;float asp=u_res.x/u_res.y;vec2 p=uv-.5;p.x*=asp;float t=u_time,r=length(p);float tot=u_d.x+u_b.x+u_o.x+u_v.x;if(tot<.001){fc=vec4(0,0,0,1);return;}
vec3 dc=vec3(.133,.867,.4),bc=vec3(.267,.8,1),oc=vec3(.667,.333,1),vc=vec3(1,.733,.2);
float ef=smoothstep(.5,.27,r);vec3 f=vec3(0);float tg=0.;
if(u_d.x>.01){float i=u_d.x,bs=.12+i*.08;float g=(bl(p,vec2(-.15,-.1)+bp(t,1.,.3,.12)*(.5+i),bs*1.2)+bl(p,vec2(.18,.15)+bp(t,1.5,.25,.1)*(.5+i),bs*.9)*.8+bl(p,vec2(-.08,.2)+bp(t,1.8,.35,.08)*(.5+i),bs*.7)*.6)*i*(1.+u_dp*.5);f+=dc*g*1.2;tg+=g;}
if(u_b.x>.01){float i=u_b.x,bs=.15+i*.1;float g=(bl(p,vec2(0,-.12)+bp(t,2.,.15,.15)*(.4+i),bs*1.4)+bl(p,vec2(-.2,.08)+bp(t,2.3,.12,.12)*(.4+i),bs)*.9+bl(p,vec2(.15,.1)+bp(t,2.6,.18,.1)*(.4+i),bs*.85)*.7)*i*(1.+u_bp*.4);f+=bc*g*1.1;tg+=g;}
if(u_o.x>.01){float i=u_o.x,bs=.11+i*.07;float g=(bl(p,vec2(.12,-.15)+bp(t,3.,.28,.11)*(.5+i),bs*1.1)+bl(p,vec2(-.18,-.05)+bp(t,3.4,.22,.09)*(.5+i),bs*.9)*.85+bl(p,vec2(.05,.18)+bp(t,3.7,.3,.1)*(.5+i),bs*.75)*.65)*i;f+=oc*g*1.15;tg+=g;}
if(u_v.x>.01){float i=u_v.x,bs=.13+i*.08;float g=(bl(p,vec2(0,.05)+bp(t,4.,.2,.1)*(.4+i),bs*1.3)+bl(p,vec2(-.12,-.18)+bp(t,4.3,.25,.12)*(.5+i),bs*.95)*.8+bl(p,vec2(.2,0)+bp(t,4.6,.18,.08)*(.5+i),bs*.8)*.65)*i;f+=vc*g*1.2;tg+=g;}
float mx=max(max(f.r,f.g),f.b);if(mx>1.)f=f/mx*.95+f*.05;
vec3 ac=(dc*u_d.x+bc*u_b.x+oc*u_o.x+vc*u_v.x)/max(tot,.001);f+=ac*tg*.045;
f*=(.7+u_mi*.6)*ef*max(1.-pow(r*1.5,2.5)*.2,.5);
vec3 gr=vec3(dot(f,vec3(.299,.587,.114)));f=mix(gr,f,1.3);
float di=(fract(sin(dot(uv*u_res,vec2(12.9898,78.233)))*43758.5453)-.5)/128.;
fc=vec4(clamp(f+di,0.,1.),1.);}`;

function compSh(glCtx,type,src){const s=glCtx.createShader(type);glCtx.shaderSource(s,src);glCtx.compileShader(s);if(!glCtx.getShaderParameter(s,glCtx.COMPILE_STATUS)){console.error(glCtx.getShaderInfoLog(s));return null}return s}

// Overlay GL
function initGL(){
  const cv=$('karaoke-canvas');if(!cv)return;
  gl=cv.getContext('webgl2')||cv.getContext('webgl');if(!gl)return;
  const vs=compSh(gl,gl.VERTEX_SHADER,VS),fs=compSh(gl,gl.FRAGMENT_SHADER,FS);if(!vs||!fs)return;
  prog=gl.createProgram();gl.attachShader(prog,vs);gl.attachShader(prog,fs);gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog,gl.LINK_STATUS)){console.error(gl.getProgramInfoLog(prog));return}
  qBuf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,qBuf);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
  pLoc=gl.getAttribLocation(prog,'a_position');
  ['u_time','u_res','u_mi','u_d','u_b','u_o','u_v','u_dp','u_bp'].forEach(u=>uL[u]=gl.getUniformLocation(prog,u));
}

// Inline GL
function initGLInline(){
  const cv=$('karaoke-canvas-inline');if(!cv)return;
  glI=cv.getContext('webgl2')||cv.getContext('webgl');if(!glI)return;
  const vs=compSh(glI,glI.VERTEX_SHADER,VS),fs=compSh(glI,glI.FRAGMENT_SHADER,FS);if(!vs||!fs)return;
  progI=glI.createProgram();glI.attachShader(progI,vs);glI.attachShader(progI,fs);glI.linkProgram(progI);
  if(!glI.getProgramParameter(progI,glI.LINK_STATUS)){console.error(glI.getProgramInfoLog(progI));return}
  qBufI=glI.createBuffer();glI.bindBuffer(glI.ARRAY_BUFFER,qBufI);glI.bufferData(glI.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),glI.STATIC_DRAW);
  pLocI=glI.getAttribLocation(progI,'a_position');
  ['u_time','u_res','u_mi','u_d','u_b','u_o','u_v','u_dp','u_bp'].forEach(u=>uLI[u]=glI.getUniformLocation(progI,u));
}

function resizeCanvas(){
  const cv=$('karaoke-canvas');if(!cv||!gl)return;
  const dpr=window.devicePixelRatio||1;
  cv.style.width=window.innerWidth+'px';cv.style.height=window.innerHeight+'px';
  cv.width=Math.round(window.innerWidth*dpr*.5);cv.height=Math.round(window.innerHeight*dpr*.5);
  gl.viewport(0,0,cv.width,cv.height);
}

function resizeInlineCanvas(){
  const cv=$('karaoke-canvas-inline');if(!cv)return;
  if(!glI){initGLInline();if(!glI)return;}
  const container=$('karaoke-inline');if(!container)return;
  const dpr=window.devicePixelRatio||1;
  const w=container.clientWidth, h=container.clientHeight;
  cv.style.width=w+'px';cv.style.height=h+'px';
  cv.width=Math.round(w*dpr*.5);cv.height=Math.round(h*dpr*.5);
  glI.viewport(0,0,cv.width,cv.height);
}

function drawViz(){
  if(!karaokeOn||!gl||!prog)return;
  if(!vizT0)vizT0=performance.now();
  const t=(performance.now()-vizT0)/1000;
  gl.useProgram(prog);gl.uniform1f(uL.u_time,t);gl.uniform2f(uL.u_res,$('karaoke-canvas').width,$('karaoke-canvas').height);
  const f=STEMS.map(s=>getFeatures(s));
  gl.uniform1f(uL.u_mi,(f[0].rms+f[1].rms+f[2].rms+f[3].rms)/4);
  gl.uniform4f(uL.u_d,f[0].rms,f[0].low,f[0].mid,f[0].high);
  gl.uniform4f(uL.u_b,f[1].rms,f[1].low,f[1].mid,f[1].high);
  gl.uniform4f(uL.u_o,f[2].rms,f[2].low,f[2].mid,f[2].high);
  gl.uniform4f(uL.u_v,f[3].rms,f[3].low,f[3].mid,f[3].high);
  gl.uniform1f(uL.u_dp,f[0].peak?f[0].peakValue:0);gl.uniform1f(uL.u_bp,f[1].peak?f[1].peakValue:0);
  gl.bindBuffer(gl.ARRAY_BUFFER,qBuf);gl.enableVertexAttribArray(pLoc);gl.vertexAttribPointer(pLoc,2,gl.FLOAT,false,0,0);
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
}

function drawVizInline(){
  if(!karaokeInline||!glI||!progI)return;
  if(!vizT0)vizT0=performance.now();
  const t=(performance.now()-vizT0)/1000;
  glI.useProgram(progI);glI.uniform1f(uLI.u_time,t);glI.uniform2f(uLI.u_res,$('karaoke-canvas-inline').width,$('karaoke-canvas-inline').height);
  const f=STEMS.map(s=>getFeatures(s));
  glI.uniform1f(uLI.u_mi,(f[0].rms+f[1].rms+f[2].rms+f[3].rms)/4);
  glI.uniform4f(uLI.u_d,f[0].rms,f[0].low,f[0].mid,f[0].high);
  glI.uniform4f(uLI.u_b,f[1].rms,f[1].low,f[1].mid,f[1].high);
  glI.uniform4f(uLI.u_o,f[2].rms,f[2].low,f[2].mid,f[2].high);
  glI.uniform4f(uLI.u_v,f[3].rms,f[3].low,f[3].mid,f[3].high);
  glI.uniform1f(uLI.u_dp,f[0].peak?f[0].peakValue:0);glI.uniform1f(uLI.u_bp,f[1].peak?f[1].peakValue:0);
  glI.bindBuffer(glI.ARRAY_BUFFER,qBufI);glI.enableVertexAttribArray(pLocI);glI.vertexAttribPointer(pLocI,2,glI.FLOAT,false,0,0);
  glI.drawArrays(glI.TRIANGLE_STRIP,0,4);
}

// ═══ Init ═════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded',async()=>{
  try{if(typeof ToolBridge!=='undefined')await ToolBridge.handshake()}catch(e){}
  await loadPersistedData();
  setup();
  setupMediaSession();
  initGL();
  initGLInline();
  resizeCanvas();
  renderTab();
});

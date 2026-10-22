const state = {
  data: null,
  progress: loadProgress(),
  user: null,
  supabase: null,
  accountMessage: '',
  filters: { topic: '全部知识板块', mastery: '全部掌握状态', search: '', ratings: { difficulty: false, importance: false, exam_probability: false } }
};
const masteryOptions = ['尚未评估', '我没有完全看懂', '我看懂了但无法复述', '我可以复述', '我完全掌握了'];
const revealLabels = [['problem', '题目'], ['hint', '大致思路'], ['framework', '思维推进框架'], ['solution', '完整答案'], ['reflection', '反思收获']];

function loadProgress() {
  try { return JSON.parse(localStorage.getItem('math-analysis-progress') || '{}'); }
  catch (_) { return {}; }
}
function progressStorageKey(user = state.user) {
  return user?.id ? `math-analysis-progress:${user.id}` : 'math-analysis-progress';
}
function loadScopedProgress(user = state.user) {
  try { return JSON.parse(localStorage.getItem(progressStorageKey(user)) || '{}'); }
  catch (_) { return {}; }
}
function masteryOf(q) { return state.progress[q.id] || q.default_mastery; }
function saveMastery(id, value) {
  state.progress[id] = value;
  try { localStorage.setItem(progressStorageKey(), JSON.stringify(state.progress)); }
  catch (_) { /* private browsing may disable storage; keep this session usable */ }
  if(state.supabase && state.user) {
    state.supabase.from('user_progress').upsert({user_id:state.user.id,question_id:id,mastery:value,updated_at:new Date().toISOString()},{onConflict:'user_id,question_id'})
      .then(({error})=>{ if(error) console.error('云端进度保存失败',error); });
  }
}
async function loadCloudProgress() {
  if(!state.supabase || !state.user) return;
  const userId=state.user.id;
  const {data,error}=await state.supabase.from('user_progress').select('question_id,mastery').eq('user_id',userId);
  if(error) { state.accountMessage='云端进度读取失败：'+error.message; return; }
  if(state.user?.id!==userId) return;
  state.progress=Object.fromEntries((data||[]).map(row=>[row.question_id,row.mastery]));
  try { localStorage.setItem(progressStorageKey(state.user),JSON.stringify(state.progress)); } catch (_) {}
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function md(value) {
  let s = escapeHtml(value);
  s = s.replace(/^### (.+)$/gm, '<h4>$1</h4>').replace(/^## (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>.*<\/li>\n?)+/g, m => '<ul>'+m+'</ul>');
  s = s.replace(/^\s*\d+\.\s+(.+)$/gm, '<li>$1</li>');
  const tick=String.fromCharCode(96);
  s = s.replace(new RegExp(tick+'([^'+tick+']+)'+tick,'g'), '<code>$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, '<div class="math-box">$1</div>').replace(/\$([^$\n]+)\$/g, '<span class="math-inline">$1</span>');
  return s.split(/\n{2,}/).map(block => /^<(h[34]|ul|div)/.test(block.trim()) ? block : '<p>'+block.replace(/\n/g,'<br>')+'</p>').join('');
}
function stars(n) { return '<span class="stars" aria-label="'+n+'颗星">'+'★'.repeat(n)+'☆'.repeat(5-n)+'</span>'; }
function ratingRows(p) { const r=p.ratings; return '<div class="rating-row"><span>难度</span>'+stars(r.difficulty)+'</div><div class="rating-row"><span>重要性</span>'+stars(r.importance)+'</div><div class="rating-row"><span>复现概率（暂定）</span>'+stars(r.exam_probability)+'</div>'; }
function topicRoots() { return ['全部知识板块', ...new Set(state.data.questions.flatMap(q => q.knowledge.map(k => k.split('/')[0])))]; }
function questionSummary(q) { return q.sections.problem.replace(/[$#*_]/g,'').replace(/\s+/g,' ').slice(0,150); }
function compactSearch(value) {
  return String(value ?? '').toLowerCase().replace(/[\s，。、“”‘’：:；;、/\\_\-]+/g, '');
}
function searchAliases(q) {
  return [
    q.id,
    'w'+String(q.week).padStart(2,'0')+'q'+String(q.question_number).padStart(2,'0'),
    '第'+q.week+'周第'+q.question_number+'题',
    '第'+q.week+'周 第'+q.question_number+'题',
    q.week+'-'+q.question_number,
    q.week+'/'+q.question_number
  ];
}
function matchesSearch(q, query) {
  const needle=compactSearch(query);
  if(!needle) return true;
  const haystack=compactSearch([q.title, q.search_text, ...q.knowledge, ...q.tags, ...searchAliases(q)].join(' '));
  return haystack.includes(needle);
}
function matches(q) {
  const f=state.filters;
  return (f.topic==='全部知识板块'||q.knowledge.some(k=>k.startsWith(f.topic+'/'))) &&
    (f.mastery==='全部掌握状态'||masteryOf(q)===f.mastery) &&
    matchesSearch(q, f.search) &&
    (!f.ratings.difficulty||q.ratings.difficulty<=3) &&
    (!f.ratings.importance||q.ratings.importance>=4) &&
    (!f.ratings.exam_probability||q.ratings.exam_probability>=4);
}
function problemCard(q) {
  return '<article class="problem-card card"><a class="problem-link" href="#problem/'+q.id+'"><div class="problem-title">第'+q.week+'周 · 第'+q.question_number+'题 · '+escapeHtml(q.title)+'</div><div class="problem-summary">'+escapeHtml(questionSummary(q))+'</div><div class="problem-meta"><span class="week-tag">第'+q.week+'周</span>'+q.knowledge.slice(0,2).map(k=>'<span class="tag">'+escapeHtml(k.split('/').at(-1))+'</span>').join('')+'<span class="mastery-tag">'+escapeHtml(masteryOf(q))+'</span></div></a><div class="rating-stack"><div>难度 '+stars(q.ratings.difficulty)+'</div><div>重要性 '+stars(q.ratings.importance)+'</div><div>复现 '+stars(q.ratings.exam_probability)+'</div></div></article>';
}
function header(title, subtitle) { return '<div class="eyebrow">数学分析 · 个人题库</div><h1>'+title+'</h1><p class="hero-copy p">'+subtitle+'</p>'; }
function homeView() {
  const qs=state.data.questions, featured=qs.find(q=>q.id==='w02-q11')||qs[0], mastered=qs.filter(q=>masteryOf(q)==='我完全掌握了').length, assessed=qs.filter(q=>masteryOf(q)!=='尚未评估').length, progress=Math.round(mastered/qs.length*100);
  return '<div id="home"><section class="hero"><div class="hero-copy">'+header('把每一道题，变成自己的工具。','完整题库已接入：按知识、掌握程度和三维星级复习。')+'</div><div class="progress-card"><div class="progress-top"><span>题库进度</span><span>'+assessed+'/'+qs.length+' 已标记</span></div><div class="progress-number">'+progress+'% 完全掌握</div><div class="progress-track"><div class="progress-fill" style="width:'+progress+'%"></div></div></div></section><section class="section"><div class="section-head"><div><h2>继续学习</h2><p>从一道完整题目开始</p></div><a class="small-button" href="#library">查看全部题目 →</a></div><div class="continue-grid"><a class="continue-card featured card" href="#problem/'+featured.id+'"><div><div class="card-meta"><span>第'+featured.week+'周 · 第'+featured.question_number+'题</span><span>推荐</span></div><div class="card-title">'+escapeHtml(featured.title)+'</div><div class="card-description">'+escapeHtml(questionSummary(featured))+'</div></div><div class="card-bottom"><span class="status-pill">'+escapeHtml(masteryOf(featured))+'</span><span class="mini-arrow">↗</span></div></a></div></section><section class="section"><div class="section-head"><div><h2>从这里开始</h2><p>四种进入方式</p></div></div><div class="tool-grid"><a class="tool-card card" href="#random"><div class="tool-icon">⌁</div><h3>从这里开始</h3><p>从前三级掌握状态中随机抽一道题。</p></a><a class="tool-card card" href="#library"><div class="tool-icon">⌘</div><h3>按知识找题</h3><p>按三级知识路径查找完整题目。</p></a><a class="tool-card card" href="#library?ratings=need"><div class="tool-icon">↻</div><h3>按需要练习</h3><p>按掌握程度与三维星级筛选。</p></a><a class="tool-card card" href="#review"><div class="tool-icon">✦</div><h3>我的复习</h3><p>集中查看前两级掌握状态的题目。</p></a></div></section><section class="section"><div class="card" style="padding:20px"><div class="library-top"><span class="week-tag">已接入</span><span class="muted" style="font-size:13px">'+qs.length+' 道题 · '+state.data.knowledge_index.length+' 条三级知识路径</span></div></div></section></div>';
}
function libraryView() {
  const shown=state.data.questions.filter(matches), topics=topicRoots();
  return '<div id="library">'+header('题库','每一道题都来自内容库，详情页按题目、思路、框架、答案、反思逐层展开。')+'<div class="library-layout section"><aside class="filters card"><h3>筛选题目</h3><div class="filter-group"><label class="filter-label">知识板块</label><select id="topic-filter" class="filter-select">'+topics.map(o=>'<option '+(o===state.filters.topic?'selected':'')+'>'+escapeHtml(o)+'</option>').join('')+'</select></div><div class="filter-group"><label class="filter-label">掌握程度</label><select id="mastery-filter" class="filter-select"><option>全部掌握状态</option>'+masteryOptions.map(o=>'<option '+(o===state.filters.mastery?'selected':'')+'>'+o+'</option>').join('')+'</select></div><div class="filter-group"><span class="filter-label">三维评级</span><label class="check-item"><input type="checkbox" data-rating="importance" '+(state.filters.ratings.importance?'checked':'')+'> 重要性 ≥ 4 星</label><label class="check-item"><input type="checkbox" data-rating="exam_probability" '+(state.filters.ratings.exam_probability?'checked':'')+'> 复现概率 ≥ 4 星</label><label class="check-item"><input type="checkbox" data-rating="difficulty" '+(state.filters.ratings.difficulty?'checked':'')+'> 难度 ≤ 3 星</label></div></aside><section><div class="library-top"><input id="search-input" class="search-input" aria-label="搜索题库" placeholder="如：第1周第2题、ε-N、极限定义" value="'+escapeHtml(state.filters.search)+'"><span class="result-count">显示 '+shown.length+' / '+state.data.questions.length+' 道题</span></div><div id="problem-results" class="problem-list">'+(shown.length?shown.map(problemCard).join(''):'<div class="card empty-state">没有符合筛选条件的题目。<br><br><button class="small-button" id="clear-filters">清除筛选</button></div>')+'</div></section></div></div>';
}
function updateLibraryResults() {
  const list=document.getElementById('problem-results');
  const count=document.querySelector('.result-count');
  if(!list||!count) return;
  const shown=state.data.questions.filter(matches);
  list.innerHTML=shown.length?shown.map(problemCard).join(''):'<div class="card empty-state">没有符合筛选条件的题目。<br><br><button class="small-button" id="clear-filters">清除筛选</button></div>';
  count.textContent='显示 '+shown.length+' / '+state.data.questions.length+' 道题';
  document.getElementById('clear-filters')?.addEventListener('click',()=>{state.filters={topic:'全部知识板块',mastery:'全部掌握状态',search:'',ratings:{difficulty:false,importance:false,exam_probability:false}};render()});
}
function detailView(id) {
  const q=state.data.questions.find(x=>x.id===id)||state.data.questions[0];
  const body=revealLabels.map(([key,label],i)=>'<details class="reveal" '+(i===0?'open':'')+'><summary><span class="reveal-index">0'+(i+1)+'</span>'+label+'</summary><div class="reveal-body markdown">'+md(q.sections[key])+'</div></details>').join('');
  return '<div id="detail"><a class="back" href="#library">← 返回题库</a><div class="detail-header"><div class="detail-main"><div class="eyebrow">第'+q.week+'周 · 第'+q.question_number+'题 · '+escapeHtml(q.knowledge[0].split('/')[0])+'</div><h1 class="detail-title">'+escapeHtml(q.title)+'</h1><p class="detail-subtitle">'+escapeHtml(questionSummary(q))+'</p><div class="detail-tags">'+q.tags.map(t=>'<span class="tag">'+escapeHtml(t)+'</span>').join('')+'</div></div><aside class="detail-ratings card">'+ratingRows(q)+'</aside></div><div class="study-layout"><section class="study-column">'+body+'</section><aside><div class="side-card card"><h3>我的状态</h3><select class="mastery-select" id="detail-mastery">'+masteryOptions.map(o=>'<option '+(o===masteryOf(q)?'selected':'')+'>'+o+'</option>').join('')+'</select><div class="save-note">状态已按题目保存到本机浏览器。</div></div><div class="side-card card"><h3>知识点位置</h3>'+q.knowledge.map(k=>'<div class="side-row"><span>'+escapeHtml(k)+'</span></div>').join('')+'</div><div class="side-card card"><h3>来源与核对</h3><div class="side-row"><span>资料</span><b>'+escapeHtml(q.sources.join('；'))+'</b></div><div class="side-row"><span>页码</span><b>'+escapeHtml(q.source_pages)+'</b></div></div></aside></div></div>';
}
function reviewView() {
  const qs=state.data.questions.filter(q=>masteryOf(q)==='我没有完全看懂'||masteryOf(q)==='我看懂了但无法复述');
  return '<div>'+header('我的复习','只显示掌握程度停留在前两级的题目。')+'<section class="section"><div class="problem-list">'+(qs.length?qs.map(problemCard).join(''):'<div class="card empty-state">当前没有前两级掌握状态的题目。</div>')+'</div></section></div>';
}
function accountView() {
  const user=state.user;
  if(user) return '<div>'+header('账号与同步','当前登录：'+escapeHtml(user.email||'')+'。掌握状态会同步到你的 Supabase 账号。')+'<section class="section card account-card"><p>'+escapeHtml(state.accountMessage||'云端进度同步已连接。')+'</p><button class="small-button" id="sign-out">退出登录</button></section></div>';
  return '<div>'+header('登录与同步','登录后，你标记的掌握程度会保存到云端，并可在其他设备继续复习。')+'<section class="section card account-card"><form id="auth-form"><label for="auth-email">邮箱</label><input id="auth-email" type="email" autocomplete="email" required placeholder="name@example.com"><label for="auth-password">密码</label><input id="auth-password" type="password" autocomplete="current-password" minlength="6" required placeholder="至少 6 位"><div class="account-actions"><button class="small-button primary-button" type="submit" data-auth-action="signin">登录</button><button class="small-button" type="button" id="sign-up">创建账号</button><button class="text-button" type="button" id="reset-password">忘记密码</button></div></form><p class="account-message" id="account-message">'+escapeHtml(state.accountMessage||'')+'</p></section></div>';
}
function bindAccount() {
  const form=document.getElementById('auth-form');
  const message=document.getElementById('account-message');
  const say=text=>{state.accountMessage=text;if(message)message.textContent=text};
  document.getElementById('sign-out')?.addEventListener('click',async()=>{const {error}=await state.supabase.auth.signOut();if(error)say(error.message);else{state.user=null;state.accountMessage='已退出登录。';render()}});
  if(!form) return;
  const email=()=>document.getElementById('auth-email').value.trim();
  const password=()=>document.getElementById('auth-password').value;
  form.addEventListener('submit',async e=>{e.preventDefault();say('正在登录…');const {error}=await state.supabase.auth.signInWithPassword({email:email(),password:password()});say(error?'登录失败：'+error.message:'登录成功，正在同步进度…')});
  document.getElementById('sign-up').onclick=async()=>{say('正在创建账号…');const {data,error}=await state.supabase.auth.signUp({email:email(),password:password(),options:{emailRedirectTo:location.origin+location.pathname+'#account'}});say(error?'注册失败：'+error.message:(data.session?'账号已创建并登录。':'注册请求已提交。请查收邮箱并点击确认链接，再返回本网站登录。'))};
  document.getElementById('reset-password').onclick=async()=>{if(!email()){say('请先填写邮箱，再点击忘记密码。');return}const {error}=await state.supabase.auth.resetPasswordForEmail(email(),{redirectTo:location.origin+location.pathname+'#account'});say(error?'发送失败：'+error.message:'如果该邮箱已注册，密码重置邮件很快会送达。')};
}
function bindLibrary() {
  document.getElementById('topic-filter').onchange=e=>{state.filters.topic=e.target.value;render()};
  document.getElementById('mastery-filter').onchange=e=>{state.filters.mastery=e.target.value;render()};
  const input=document.getElementById('search-input');
  input.oninput=e=>{state.filters.search=e.target.value;updateLibraryResults()};
  input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();state.filters.search=input.value.trim();updateLibraryResults()}};
  document.querySelectorAll('[data-rating]').forEach(el=>el.onchange=e=>{state.filters.ratings[e.target.dataset.rating]=e.target.checked;render()});
  document.getElementById('clear-filters')?.addEventListener('click',()=>{state.filters={topic:'全部知识板块',mastery:'全部掌握状态',search:'',ratings:{difficulty:false,importance:false,exam_probability:false}};render()});
}
function bindDetail() {
  const select=document.getElementById('detail-mastery');
  if(!select) return;
  const id=location.hash.slice(1).split('?')[0].slice(8);
  select.onchange=e=>{ saveMastery(id,e.target.value); };
}
function openSearch() {
  if(!location.hash.startsWith('#library')) location.hash='#library';
  const focus=()=>document.getElementById('search-input')?.focus();
  focus();
  setTimeout(focus,50);
}
document.addEventListener('click',e=>{
  if(e.target.closest('#search-trigger')) { e.preventDefault(); openSearch(); }
  if(e.target.closest('#account-trigger')) { e.preventDefault(); location.hash='#account'; }
});
function updateNav(route) {
  const section=route.startsWith('problem/') ? 'library' : (route || 'home');
  document.querySelectorAll('[data-nav]').forEach(link=>{
    const active=link.dataset.nav===section;
    link.classList.toggle('active',active);
    if(active) link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  });
}
function render() {
  if(!state.data){document.getElementById('app').innerHTML='<div class="section"><div class="card" style="padding:24px">正在加载完整题库…</div></div>';return}
  const raw=location.hash.slice(1)||'home', [route,query]=raw.split('?');
  updateNav(route);
  if(route==='library' && query){
    const params=new URLSearchParams(query);
    if(params.has('search')) state.filters.search=params.get('search')||'';
    if(params.has('mastery')) state.filters.mastery=params.get('mastery')||'全部掌握状态';
  }
  if(route==='random'){const c=state.data.questions.filter(q=>masteryOf(q)!=='我完全掌握了');location.hash='problem/'+c[Math.floor(Math.random()*c.length)].id;return}
  if(route.startsWith('problem/')){document.getElementById('app').innerHTML=detailView(route.slice(8));bindDetail()}
  else if(route==='library'){if(query?.includes('ratings=need'))state.filters.ratings={difficulty:false,importance:true,exam_probability:true};document.getElementById('app').innerHTML=libraryView();bindLibrary()}
  else if(route==='review')document.getElementById('app').innerHTML=reviewView();
  else if(route==='account'){document.getElementById('app').innerHTML=accountView();bindAccount()}
  else document.getElementById('app').innerHTML=homeView();
  window.scrollTo({top:0,behavior:'instant'});
}
window.addEventListener('hashchange',render);
if(window.supabase?.createClient && window.SUPABASE_CONFIG?.url && window.SUPABASE_CONFIG?.publishableKey) {
  state.supabase=window.supabase.createClient(window.SUPABASE_CONFIG.url,window.SUPABASE_CONFIG.publishableKey);
  state.supabase.auth.getSession().then(async({data,error})=>{
    if(error) console.error('登录状态读取失败',error);
    state.user=data?.session?.user||null;
    state.progress=loadScopedProgress();
    await loadCloudProgress();
    render();
  });
  state.supabase.auth.onAuthStateChange((_event,session)=>{
    state.user=session?.user||null;
    state.progress=loadScopedProgress();
    if(state.user) state.accountMessage='已登录，正在同步进度…';
    render();
    if(state.user) setTimeout(()=>loadCloudProgress().then(()=>{state.accountMessage='云端进度同步完成。';render()}),0);
  });
} else {
  state.accountMessage='登录服务未初始化。请检查 supabase-config.js 是否配置正确，以及网络能否加载 Supabase 客户端。';
}
fetch('library.json').then(r=>{if(!r.ok)throw Error('题库文件加载失败');return r.json()}).then(data=>{state.data=data;render()}).catch(err=>{document.getElementById('app').innerHTML='<div class="section"><div class="card" style="padding:24px">无法加载内容库。请确认 library.json 与 index.html 位于同一目录，或通过本地服务器打开此网页；不要直接使用 file://。</div></div>';console.error(err)});

